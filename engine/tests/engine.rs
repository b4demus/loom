use loom_engine::plugin::{MidiEv, Processor, TimeInfo};
use loom_engine::project::*;
use loom_engine::render::{render, write_wav};
use loom_engine::{Engine, Mode, Project, SampleCache, Shared};
use std::sync::Arc;

const SR: f32 = 48000.0;

fn kick_channel(id: u32) -> Channel {
    Channel { id, name: "kick".into(), inst: Inst::Sampler(SamplerParams::default()), ..Default::default() }
}

/// a rim on every beat: short enough that each hit has died before the next one
fn four_on_floor() -> Project {
    let notes = (0..4).map(|b| Note { t: b * PPQ, l: STEP, k: 60, v: 1.0, p: 0.0, s: false }).collect();
    let rim = SamplerParams { sample: "kit:rim".into(), ..Default::default() };
    Project {
        bpm: 120.0,
        channels: vec![Channel { id: 1, inst: Inst::Sampler(rim), ..Default::default() }],
        patterns: vec![Pattern { id: 1, name: "p".into(), bars: 1, notes: [(1, notes)].into() }],
        ..Default::default()
    }
}

/// first frame at or after `from` whose level crosses `thr`
fn onset(x: &[f32], from: usize, thr: f32) -> Option<usize> {
    (from..x.len()).find(|&i| x[i].abs() > thr)
}

#[test]
fn kicks_land_on_the_beat() {
    let p = four_on_floor();
    let song = SampleCache::default().build(&p);
    let out = render(Box::new(song), Mode::Pattern(1), SR, 0.5);
    let beat = (60.0 / 120.0 * SR) as usize; // 24000 frames
    for b in 0..4 {
        let at = onset(&out.l, (b * beat).saturating_sub(10), 0.01).unwrap();
        assert!(at.abs_diff(b * beat) <= 2, "beat {b}: onset at {at}, expected {}", b * beat);
    }
    let peak = out.l.iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(peak > 0.3 && peak <= 1.0, "peak {peak}");
}

#[test]
fn pattern_loop_replays_the_first_step() {
    let p = four_on_floor();
    let song = SampleCache::default().build(&p);
    let mut e = Engine::new(SR, Box::new(song), Arc::new(Shared::default()));
    e.set_mode(Mode::Pattern(1));
    e.play();
    let bar = (2.0 * SR) as usize; // one 4/4 bar at 120 bpm
    let total = bar * 3;
    let mut out = vec![0.0; total];
    let mut scratch = vec![0.0; 333];
    // odd block size: loop ends never align with blocks
    for chunk in out.chunks_mut(333) {
        let n = chunk.len();
        e.process(chunk, &mut scratch[..n]);
    }
    for k in 0..3 {
        let at = onset(&out, (k * bar).saturating_sub(10), 0.01).unwrap();
        assert!(at.abs_diff(k * bar) <= 2, "loop {k}: onset at {at}");
    }
}

#[test]
fn song_mode_follows_clips() {
    let mut p = four_on_floor();
    p.tracks = vec![Track::default()];
    // the pattern starts on bar 2
    p.clips = vec![Clip { p: 1, track: 0, t: BAR, l: BAR, ..Default::default() }];
    let song = SampleCache::default().build(&p);
    let out = render(Box::new(song), Mode::Song, SR, 0.0);
    let bar = (2.0 * SR) as usize;
    assert!(out.l[..bar - 10].iter().all(|x| x.abs() < 1e-6), "bar 1 should be silent");
    let at = onset(&out.l, bar - 10, 0.01).unwrap();
    assert!(at.abs_diff(bar) <= 2, "bar 2 onset at {at}");
    // muting the track silences it
    p.tracks[0].mute = true;
    let song = SampleCache::default().build(&p);
    let out = render(Box::new(song), Mode::Song, SR, 0.0);
    assert!(out.l.iter().all(|x| x.abs() < 1e-6));
}

#[test]
fn song_stop_and_replay_return_to_the_selected_start_even_in_empty_space() {
    let p = four_on_floor();
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Song);
    let start = (BAR * 20 + PPQ) as f64;
    e.set_pos(start);
    let (mut l, mut r) = ([0.0; 333], [0.0; 333]);
    for _ in 0..2 {
        e.play(); e.process(&mut l, &mut r);
        assert!(e.position() > start, "empty timeline must not wrap to zero");
        e.stop(); assert_eq!(e.position(), start);
    }
}

