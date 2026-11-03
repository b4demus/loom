//! Offline render: the same engine, driven without an audio device (export, tests).

use crate::engine::{Engine, Mode, Shared, Song};
use crate::plugin::Processor;
use std::path::Path;
use std::sync::Arc;

pub struct Rendered {
    pub l: Vec<f32>,
    pub r: Vec<f32>,
    pub sr: f32,
}

/// One pass over the loop of `mode` (a pattern or the whole playlist), then the tails
/// ring out after a stop, up to `tail_sec`.
pub fn render(song: Box<Song>, mode: Mode, sr: f32, tail_sec: f32) -> Rendered {
    render_with(song, mode, sr, tail_sec, vec![]).0
}

/// Like `render`, with plugin processors in their slots; they come back afterwards so the
/// caller can free them where their plugins want (the UI thread).
pub fn render_with(mut song: Box<Song>, mode: Mode, sr: f32, tail_sec: f32, plugins: Vec<(u32, Box<dyn Processor>)>) -> (Rendered, Vec<Box<dyn Processor>>) {
    // Export remains the whole arrangement, regardless of the editing loop selection.
    song.loop_region = None;
    song.pat_loop = None;
    let mut e = Engine::new(sr, song, Arc::new(Shared::default()));
    let ids: Vec<u32> = plugins.iter().map(|p| p.0).collect();
    for (id, p) in plugins {
        e.add_plugin(id, p);
    }
    e.set_mode(mode);
    let (ls, le) = e.loop_range();
    let frames = ((le - ls) / e.ticks_per_frame()).floor() as usize;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    e.play();
    e.process(&mut l, &mut r);
    e.stop();
    let block = 1024;
    let max_tail = (tail_sec * sr) as usize;
    let (mut bl, mut br) = (vec![0.0; block], vec![0.0; block]);
    let mut quiet = 0;
    let mut done = 0;
    while done < max_tail && quiet < (sr * 0.25) as usize {
        e.process(&mut bl, &mut br);
        l.extend_from_slice(&bl);
        r.extend_from_slice(&br);
        done += block;
        let peak = bl.iter().chain(br.iter()).fold(0f32, |m, x| m.max(x.abs()));
        if peak < 1e-4 && e.active_voices() == 0 {
            quiet += block;
        } else {
            quiet = 0;
        }
    }
    let back = ids.into_iter().filter_map(|id| e.remove_plugin(id)).collect();
    (Rendered { l, r, sr }, back)
}

/// 24-bit PCM WAV
pub fn write_wav(path: &Path, out: &Rendered) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: out.sr as u32, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    let scale = 8_388_607.0f32;
    for (a, b) in out.l.iter().zip(&out.r) {
        w.write_sample((a.clamp(-1.0, 1.0) * scale) as i32).map_err(|e| e.to_string())?;
        w.write_sample((b.clamp(-1.0, 1.0) * scale) as i32).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}
