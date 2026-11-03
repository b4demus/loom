//! Standard MIDI files: the notes of every track read in (formats 0 and 1), and a pattern written
//! out (format 1, a track per channel). Written from the public SMF layout: a header chunk, then
//! track chunks of delta-timed events, running status allowed.

use loom_engine::project::PPQ;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MidiNote {
    /// start and length in loom ticks, key, velocity 0..1
    pub t: u32,
    pub l: u32,
    pub k: u8,
    pub v: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct MidiTrack {
    pub name: String,
    /// the MIDI channel its notes are on (9 is General MIDI drums)
    pub channel: u8,
    /// the last program change, if any
    pub program: Option<u8>,
    pub notes: Vec<MidiNote>,
}

#[derive(Serialize, Debug)]
pub struct MidiFile {
    /// the first tempo in the file
    pub bpm: Option<f64>,
    /// only tracks with notes; a track playing on several channels comes as one per channel
    pub tracks: Vec<MidiTrack>,
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.i).ok_or("the MIDI file ends too early")?;
        self.i += 1;
        Ok(v)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.i..self.i + n).ok_or("the MIDI file ends too early")?;
        self.i += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, String> {
        let s = self.bytes(4)?;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    /// a variable-length quantity: 7 bits a byte, the top bit says more follow
    fn vlq(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            let b = self.u8()?;
            v = (v << 7) | (b & 0x7f) as u32;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("bad variable-length number in the MIDI file".into())
    }
}

/// Reads the notes of a Standard MIDI File.
pub fn read(bytes: &[u8]) -> Result<MidiFile, String> {
    let mut r = Reader { b: bytes, i: 0 };
    if r.bytes(4)? != b"MThd" {
        return Err("not a MIDI file".into());
    }
    let hlen = r.u32()? as usize;
    let hdr = r.bytes(hlen)?;
    if hdr.len() < 6 {
        return Err("not a MIDI file".into());
    }
    let ntracks = u16::from_be_bytes([hdr[2], hdr[3]]);
    let division = u16::from_be_bytes([hdr[4], hdr[5]]);
    if division & 0x8000 != 0 || division == 0 {
        return Err("MIDI files timed in SMPTE frames are not supported".into());
    }
    let div = division as u64;
    let to_loom = |tick: u64| ((tick * PPQ as u64 + div / 2) / div) as u32;
    let mut bpm = None;
    let mut out: Vec<MidiTrack> = vec![];
    for _ in 0..ntracks {
        // chunks other than tracks are skipped
        loop {
            if r.i >= r.b.len() {
                break;
            }
            let id = r.bytes(4)?;
            let len = r.u32()? as usize;
            if id == b"MTrk" {
                let data = r.bytes(len.min(r.b.len() - r.i))?;
                read_track(data, &mut bpm, &mut out, &to_loom)?;
                break;
            }
            r.bytes(len.min(r.b.len() - r.i))?;
        }
    }
    out.retain(|t| !t.notes.is_empty());
    for t in out.iter_mut() {
        t.notes.sort_by_key(|n| (n.t, n.k));
    }
    Ok(MidiFile { bpm, tracks: out })
}