#[test]
fn selected_song_region_loops_sample_accurately_and_ignores_pattern_playback() {
    let mut p = four_on_floor();
    p.tracks = vec![Track::default()];
    p.clips = vec![Clip { p: 1, track: 0, t: 0, l: BAR, ..Default::default() }];
    p.loop_region = Some(LoopRegion { start: PPQ, end: 2 * PPQ, enabled: true });
    let mut cache = SampleCache::default();
    let mut e = Engine::new(SR, Box::new(cache.build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Song);
    assert_eq!(e.loop_range(), (PPQ as f64, (2 * PPQ) as f64));
    e.set_pos(PPQ as f64); e.play();
    let beat = (SR * 0.5) as usize;
    let mut out = vec![0.0; beat * 3];
    let mut scratch = [0.0; 333];
    for chunk in out.chunks_mut(333) { let n = chunk.len(); e.process(chunk, &mut scratch[..n]); }
    for k in 0..3 {
        let at = onset(&out, (k * beat).saturating_sub(8), 0.01).unwrap();
        assert!(at.abs_diff(k * beat) <= 2, "loop {k}: {at}");
    }
    p.loop_region.as_mut().unwrap().enabled = false;
    e.set_song(Box::new(cache.build(&p)));
    let (mut l, mut r) = (vec![0.0; beat * 2], vec![0.0; beat * 2]);
    e.process(&mut l, &mut r);
    assert!(e.position() > (2 * PPQ) as f64, "disabled region must not constrain playback");
    p.loop_region.as_mut().unwrap().enabled = true;
    e.set_song(Box::new(cache.build(&p)));
    e.set_mode(Mode::Pattern(1));
    assert_eq!(e.loop_range(), (0.0, BAR as f64));
}

#[test]
fn a_playback_loop_does_not_crop_the_export() {
    let mut p = four_on_floor();
    p.tracks = vec![Track::default()];
    p.clips = vec![Clip { p: 1, track: 0, t: BAR, l: BAR, ..Default::default() }];
    p.loop_region = Some(LoopRegion { start: BAR, end: BAR + PPQ, enabled: true });
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    assert_eq!(out.l.len(), (SR * 4.0) as usize);
}

#[test]
fn back_to_back_notes_do_not_cut_each_other() {
    // two 16ths of the same key: the first one's note-off must not release the second
    let notes = vec![Note { t: 0, l: STEP, k: 60, v: 1.0, p: 0.0, s: false }, Note { t: STEP, l: STEP * 3, k: 60, v: 1.0, p: 0.0, s: false }];
    let mut sp = SynthParams::default();
    sp.r = 0.01;
    let p = Project {
        bpm: 120.0,
        channels: vec![Channel { id: 1, inst: Inst::Synth(sp), ..Default::default() }],
        patterns: vec![Pattern { id: 1, bars: 1, notes: [(1, notes)].into(), ..Default::default() }],
        ..Default::default()
    };
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    let step = (0.125 * SR) as usize;
    // well inside the second note: still sounding
    let mid = &out.l[step * 2..step * 2 + 2000];
    let rms = (mid.iter().map(|x| x * x).sum::<f32>() / mid.len() as f32).sqrt();
    assert!(rms > 0.02, "second note was cut: rms {rms}");
    // after both notes and the release: silent
    let late = &out.l[step * 6..step * 7];
    assert!(late.iter().all(|x| x.abs() < 1e-3));
}

#[test]
fn swapping_the_song_keeps_voices() {
    let mut sp = SynthParams::default();
    sp.r = 0.01;
    let p = Project { channels: vec![Channel { id: 7, inst: Inst::Synth(sp), ..Default::default() }], ..Default::default() };
    let mut cache = SampleCache::default();
    let mut e = Engine::new(SR, Box::new(cache.build(&p)), Arc::new(Shared::default()));
    e.note_on(7, 60, 1.0);
    let (mut l, mut r) = (vec![0.0; 512], vec![0.0; 512]);
    e.process(&mut l, &mut r);
    assert_eq!(e.active_voices(), 1);
    let mut p2 = p.clone();
    p2.channels[0].vol = 0.5;
    p2.channels.push(kick_channel(8));
    let old = e.set_song(Box::new(cache.build(&p2)));
    drop(old);
    e.process(&mut l, &mut r);
    assert_eq!(e.active_voices(), 1, "the held note survives an edit");
    e.note_off(7, 60);
    for _ in 0..20 {
        e.process(&mut l, &mut r);
    }
    assert_eq!(e.active_voices(), 0);
}

#[test]
fn every_wave_and_kit_sound_is_clean() {
    let waves = [Wave::Sine, Wave::Tri, Wave::Saw, Wave::Square, Wave::Noise];
    let mut channels = vec![];
    let mut notes = std::collections::BTreeMap::new();
    for (i, w) in waves.iter().enumerate() {
        let sp = SynthParams { osc1: *w, osc2: *w, res: 0.9, ..Default::default() };
        let id = i as u32 + 1;
        channels.push(Channel { id, inst: Inst::Synth(sp), vol: 0.3, ..Default::default() });
        notes.insert(id, vec![Note { t: 0, l: PPQ, k: 36 + 12 * i as u8, v: 1.0, p: 0.0, s: false }]);
    }
    for (i, (name, _)) in loom_engine::kit::KIT.iter().enumerate() {
        let id = 100 + i as u32;
        let sp = SamplerParams { sample: format!("kit:{name}"), ..Default::default() };
        channels.push(Channel { id, inst: Inst::Sampler(sp), vol: 0.3, ..Default::default() });
        notes.insert(id, vec![Note { t: i as u32 * STEP, l: STEP, k: 60, v: 1.0, p: 0.0, s: false }]);
    }
    let p = Project { channels, patterns: vec![Pattern { id: 1, bars: 1, notes, ..Default::default() }], ..Default::default() };
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 2.0);
    assert!(out.l.iter().chain(&out.r).all(|x| x.is_finite() && x.abs() <= 1.0));
    let rms = (out.l.iter().map(|x| x * x).sum::<f32>() / out.l.len() as f32).sqrt();
    assert!(rms > 0.01, "rms {rms}");
}

#[test]
fn audio_clips_play_in_song_mode() {
    // the kit's tom (0.5 s) on an audio channel routed to insert 1, as a clip on bar 2
    let mut p = Project { bpm: 120.0, tracks: vec![Track::default()], mixer: mixer(2), ..Default::default() };
    let tom = AudioParams { sample: "kit:tom".into(), path: None, ..Default::default() };
    p.channels = vec![Channel { id: 5, inst: Inst::Audio(tom), vol: 1.0, mix: 1, ..Default::default() }];
    p.clips = vec![Clip { track: 0, t: BAR, l: BAR, ch: 5, ..Default::default() }];
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    let bar = (2.0 * SR) as usize;
    assert!(out.l[..bar - 10].iter().all(|x| x.abs() < 1e-6), "silent before the clip");
    let at = onset(&out.l, bar - 10, 0.01).unwrap();
    assert!(at.abs_diff(bar) < 200, "the clip starts on bar 2: {at}");
    assert!(rms(&out.l[bar..bar + 12000]) > 0.05);
    // the insert it plays into can be muted
    p.mixer[1].mute = true;
    let quiet = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    assert!(quiet.l.iter().all(|x| x.abs() < 1e-6));
    // the channel's own fader and mute apply to its clips
    p.mixer[1].mute = false;
    p.channels[0].vol = 0.5;
    let half = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    let ratio = rms(&half.l[bar..bar + 12000]) / rms(&out.l[bar..bar + 12000]);
    assert!((ratio - 0.5).abs() < 0.02, "channel fader ratio {ratio}");
    p.channels[0].mute = true;
    let muted = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    assert!(muted.l.iter().all(|x| x.abs() < 1e-6));
    p.channels[0].mute = false;
    p.channels[0].vol = 1.0;
    // starting in the middle of the clip plays from there, not from the clip's start
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Song);
    e.set_pos((BAR + PPQ / 2) as f64); // 0.25 s into the tom
    e.play();
    let mid = run(&mut e, 2400);
    let full = render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0);
    let from = bar + 12000;
    let err = mid[200..2400].iter().zip(&full.l[from + 200..from + 2400]).fold(0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(err < 1e-3, "offset playback differs by {err}");
}

#[test]
fn metronome_clicks_on_the_beats() {
    let p = Project { bpm: 120.0, patterns: vec![Pattern { id: 1, bars: 1, ..Default::default() }], ..Default::default() };
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Pattern(1));
    e.play();
    let silent = run(&mut e, 48000);
    assert!(silent.iter().all(|x| x.abs() < 1e-6), "off: nothing");
    e.stop();
    e.set_metronome(true);
    e.play();
    let out = run(&mut e, 2 * 96000 + 100);
    let beat = 24000usize;
    let mut peaks = vec![];
    for b in 0..8usize {
        let at = onset(&out, (b * beat).saturating_sub(10), 0.01).unwrap();
        assert!(at.abs_diff(b * beat) <= 2, "beat {b}: click at {at}");
        peaks.push(out[at..at + 400].iter().fold(0f32, |m, x| m.max(x.abs())));
    }
    // the first beat of each bar is the loud one
    assert!(peaks[0] > peaks[1] * 1.3 && peaks[4] > peaks[5] * 1.3, "accents {peaks:?}");
}

#[test]
fn count_in_clicks_then_starts() {
    // the rim on every beat; one bar of count-in with the metronome off
    let p = four_on_floor();
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Pattern(1));
    let c0 = e.clock();
    e.play_count_in(1);
    let out = run(&mut e, 96000 + 30000);
    let bar = 96000usize;
    // four clicks during the count-in, and the transport has not moved
    for b in 0..4usize {
        let at = onset(&out, (b * 24000).saturating_sub(10), 0.01).unwrap();
        assert!(at.abs_diff(b * 24000) <= 2, "count-in beat {b} at {at}");
    }
    // the first note lands right after it, and the start is reported at that frame
    let at = onset(&out, bar - 10, 0.01).unwrap();
    assert!(at.abs_diff(bar) <= 2, "first note at {at}");
    assert_eq!(e.take_started().map(|s| s - c0), Some(bar as u64));
    assert!(e.take_started().is_none(), "reported once");
}

/// a sound card whose input 1 holds 0.5 and input 2 holds 0.25
struct Dc;
impl loom_engine::plugin::InputSource for Dc {
    fn read(&mut self, in1: &mut [f32], in2: &mut [f32]) -> bool {
        in1.fill(0.5);
        in2.fill(0.25);
        true
    }
}

#[test]
fn mixer_tracks_hear_their_input() {
    let mut p = Project { mixer: mixer(3), ..Default::default() };
    p.mixer[0].vol = 1.0;
    let lr = |p: &Project| {
        let mut e = Engine::new(SR, Box::new(SampleCache::default().build(p)), Arc::new(Shared::default()));
        e.set_input(Some(Box::new(Dc)));
        let (mut l, mut r) = (vec![0.0; 2048], vec![0.0; 2048]);
        e.process(&mut l, &mut r);
        (l[2000], r[2000])
    };
    assert_eq!(lr(&p), (0.0, 0.0), "no track listens: silence");
    p.mixer[1].input = 1;
    let (l, r) = lr(&p);
    assert!((l - 0.5).abs() < 1e-4 && (r - 0.5).abs() < 1e-4, "input 1 on both sides: {l} {r}");
    p.mixer[1].input = 3;
    let (l, r) = lr(&p);
    assert!((l - 0.5).abs() < 1e-4 && (r - 0.25).abs() < 1e-4, "stereo 1+2: {l} {r}");
    // through the track's fader, and gone when the track is muted
    p.mixer[1].vol = 0.5;
    let (l, _) = lr(&p);
    assert!((l - 0.25).abs() < 1e-4, "fader: {l}");
    p.mixer[1].mute = true;
    assert_eq!(lr(&p), (0.0, 0.0));
}