fn read_track(data: &[u8], bpm: &mut Option<f64>, out: &mut Vec<MidiTrack>, to_loom: &dyn Fn(u64) -> u32) -> Result<(), String> {
    let mut r = Reader { b: data, i: 0 };
    let mut tick: u64 = 0;
    let mut status: u8 = 0;
    let mut name = String::new();
    // per channel: its notes, the notes sounding (key → start tick, velocity) and its program
    let mut chans: Vec<(u8, Vec<MidiNote>, Vec<(u8, u64, f32)>, Option<u8>)> = vec![];
    let first = out.len();
    let chan = |chans: &mut Vec<(u8, Vec<MidiNote>, Vec<(u8, u64, f32)>, Option<u8>)>, c: u8| -> usize {
        match chans.iter().position(|x| x.0 == c) {
            Some(i) => i,
            None => { chans.push((c, vec![], vec![], None)); chans.len() - 1 }
        }
    };
    let close = |ch: &mut (u8, Vec<MidiNote>, Vec<(u8, u64, f32)>, Option<u8>), key: u8, at: u64| {
        // the earliest note still sounding on that key ends here
        if let Some(i) = ch.2.iter().position(|o| o.0 == key) {
            let (k, start, v) = ch.2.remove(i);
            let t = to_loom(start);
            ch.1.push(MidiNote { t, l: to_loom(at).saturating_sub(t).max(1), k, v });
        }
    };
    while r.i < r.b.len() {
        tick += r.vlq()? as u64;
        let mut b = r.u8()?;
        if b < 0x80 {
            // running status: the byte read is the first data byte
            if status == 0 {
                return Err("bad MIDI track (data without a status)".into());
            }
            r.i -= 1;
            b = status;
        }
        match b {
            0xFF => {
                let kind = r.u8()?;
                let len = r.vlq()? as usize;
                let d = r.bytes(len)?;
                match kind {
                    0x03 if name.is_empty() => name = String::from_utf8_lossy(d).trim().to_string(),
                    0x51 if d.len() == 3 && bpm.is_none() => {
                        let us = ((d[0] as u32) << 16) | ((d[1] as u32) << 8) | d[2] as u32;
                        if us > 0 { *bpm = Some(60_000_000.0 / us as f64); }
                    }
                    0x2F => break,
                    _ => {}
                }
            }
            0xF0 | 0xF7 => {
                let len = r.vlq()? as usize;
                r.bytes(len)?;
            }
            0x80..=0xEF => {
                status = b;
                let c = b & 0x0f;
                match b & 0xf0 {
                    0x80 | 0x90 => {
                        let (key, vel) = (r.u8()? & 0x7f, r.u8()? & 0x7f);
                        let i = chan(&mut chans, c);
                        if b & 0xf0 == 0x90 && vel > 0 {
                            chans[i].2.push((key, tick, vel as f32 / 127.0));
                        } else {
                            close(&mut chans[i], key, tick);
                        }
                    }
                    0xC0 => { let p = r.u8()?; let i = chan(&mut chans, c); chans[i].3 = Some(p & 0x7f); }
                    0xD0 => { r.u8()?; }
                    _ => { r.u8()?; r.u8()?; }
                }
            }
            _ => return Err(format!("unknown MIDI event {b:#x}")),
        }
    }
    // notes left sounding end with the track
    for ch in chans.iter_mut() {
        let open: Vec<u8> = ch.2.iter().map(|o| o.0).collect();
        for k in open {
            close(ch, k, tick);
        }
    }
    let several = chans.iter().filter(|c| !c.1.is_empty()).count() > 1;
    // a track with no name is called by its place in the file
    let label = if name.is_empty() { format!("MIDI {}", first + 1) } else { name.clone() };
    for (c, notes, _, program) in chans {
        let name = if several { format!("{label} · ch {}", c + 1) } else { label.clone() };
        out.push(MidiTrack { name, channel: c, program, notes });
    }
    Ok(())
}