#[test]
fn mixer_routes_a_later_input_without_reading_the_device_twice() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Inputs(Arc<AtomicUsize>, [f32; 512], [f32; 512]);
    impl loom_engine::plugin::InputSource for Inputs {
        fn read(&mut self, a: &mut [f32], b: &mut [f32]) -> bool { self.0.fetch_add(1, Ordering::Relaxed); a.fill(0.1); b.fill(0.2); true }
        fn channel(&self, index: usize) -> Option<&[f32]> { match index { 2 => Some(&self.1), 3 => Some(&self.2), _ => None } }
    }
    let count = Arc::new(AtomicUsize::new(0));
    let mut p = Project { mixer: mixer(3), ..Default::default() };
    p.mixer[1].input = 18; // input 3, mono
    p.mixer[2].input = 1026; // inputs 3+4, stereo
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_input(Some(Box::new(Inputs(count.clone(), [0.3; 512], [0.4; 512]))));
    let (mut l, mut r) = ([0.0; 512], [0.0; 512]);
    e.process(&mut l, &mut r);
    assert_eq!(count.load(Ordering::Relaxed), 1);
    assert!((l[511] - 0.6).abs() < 1e-5);
    assert!((r[511] - 0.7).abs() < 1e-5);
}

fn mixer(n: usize) -> Vec<MixTrack> {
    (0..n).map(|_| MixTrack { vol: 1.0, ..Default::default() }).collect()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

#[test]
fn channels_route_through_mixer_tracks() {
    let mut p = four_on_floor();
    p.mixer = mixer(3);
    p.channels[0].mix = 2;
    let loud = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    assert!(rms(&loud.l) > 0.005);
    // muting the insert the channel plays into silences it
    p.mixer[2].mute = true;
    let quiet = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    assert!(quiet.l.iter().all(|x| x.abs() < 1e-6));
    // soloing another insert does too; the master itself is never muted by solo
    p.mixer[2].mute = false;
    p.mixer[1].solo = true;
    let solo = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    assert!(solo.l.iter().all(|x| x.abs() < 1e-6));
}

/// an effect that scales its input
struct Gain(f32);
impl Processor for Gain {
    fn process(&mut self, inp: [&[f32]; 2], out: [&mut [f32]; 2], _: &[MidiEv], _: &TimeInfo) {
        let [ol, or] = out;
        for i in 0..ol.len() {
            ol[i] = inp[0][i] * self.0;
            or[i] = inp[1][i] * self.0;
        }
    }
}

fn run(e: &mut Engine, frames: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames];
    let mut r = vec![0.0; 300];
    for chunk in out.chunks_mut(300) {
        let n = chunk.len();
        e.process(chunk, &mut r[..n]);
    }
    out
}

#[test]
fn effect_slots_process_the_track() {
    let mut p = four_on_floor();
    p.mixer = mixer(2);
    p.channels[0].mix = 1;
    p.mixer[1].fx = vec![FxSlot { pid: 3, on: true, mix: 1.0 }];
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Pattern(1));
    e.play();
    // no processor in slot 3 yet: the slot passes the signal through
    let dry = run(&mut e, 4000);
    assert!(rms(&dry) > 0.005);
    assert!(e.add_plugin(3, Box::new(Gain(0.0))).is_none());
    e.stop();
    e.play();
    let wet = run(&mut e, 4000);
    assert!(wet.iter().all(|x| x.abs() < 1e-6), "a muting effect silences the insert");
    // half dry/wet with a muting effect is half the level
    let old = e.remove_plugin(3);
    assert!(old.is_some());
    e.add_plugin(3, Box::new(Gain(0.0)));
    let mut p2 = p.clone();
    p2.mixer[1].fx[0].mix = 0.5;
    drop(e.set_song(Box::new(SampleCache::default().build(&p2))));
    e.stop();
    e.play();
    let half = run(&mut e, 4000);
    let ratio = rms(&half) / rms(&dry);
    assert!((ratio - 0.5).abs() < 0.05, "ratio {ratio}");
}

/// an instrument that records the notes it gets and outputs a DC level while a note is held
struct Recorder(std::sync::Arc<std::sync::Mutex<Vec<(u64, u8, bool)>>>, u64, bool);
impl Processor for Recorder {
    fn process(&mut self, _: [&[f32]; 2], out: [&mut [f32]; 2], events: &[MidiEv], _: &TimeInfo) {
        for ev in events {
            self.0.lock().unwrap().push((self.1 + ev.frame as u64, ev.key, ev.on));
            self.2 = ev.on;
        }
        let [l, r] = out;
        l.fill(if self.2 { 0.5 } else { 0.0 });
        r.fill(if self.2 { 0.5 } else { 0.0 });
        self.1 += l.len() as u64;
    }
}

#[test]
fn plugin_instruments_get_sample_accurate_notes() {
    let notes = vec![Note { t: 0, l: STEP, k: 60, v: 1.0, p: 0.0, s: false }, Note { t: PPQ, l: STEP, k: 64, v: 1.0, p: 0.0, s: false }];
    let p = Project {
        bpm: 120.0,
        channels: vec![Channel { id: 1, inst: Inst::Plugin(PluginInst { pid: 7 }), ..Default::default() }],
        patterns: vec![Pattern { id: 1, bars: 1, notes: [(1, notes)].into(), ..Default::default() }],
        ..Default::default()
    };
    let log = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.add_plugin(7, Box::new(Recorder(log.clone(), 0, false)));
    e.set_mode(Mode::Pattern(1));
    e.play();
    let out = run(&mut e, 30000);
    let got = log.lock().unwrap().clone();
    let beat = 24000u64;
    let step = 6000u64;
    // ticks accumulate in floating point: a note exactly on a block edge may land one frame early
    let want = [(0, 60, true), (step, 60, false), (beat, 64, true), (beat + step, 64, false)];
    assert_eq!(got.len(), want.len(), "events {got:?}");
    for (g, w) in got.iter().zip(want) {
        assert!(g.0.abs_diff(w.0) <= 1 && g.1 == w.1 && g.2 == w.2, "events {got:?}");
    }
    assert!(out[100] > 0.1 && out[step as usize + 100].abs() < 1e-6);
}