/// Writes tracks of notes (loom ticks) as a format-1 MIDI file at `bpm`, one track each.
pub fn write(bpm: f64, tracks: &[(String, Vec<MidiNote>)]) -> Vec<u8> {
    fn vlq(out: &mut Vec<u8>, mut v: u32) {
        let mut buf = [0u8; 5];
        let mut i = 4;
        buf[i] = (v & 0x7f) as u8;
        v >>= 7;
        while v > 0 {
            i -= 1;
            buf[i] = (v & 0x7f) as u8 | 0x80;
            v >>= 7;
        }
        out.extend_from_slice(&buf[i..]);
    }
    fn chunk(out: &mut Vec<u8>, id: &[u8], body: &[u8]) {
        out.extend_from_slice(id);
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
    }
    let mut out = vec![];
    let mut hdr = vec![0, 1];
    hdr.extend_from_slice(&((tracks.len() + 1) as u16).to_be_bytes());
    hdr.extend_from_slice(&(PPQ as u16).to_be_bytes());
    chunk(&mut out, b"MThd", &hdr);
    // the tempo and a 4/4 bar on a track of their own
    let us = (60_000_000.0 / bpm.clamp(10.0, 999.0)).round() as u32;
    let mut t0 = vec![0, 0xFF, 0x51, 3, (us >> 16) as u8, (us >> 8) as u8, us as u8, 0, 0xFF, 0x58, 4, 4, 2, 24, 8];
    t0.extend_from_slice(&[0, 0xFF, 0x2F, 0]);
    chunk(&mut out, b"MTrk", &t0);
    for (idx, (name, notes)) in tracks.iter().enumerate() {
        // GM drums sit on channel 10: the others take the channels around it
        let c = { let c = (idx % 15) as u8; if c >= 9 { c + 1 } else { c } };
        let mut ev: Vec<(u32, bool, u8, u8)> = vec![];
        for n in notes {
            let v = ((n.v.clamp(0.0, 1.0) * 127.0).round() as u8).max(1);
            ev.push((n.t, true, n.k.min(127), v));
            ev.push((n.t + n.l.max(1), false, n.k.min(127), 0));
        }
        // at one tick the endings come before the beginnings
        ev.sort_by_key(|e| (e.0, e.1));
        let mut body = vec![];
        let nm = name.as_bytes();
        body.push(0);
        body.extend_from_slice(&[0xFF, 0x03]);
        vlq(&mut body, nm.len() as u32);
        body.extend_from_slice(nm);
        let mut last = 0;
        for (t, on, k, v) in ev {
            vlq(&mut body, t - last);
            last = t;
            body.extend_from_slice(&[if on { 0x90 } else { 0x80 } | c, k, v]);
        }
        body.extend_from_slice(&[0, 0xFF, 0x2F, 0]);
        chunk(&mut out, b"MTrk", &body);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(t: u32, l: u32, k: u8, v: f32) -> MidiNote {
        MidiNote { t, l, k, v }
    }

    #[test]
    fn a_written_pattern_reads_back_the_same() {
        let tracks = vec![
            ("lead".to_string(), vec![n(0, 96, 60, 100.0 / 127.0), n(96, 48, 64, 64.0 / 127.0), n(96, 48, 67, 1.0)]),
            ("bass".to_string(), vec![n(0, 384, 36, 1.0)]),
        ];
        let bytes = write(128.0, &tracks);
        let f = read(&bytes).unwrap();
        assert!((f.bpm.unwrap() - 128.0).abs() < 0.01);
        assert_eq!(f.tracks.len(), 2);
        assert_eq!(f.tracks[0].name, "lead");
        assert_eq!(f.tracks[0].notes, tracks[0].1);
        assert_eq!(f.tracks[1].notes, tracks[1].1);
    }

    #[test]
    fn running_status_zero_velocity_offs_and_other_resolutions() {
        // format 0, 480 ticks a beat; note-ons with running status, a note-on at 0 ends a note,
        // two channels in one track come as two tracks
        let mut trk = vec![];
        trk.extend_from_slice(&[0x00, 0x90, 60, 100]); // C4 on, ch 1
        trk.extend_from_slice(&[0x00, 64, 90]); //         E4 on (running status)
        trk.extend_from_slice(&[0x83, 0x60, 60, 0]); //   480 later: C4 off (velocity 0)
        trk.extend_from_slice(&[0x00, 0x99, 36, 127]); //  kick on, ch 10
        trk.extend_from_slice(&[0x83, 0x60, 0x80, 64, 0]); // 480 later: E4 off
        trk.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);
        let mut f = b"MThd\0\0\0\x06\0\0\0\x01\x01\xe0".to_vec();
        f.extend_from_slice(b"MTrk");
        f.extend_from_slice(&(trk.len() as u32).to_be_bytes());
        f.extend_from_slice(&trk);
        let m = read(&f).unwrap();
        assert_eq!(m.tracks.len(), 2);
        let ch1 = m.tracks.iter().find(|t| t.channel == 0).unwrap();
        assert_eq!(ch1.notes, vec![n(0, 96, 60, 100.0 / 127.0), n(0, 192, 64, 90.0 / 127.0)]);
        // the kick never ends: it lasts to the end of the track
        let drums = m.tracks.iter().find(|t| t.channel == 9).unwrap();
        assert_eq!(drums.notes, vec![n(96, 96, 36, 1.0)]);
    }

    #[test]
    fn what_is_not_a_midi_file_says_so() {
        assert!(read(b"RIFF....").is_err());
        assert!(read(b"MThd\0\0\0\x06\0\0\0\x01\xe7\x28").unwrap_err().contains("SMPTE"));
    }

    /// LOOM_MIDI_DIR=<folder> cargo test -p loom midi_folder -- --ignored --nocapture
    #[test]
    #[ignore = "reads the MIDI files of a folder given in LOOM_MIDI_DIR"]
    fn midi_folder() {
        let dir = std::env::var("LOOM_MIDI_DIR").expect("LOOM_MIDI_DIR");
        let mut stack = vec![std::path::PathBuf::from(dir)];
        let (mut ok, mut notes) = (0, 0);
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); continue; }
                if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("mid")) { continue; }
                let f = read(&std::fs::read(&p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
                ok += 1;
                notes += f.tracks.iter().map(|t| t.notes.len()).sum::<usize>();
                if ok <= 3 { eprintln!("{}: bpm {:?}, tracks {:?}", p.display(), f.bpm, f.tracks.iter().map(|t| (t.name.clone(), t.channel, t.notes.len())).collect::<Vec<_>>()); }
            }
        }
        eprintln!("read {ok} files, {notes} notes");
        assert!(ok > 0);
    }
}