/// the recorder writes 32-bit float WAV (mono or stereo); the decoder must read it back
#[test]
fn float_wav_takes_decode() {
    let dir = std::env::temp_dir().join("loom-test");
    std::fs::create_dir_all(&dir).unwrap();
    for ch in [1u16, 2] {
        let path = dir.join(format!("take{ch}.wav"));
        let spec = hound::WavSpec { channels: ch, sample_rate: 48000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..4800 {
            for c in 0..ch {
                w.write_sample(((i as f32 * 0.05).sin() * 0.5) * if c == 0 { 1.0 } else { -1.0 }).unwrap();
            }
        }
        w.finalize().unwrap();
        let b = loom_engine::decode::load(&path).unwrap();
        assert_eq!(b.len(), 4800);
        assert_eq!(b.sr, 48000.0);
        assert!((b.l[100] - (5.0f32).sin() * 0.5).abs() < 1e-6);
        if ch == 2 {
            assert!((b.r[100] + b.l[100]).abs() < 1e-6);
        }
    }
}

#[test]
fn wav_export_round_trips() {
    let p = four_on_floor();
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.2);
    let dir = std::env::temp_dir().join("loom-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("kick.wav");
    write_wav(&path, &out).unwrap();
    let back = loom_engine::decode::load(&path).unwrap();
    assert_eq!(back.len(), out.l.len());
    assert_eq!(back.sr, SR);
    let err = back.l.iter().zip(&out.l).fold(0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(err < 1e-5, "24-bit error {err}");
}

/// input 1 (0.5) through insert 1, master at unity: what comes out is 0.5 × the insert's gain
fn dc_through_insert(automation: Vec<AutoLane>) -> Engine {
    let mut p = Project { bpm: 120.0, mixer: mixer(2), automation, ..Default::default() };
    p.mixer[1].input = 1;
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_input(Some(Box::new(Dc)));
    e
}

fn lane(target: AutoTarget, points: &[(f64, f32)]) -> AutoLane {
    AutoLane { id: 1, target, points: points.iter().map(|&(t, v)| AutoPoint { t, v, c: 0.0 }).collect(), ..Default::default() }
}

#[test]
fn the_master_is_not_limited_it_may_pass_0_db() {
    // the insert carries 0.5; an effect makes it 4× (2.0, +6 dB), which the master passes as it is
    let mut p = Project { bpm: 120.0, mixer: mixer(2), ..Default::default() };
    p.mixer[1].input = 1;
    p.mixer[1].fx = vec![FxSlot { pid: 3, on: true, mix: 1.0 }];
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    assert!(e.add_plugin(3, Box::new(Gain(4.0))).is_none());
    e.set_input(Some(Box::new(Dc)));
    let out = run(&mut e, 4800);
    assert!((out[4799] - 2.0).abs() < 1e-4, "got {}", out[4799]);
}

#[test]
fn lane_values_hold_at_the_ends_jump_and_bend() {
    let p = |t, v, c| AutoPoint { t, v, c };
    let pts = [p(100.0, 0.2, 0.0), p(200.0, 0.6, 0.0), p(200.0, 1.0, 0.0), p(300.0, 0.0, 0.0)];
    assert_eq!(lane_value(&pts, 0.0), Some(0.2));
    assert!((lane_value(&pts, 150.0).unwrap() - 0.4).abs() < 1e-6);
    assert_eq!(lane_value(&pts, 200.0), Some(1.0), "two points at one time jump");
    assert_eq!(lane_value(&pts, 999.0), Some(0.0));
    assert_eq!(lane_value(&[], 5.0), None);
    let up = [p(0.0, 0.0, 1.0), p(100.0, 1.0, 0.0)];
    let down = [p(0.0, 0.0, -1.0), p(100.0, 1.0, 0.0)];
    assert!(lane_value(&up, 50.0).unwrap() > 0.8 && lane_value(&down, 50.0).unwrap() < 0.1);
}

#[test]
fn automation_moves_a_mixer_fader_along_the_song_only() {
    // fader position 0 → 1 over the first bar (0 → 1.25 gain on the fader curve)
    let ramp = lane(AutoTarget::MixVol { track: 1 }, &[(0.0, 0.0), (BAR as f64, 1.0)]);
    let mut e = dc_through_insert(vec![ramp.clone()]);
    e.set_mode(Mode::Song);
    e.play();
    // half a bar at 120 bpm is one second
    let out = run(&mut e, SR as usize);
    let want = 0.5 * fader_vol(0.5);
    assert!((out[out.len() - 1] - want).abs() < 0.01, "mid-bar {} want {want}", out[out.len() - 1]);
    let out = run(&mut e, SR as usize + 600);
    assert!((out[out.len() - 1] - (0.5 * 1.25)).abs() < 0.01, "after the last point the value holds");
    // pattern playback leaves the fader where the project has it (1.0)
    let mut e = dc_through_insert(vec![ramp.clone()]);
    e.set_mode(Mode::Pattern(0));
    e.play();
    let out = run(&mut e, 4800);
    assert!((out[4799] - 0.5).abs() < 1e-4);
    // a lane overridden by hand does nothing
    let mut off = ramp;
    off.on = false;
    let mut e = dc_through_insert(vec![off]);
    e.set_mode(Mode::Song);
    let out = run(&mut e, 4800);
    assert!((out[4799] - 0.5).abs() < 1e-4);
}

#[test]
fn automation_reaches_plugin_parameters_only_when_they_change() {
    struct Params(Arc<std::sync::Mutex<Vec<(u32, f32)>>>);
    impl Processor for Params {
        fn process(&mut self, inp: [&[f32]; 2], out: [&mut [f32]; 2], _: &[MidiEv], _: &TimeInfo) {
            let [ol, or] = out;
            ol.copy_from_slice(inp[0]);
            or.copy_from_slice(inp[1]);
        }
        fn set_param(&mut self, id: u32, v: f32) {
            self.0.lock().unwrap().push((id, v));
        }
    }
    let got = Arc::new(std::sync::Mutex::new(vec![]));
    let mut p = Project { bpm: 120.0, mixer: mixer(2), ..Default::default() };
    p.mixer[1].fx = vec![FxSlot { pid: 3, on: true, mix: 1.0 }];
    p.automation = vec![
        lane(AutoTarget::Param { pid: 3, param: 7 }, &[(0.0, 0.0), (BAR as f64, 1.0)]),
        lane(AutoTarget::Param { pid: 3, param: 9 }, &[(0.0, 0.25)]),
    ];
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.add_plugin(3, Box::new(Params(got.clone())));
    e.set_mode(Mode::Song);
    e.play();
    run(&mut e, SR as usize);
    let got = got.lock().unwrap();
    let ramp: Vec<f32> = got.iter().filter(|x| x.0 == 7).map(|x| x.1).collect();
    assert!(ramp.len() > 50 && ramp.windows(2).all(|w| w[1] > w[0]), "a rising ramp, once per block");
    assert!((ramp[ramp.len() - 1] - 0.5).abs() < 0.01);
    assert_eq!(got.iter().filter(|x| x.0 == 9).count(), 1, "a flat lane is sent once");
}

#[test]
fn output_volume_scales_the_speakers_only() {
    let mut e = dc_through_insert(vec![]);
    e.set_output_gain(0.5);
    let out = run(&mut e, 4800);
    assert!((out[4799] - 0.25).abs() < 1e-4, "{}", out[4799]);
}

/// a 440 Hz sine, 4 s, as a file for audio clips
fn sine_file() -> String {
    // once per run: tests run in parallel and must not read it half written
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(write_sine).clone()
}

fn write_sine() -> String {
    let dir = std::env::temp_dir().join(format!("loom-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sine440.wav");
    let spec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(&path, spec).unwrap();
    for i in 0..48000 * 4 {
        w.write_sample((i as f32 / 48000.0 * 440.0 * std::f32::consts::TAU).sin() * 0.5).unwrap();
    }
    w.finalize().unwrap();
    path.to_string_lossy().into_owned()
}

/// frequency from zero crossings
fn hz(x: &[f32]) -> f32 {
    let n = x.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    n as f32 / 2.0 / (x.len() as f32 / SR)
}

fn stretched(rate: f64, l: u32, stretch_pitch: bool, mute: bool) -> Vec<f32> {
    let path = sine_file();
    let mut p = Project { bpm: 120.0, tracks: vec![Track::default()], mixer: mixer(1), ..Default::default() };
    let a = AudioParams { sample: "sine440.wav".into(), path: Some(path), stretch_pitch, ..Default::default() };
    p.channels = vec![Channel { id: 5, inst: Inst::Audio(a), vol: 1.0, ..Default::default() }];
    p.clips = vec![Clip { track: 0, t: 0, l, ch: 5, rate, mute, ..Default::default() }];
    render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0).l
}

#[test]
fn stretched_clips_keep_their_pitch_or_resample() {
    let s = SR as usize;
    // twice as fast: the 4 s sound in one bar (2 s)
    let kept = stretched(2.0, BAR, false, false);
    let f = hz(&kept[s / 4..s * 7 / 4]);
    assert!((f - 440.0).abs() < 6.0, "pitch kept: {f} Hz");
    assert!(rms(&kept[s / 4..s * 7 / 4]) > 0.3, "no holes in the stretched sound");
    let resampled = stretched(2.0, BAR, true, false);
    let f = hz(&resampled[s / 4..s * 7 / 4]);
    assert!((f - 880.0).abs() < 6.0, "resampled: {f} Hz");
    // half speed, pitch kept: two bars play the first 2 s of the sound
    let slow = stretched(0.5, 2 * BAR, false, false);
    let f = hz(&slow[s..s * 3]);
    assert!((f - 440.0).abs() < 6.0, "slowed, pitch kept: {f} Hz");
    // a muted clip says nothing
    assert!(stretched(1.0, BAR, false, true).iter().all(|x| x.abs() < 1e-6));
}

#[test]
fn mixer_tracks_route_into_groups_and_off_the_master() {
    // input 1 (0.5) on insert 1; insert 1 → insert 3 (a group at half) → master
    let mut p = Project { mixer: mixer(4), ..Default::default() };
    p.mixer[1].input = 1;
    let level = |p: &Project| {
        let mut e = Engine::new(SR, Box::new(SampleCache::default().build(p)), Arc::new(Shared::default()));
        e.set_input(Some(Box::new(Dc)));
        run(&mut e, 2048)[2000]
    };
    assert!((level(&p) - 0.5).abs() < 1e-4, "to the master by default");
    p.mixer[1].out = vec![3];
    p.mixer[3].vol = 0.5;
    assert!((level(&p) - 0.25).abs() < 1e-4, "through the group's fader");
    // off the master and nowhere else: not heard
    p.mixer[1].out = vec![];
    assert!(level(&p).abs() < 1e-6);
    // a loop (3 → 1 while 1 → 3) is cut, the sound still arrives once
    p.mixer[1].out = vec![3];
    p.mixer[3].out = vec![1, 0];
    assert!((level(&p) - 0.25).abs() < 1e-4);
    // solo on the group keeps what feeds it
    p.mixer[3].out = vec![0];
    p.mixer[3].solo = true;
    assert!((level(&p) - 0.25).abs() < 1e-4, "soloing a group keeps its sources");
    p.mixer[3].solo = false;
    p.mixer[2].solo = true;
    assert!(level(&p).abs() < 1e-6, "soloing another insert silences this chain");
}

#[test]
fn armed_tracks_hand_their_sound_to_a_recording_while_playing() {
    struct Sink(Arc<std::sync::Mutex<(Vec<f32>, Option<f64>)>>);
    impl loom_engine::plugin::TapSink for Sink {
        fn write(&mut self, l: &[f32], _r: &[f32], tick: f64) {
            let mut g = self.0.lock().unwrap();
            if g.1.is_none() { g.1 = Some(tick); }
            g.0.extend_from_slice(l);
        }
    }
    let got = Arc::new(std::sync::Mutex::new((vec![], None)));
    let mut p = Project { mixer: mixer(2), ..Default::default() };
    p.mixer[1].input = 1;
    p.mixer[1].vol = 0.5;
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_input(Some(Box::new(Dc)));
    e.set_mode(Mode::Song);
    e.set_pos(384.0);
    e.set_taps(vec![(1, Box::new(Sink(got.clone())))]);
    run(&mut e, 1200);
    assert!(got.lock().unwrap().0.is_empty(), "nothing while stopped");
    e.play();
    run(&mut e, 4800);
    let g = got.lock().unwrap();
    assert_eq!(g.0.len(), 4800);
    assert!((g.0[4000] - 0.25).abs() < 1e-4, "the track after its fader: {}", g.0[4000]);
    assert_eq!(g.1, Some(384.0), "the recording knows where it starts");
}

fn sine_clip(audio: AudioParams, clip: Clip) -> Vec<f32> {
    let mut p = Project { bpm: 120.0, tracks: vec![Track::default()], mixer: mixer(1), ..Default::default() };
    p.channels = vec![Channel { id: 5, inst: Inst::Audio(audio), vol: 1.0, ..Default::default() }];
    p.clips = vec![Clip { track: 0, ch: 5, ..clip }];
    render(Box::new(SampleCache::default().build(&p)), Mode::Song, SR, 0.0).l
}

#[test]
fn audio_clips_have_volume_fades_pitch_and_reverse() {
    let s = SR as usize;
    let sine = || AudioParams { sample: "sine440.wav".into(), path: Some(sine_file()), ..Default::default() };
    let clip = Clip { t: 0, l: BAR, ..Default::default() };
    let full = sine_clip(sine(), clip.clone());
    // its own volume
    let half = sine_clip(sine(), Clip { gain: 0.5, ..clip.clone() });
    assert!((rms(&half[s / 2..s]) / rms(&full[s / 2..s]) - 0.5).abs() < 0.01);
    // fades: silent at the start, full in the middle, quiet towards the end
    let faded = sine_clip(sine(), Clip { fade_in: PPQ as f64, fade_out: PPQ as f64, ..clip.clone() });
    assert!(rms(&faded[..480]) < 0.02, "fade-in starts at zero");
    assert!((rms(&faded[s / 2..s]) - rms(&full[s / 2..s])).abs() < 0.01);
    assert!(rms(&faded[2 * s - 4800..2 * s - 100]) < 0.1, "fade-out goes to zero");
    // an octave up, the length kept
    let up = sine_clip(AudioParams { pitch: 12.0, ..sine() }, clip.clone());
    let f = hz(&up[s / 4..s * 7 / 4]);
    assert!((f - 880.0).abs() < 8.0, "pitch +12: {f} Hz");
    assert!(rms(&up[s / 4..s * 7 / 4]) > 0.3);
    // backwards: the sine file ends with its 4 s point, so a reversed clip starts there
    let fwd = sine_clip(sine(), clip.clone());
    let rev = sine_clip(AudioParams { reverse: true, ..sine() }, clip);
    assert!(rms(&rev[s / 2..s]) > 0.3);
    assert!(fwd[s / 2..s / 2 + 400].iter().zip(&rev[s / 2..s / 2 + 400]).any(|(a, b)| (a - b).abs() > 0.1), "reversed differs");
}

#[test]
fn processing_switches_off_per_track_or_for_the_whole_mixer() {
    let mut p = Project { mixer: mixer(2), ..Default::default() };
    p.mixer[1].input = 1;
    p.mixer[1].fx = vec![FxSlot { pid: 3, on: true, mix: 1.0 }];
    let level = |p: &Project| {
        let mut e = Engine::new(SR, Box::new(SampleCache::default().build(p)), Arc::new(Shared::default()));
        e.set_input(Some(Box::new(Dc)));
        e.add_plugin(3, Box::new(Gain(0.0)));
        run(&mut e, 2048)[2000]
    };
    assert!(level(&p).abs() < 1e-6, "the muting effect works");
    p.mixer[1].fx_off = true;
    assert!((level(&p) - 0.5).abs() < 1e-4, "the track's processing off");
    p.mixer[1].fx_off = false;
    p.fx_off = true;
    assert!((level(&p) - 0.5).abs() < 1e-4, "the whole mixer's processing off");
}

#[test]
fn a_take_over_the_playlist_loop_stops_at_its_end() {
    let mut p = four_on_floor();
    p.bpm = 120.0;
    p.loop_region = Some(LoopRegion { start: BAR, end: 2 * BAR, enabled: true });
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Song);
    e.set_pos(BAR as f64);
    e.set_stop_at_loop_end(true);
    e.play();
    // one bar is 2 s at 120 bpm: a little more than that
    run(&mut e, (2.2 * SR) as usize);
    assert!(!e.playing(), "stopped at the loop's end");
    assert_eq!(e.position(), (2 * BAR) as f64);
    // without it the loop goes round as always
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Song);
    e.set_pos(BAR as f64);
    e.play();
    run(&mut e, (2.2 * SR) as usize);
    assert!(e.playing() && e.position() < (BAR + PPQ) as f64);
}

#[test]
fn notes_carry_their_own_pan() {
    let mut p = four_on_floor();
    p.mixer = mixer(1);
    for n in p.patterns[0].notes.get_mut(&1).unwrap() { n.p = -1.0; }
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    // the rim is mono: hard left leaves the right side silent, the left as loud as centred
    assert!(rms(&out.l) > 0.005 && out.r.iter().all(|x| x.abs() < 1e-6));
    for n in p.patterns[0].notes.get_mut(&1).unwrap() { n.p = 0.0; }
    let mid = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    assert!((rms(&mid.l) / rms(&out.l) - 1.0).abs() < 0.01, "the middle keeps the level");
}

#[test]
fn the_piano_roll_loop_runs_pattern_playback_inside_it() {
    let mut p = four_on_floor();
    p.pat_loop = Some(LoopRegion { start: PPQ, end: 2 * PPQ, enabled: true });
    let mut e = Engine::new(SR, Box::new(SampleCache::default().build(&p)), Arc::new(Shared::default()));
    e.set_mode(Mode::Pattern(1));
    e.play();
    // beats 2 only, again and again: a beat is half a second at 120 bpm
    let out = run(&mut e, (1.6 * SR) as usize);
    let beat = (0.5 * SR) as usize;
    for k in 0..3 {
        let at = onset(&out, (k * beat).saturating_sub(10), 0.01).unwrap();
        assert!(at.abs_diff(k * beat) <= 2, "loop {k}: onset at {at}");
    }
    assert!(e.position() >= PPQ as f64 && e.position() < (2 * PPQ) as f64);
}

#[test]
fn slide_notes_glide_the_sounding_note_to_their_key() {
    // a sine A4 held for a bar; a slide note to A5 on beat 2, one step long
    let sine = SynthParams { osc1: Wave::Sine, osc2: Wave::Sine, cutoff: 1.0, fenv: 0.0, res: 0.0, s: 1.0, a: 0.001, ..Default::default() };
    let n = |t: u32, l: u32, k: u8, s: bool| Note { t, l, k, v: 1.0, p: 0.0, s };
    let mut p = Project { bpm: 120.0, mixer: mixer(1), ..Default::default() };
    p.channels = vec![Channel { id: 1, vol: 1.0, inst: Inst::Synth(sine), ..Default::default() }];
    p.patterns = vec![Pattern { id: 1, bars: 1, notes: [(1, vec![n(0, BAR, 69, false), n(PPQ, STEP, 81, true)])].into(), ..Default::default() }];
    let out = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    let s = SR as usize;
    let before = hz(&out.l[s / 8..s / 2 - 1000]);
    let after = hz(&out.l[s * 3 / 4..s * 3 / 2]);
    assert!((before - 440.0).abs() < 8.0, "before the slide: {before} Hz");
    assert!((after - 880.0).abs() < 12.0, "after it: {after} Hz");
    // the slide note started no voice of its own
    p.patterns[0].notes.insert(1, vec![n(PPQ, STEP, 81, true)]);
    let none = render(Box::new(SampleCache::default().build(&p)), Mode::Pattern(1), SR, 0.0);
    assert!(none.l.iter().all(|x| x.abs() < 1e-6));
}
