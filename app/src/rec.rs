//! The audio input: open while a mixer track listens to it or a take is being recorded.
//! One thread owns the input stream (cpal streams are not `Send`) and writes the files. The
//! stream's callback copies samples into two lock-free rings — one for the writer, one that the
//! engine reads to send the input into mixer tracks — keeps the peak level, and dates the
//! samples so a take can be lined up with the music.

use crate::audio::now_us;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use loom_engine::plugin::InputSource;
use loom_engine::project::{input_route, MAX_INPUT_CHANNELS};
use loom_engine::engine::MAX_BLOCK;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub fn input_devices() -> Vec<String> {
    cpal::default_host().input_devices().map(|ds| ds.filter_map(|d| d.description().ok().map(|d| d.name().to_owned())).collect()).unwrap_or_default()
}

#[derive(serde::Serialize, Clone)]
pub struct Take {
    pub path: String,
    pub seconds: f32,
    pub sr: u32,
    pub channels: u16,
    /// the mixer track it was recorded for
    pub track: u32,
    /// now_us() of the file's first sample as it hit the input (input latency taken off)
    pub start_us: u64,
    /// set by the app: that moment minus when the music started sounding, in ms
    pub offset_ms: Option<f64>,
}

/// One file of a take: what to write and which inputs (1, 2, 3 = both, 0 = all the device has).
pub struct TakeSpec {
    pub path: PathBuf,
    pub track: u32,
    pub mode: u32,
}

enum Msg {
    Close,
    RecStart(Vec<TakeSpec>, mpsc::Sender<Result<(), String>>),
    RecStop(mpsc::Sender<Vec<Take>>),
}

struct Running {
    device: Option<String>,
    tx: mpsc::Sender<Msg>,
    thread: JoinHandle<()>,
}

pub struct Input {
    run: Mutex<Option<Running>>,
    /// the takes being written now: (mixer track, their new peaks)
    pub live: Arc<Mutex<Vec<(u32, Arc<Mutex<Vec<f32>>>)>>>,
    /// input peak since the UI last looked
    pub level: Arc<AtomicU32>,
    recording: Arc<std::sync::atomic::AtomicBool>,
}

/// What the engine reads: the input at the output's rate, the backlog kept near 20 ms.
pub struct Feed {
    rx: rtrb::Consumer<f32>,
    ch: usize,
    in_sr: f64,
    step: f64,
    pos: f64,
    frame: [f32; MAX_INPUT_CHANNELS],
    block: Vec<f32>,
    frames: usize,
}

impl InputSource for Feed {
    fn read(&mut self, in1: &mut [f32], in2: &mut [f32]) -> bool {
        self.frames = in1.len().min(in2.len()).min(MAX_BLOCK);
        let ch = self.ch;
        let keep = ((self.in_sr * 0.02) as usize).max(64) * ch;
        let avail = self.rx.slots();
        if avail > keep * 2 {
            // more piled up than we want to hear late: drop the oldest
            if let Ok(c) = self.rx.read_chunk((avail - keep) / ch * ch) {
                c.commit_all();
            }
        }
        for i in 0..self.frames {
            self.pos += self.step;
            while self.pos >= 1.0 {
                self.pos -= 1.0;
                if self.rx.slots() >= ch {
                    for c in 0..ch {
                        let v = self.rx.pop().unwrap_or(0.0);
                        if c < MAX_INPUT_CHANNELS { self.frame[c] = v; }
                    }
                } else {
                    // ran dry: silence rather than a held sample
                    self.frame.fill(0.0);
                }
            }
            in1[i] = self.frame[0];
            in2[i] = self.frame[if ch > 1 { 1 } else { 0 }];
            for c in 0..ch.min(MAX_INPUT_CHANNELS) { self.block[c * MAX_BLOCK + i] = self.frame[c]; }
        }
        true
    }

    fn channel(&self, index: usize) -> Option<&[f32]> {
        (index < self.ch.min(MAX_INPUT_CHANNELS)).then(|| &self.block[index * MAX_BLOCK..index * MAX_BLOCK + self.frames])
    }
}

impl Input {
    pub fn new() -> Self {
        Self { run: Mutex::new(None), live: Arc::new(Mutex::new(Vec::new())), level: Arc::new(AtomicU32::new(0)), recording: Arc::new(false.into()) }
    }

    pub fn is_open(&self) -> bool {
        self.run.lock().unwrap().is_some()
    }

    pub fn recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    /// Opens `device` (the system default when None), or keeps it open if it already is.
    /// Returns a new feed for the engine when it (re)opened.
    pub fn open(&self, device: Option<String>, out_sr: u32, source: Option<cpal::Device>) -> Result<Option<Feed>, String> {
        let mut run = self.run.lock().unwrap();
        if let Some(r) = run.as_ref() {
            if r.device == device {
                return Ok(None);
            }
            if self.recording() {
                return Err("Stop recording before changing the input device".into());
            }
        }
        if let Some(r) = run.take() {
            let _ = r.tx.send(Msg::Close);
            let _ = r.thread.join();
        }
        let (tx, rx) = mpsc::channel::<Msg>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(rtrb::Consumer<f32>, usize, u32), String>>();
        let (level, rec, dev, live) = (self.level.clone(), self.recording.clone(), device.clone(), self.live.clone());
        let thread = std::thread::Builder::new()
            .name("loom-input".into())
            .spawn(move || run_input(dev, source, rx, ready_tx, level, rec, live))
            .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok((mon, ch, sr))) => {
                *run = Some(Running { device, tx, thread });
                Ok(Some(Feed { rx: mon, ch: ch.max(1), in_sr: sr as f64, step: sr as f64 / out_sr.max(1) as f64, pos: 0.0, frame: [0.0; MAX_INPUT_CHANNELS], block: vec![0.0; MAX_INPUT_CHANNELS * MAX_BLOCK], frames: 0 }))
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("the input stopped".into()),
        }
    }

    /// Closes and opens the same device again (the output changed: a fresh feed at its rate).
    pub fn selected_device(&self) -> Option<String> {
        self.run.lock().unwrap().as_ref().and_then(|r| r.device.clone())
    }

    pub fn close(&self) {
        if let Some(r) = self.run.lock().unwrap().take() {
            let _ = r.tx.send(Msg::Close);
            let _ = r.thread.join();
        }
        self.level.store(0, Ordering::Relaxed);
    }

    /// Starts writing a take: one file per spec, from the samples arriving now.
    pub fn rec_start(&self, specs: Vec<TakeSpec>) -> Result<(), String> {
        let run = self.run.lock().unwrap();
        let r = run.as_ref().ok_or("the input is not open")?;
        let (tx, rx) = mpsc::channel();
        r.tx.send(Msg::RecStart(specs, tx)).map_err(|_| "the input stopped")?;
        rx.recv().map_err(|_| "the input stopped".to_string())?
    }

    pub fn rec_stop(&self) -> Vec<Take> {
        let run = self.run.lock().unwrap();
        let Some(r) = run.as_ref() else { return vec![] };
        let (tx, rx) = mpsc::channel();
        if r.tx.send(Msg::RecStop(tx)).is_err() {
            return vec![];
        }
        rx.recv().unwrap_or_default()
    }
}

/// Peaks of a take while it is written, for drawing it as it grows: a min/max pair per 10 ms
/// (both channels folded in), taken by the UI as they come (`drain`).
pub struct Meter {
    per: usize,
    n: usize,
    lo: f32,
    hi: f32,
    pub out: Arc<Mutex<Vec<f32>>>,
}

impl Meter {
    pub fn new(sr: u32) -> Self {
        Self { per: (sr as usize / 100).max(1), n: 0, lo: 0.0, hi: 0.0, out: Arc::new(Mutex::new(Vec::new())) }
    }
    pub fn frame(&mut self, a: f32, b: f32) {
        self.lo = self.lo.min(a).min(b);
        self.hi = self.hi.max(a).max(b);
        self.n += 1;
        if self.n == self.per {
            if let Ok(mut o) = self.out.lock() {
                o.push(self.lo);
                o.push(self.hi);
            }
            (self.n, self.lo, self.hi) = (0, 0.0, 0.0);
        }
    }
}

/// The new peaks of a live take, emptied.
pub fn drain(p: &Mutex<Vec<f32>>) -> Vec<f32> {
    p.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

struct Writer {    spec: TakeSpec,
    w: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    channels: u16,
    frames: u64,
    meter: Meter,
}

impl Writer {
    fn write(&mut self, frame: &[f32]) -> hound::Result<()> {
        let (left, right, _) = input_route(self.spec.mode).unwrap_or((0, 1, true));
        let value = |index: usize| frame.get(index).copied().unwrap_or_else(|| {
            if self.spec.mode <= 3 && frame.len() == 1 { frame[0] } else { 0.0 }
        });
        let (a, b) = (value(left), value(right));
        self.w.write_sample(a)?;
        if self.channels == 2 { self.w.write_sample(b)?; }
        self.meter.frame(a, if self.channels == 2 { b } else { a });
        self.frames += 1;
        Ok(())
    }

    fn finish(self, sr: u32, start_us: u64) -> hound::Result<Take> {
        self.w.finalize()?;
        Ok(Take {
            path: self.spec.path.to_string_lossy().into_owned(), seconds: self.frames as f32 / sr as f32,
            sr, channels: self.channels, track: self.spec.track, start_us, offset_ms: None,
        })
    }
}

/// All files open together or none do. Never truncate an earlier take with the same name.
fn create_writers(specs: Vec<TakeSpec>, ch: usize, sr: u32) -> Result<Vec<Writer>, String> {
    let mut writers: Vec<Writer> = vec![];
    for s in specs {
        let result = (|| {
            if let Some(dir) = s.path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
            let channels = if s.mode == 0 { ch.min(2) as u16 } else {
                let (_, right, stereo) = input_route(s.mode).ok_or("Unknown input channel")?;
                if right >= ch && s.mode > 3 { return Err("Selected input is unavailable in the active driver".into()); }
                if stereo { 2 } else { 1 }
            };
            let spec = hound::WavSpec { channels, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
            let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&s.path).map_err(|e| e.to_string())?;
            match hound::WavWriter::new(std::io::BufWriter::new(file), spec) {
                Ok(w) => Ok(Writer { spec: s, w, channels, frames: 0, meter: Meter::new(sr) }),
                Err(e) => { let _ = std::fs::remove_file(&s.path); Err(e.to_string()) }
            }
        })();
        match result {
            Ok(w) => writers.push(w),
            Err(e) => {
                for w in writers { let path = w.spec.path.clone(); drop(w); let _ = std::fs::remove_file(path); }
                return Err(e);
            }
        }
    }
    Ok(writers)
}

fn run_input(
    device: Option<String>,
    source: Option<cpal::Device>,
    msgs: mpsc::Receiver<Msg>,
    ready: mpsc::Sender<Result<(rtrb::Consumer<f32>, usize, u32), String>>,
    level: Arc<AtomicU32>,
    recording: Arc<std::sync::atomic::AtomicBool>,
    live: Arc<Mutex<Vec<(u32, Arc<Mutex<Vec<f32>>>)>>>,
) {
    let fail = |e: String| {
        let _ = ready.send(Err(e));
    };
    let host = cpal::default_host();
    let dev = source.or_else(|| match &device {
        Some(name) => host.input_devices().ok().and_then(|mut ds| ds.find(|d| d.description().ok().map(|d| d.name().to_owned()).as_deref() == Some(name.as_str()))).or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    });
    let Some(dev) = dev else { return fail("no audio input (microphone) found".into()) };
    let sup = match dev.default_input_config() {
        Ok(s) => s,
        Err(e) => return fail(e.to_string()),
    };
    let format = sup.sample_format();
    let cfg: cpal::StreamConfig = sup.into();
    let ch = cfg.channels as usize;
    let sr = cfg.sample_rate;
    if ch == 0 || sr == 0 { return fail("The selected device has no audio inputs enabled".into()); }
    // writer ring (~4 s) and the engine's monitoring ring (~0.5 s)
    let (mut tx, mut rx) = rtrb::RingBuffer::<f32>::new(sr as usize * ch * 4);
    let (mut mtx, mrx) = rtrb::RingBuffer::<f32>::new(sr as usize * ch / 2);
    let lv = level.clone();
    // dating: the frame count and the capture time of the latest callback's first frame
    let anchor_frame = Arc::new(AtomicU64::new(0));
    let anchor_us = Arc::new(AtomicU64::new(0));
    let (af, au) = (anchor_frame.clone(), anchor_us.clone());
    let mut delivered: u64 = 0;
    let err = |e| eprintln!("input: {e}");
    macro_rules! build {
        ($t:ty) => {
            dev.build_input_stream(
                cfg.clone(),
                move |data: &[$t], info: &cpal::InputCallbackInfo| {
                    let ts = info.timestamp();
                    let lat = ts.callback.duration_since(ts.capture).as_micros() as u64;
                    au.store(now_us().saturating_sub(lat).max(1), Ordering::Relaxed);
                    af.store(delivered, Ordering::Relaxed);
                    delivered += (data.len() / ch.max(1)) as u64;
                    let mut peak = 0f32;
                    for frame in data.chunks_exact(ch) {
                        // Preserve channel boundaries when a consumer falls behind.
                        let write = tx.slots() >= ch;
                        let monitor = mtx.slots() >= ch;
                        for s in frame {
                            let v: f32 = cpal::Sample::to_sample::<f32>(*s);
                            peak = peak.max(v.abs());
                            if write { let _ = tx.push(v); }
                            if monitor { let _ = mtx.push(v); }
                        }
                    }
                    if peak > f32::from_bits(lv.load(Ordering::Relaxed)) {
                        lv.store(peak.to_bits(), Ordering::Relaxed);
                    }
                },
                err,
                None,
            )
        };
    }
    let stream = match format {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::F64 => build!(f64),
        cpal::SampleFormat::I24 => build!(cpal::I24),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U16 => build!(u16),
        f => return fail(format!("unsupported input format {f}")),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => return fail(e.to_string()),
    };
    if let Err(e) = stream.play() {
        return fail(e.to_string());
    }
    let _ = ready.send(Ok((mrx, ch, sr)));

    let mut frame = vec![0f32; ch];
    let mut fi = 0;
    let mut popped: u64 = 0; // whole frames taken from the ring since the stream opened
    let mut writers: Vec<Writer> = vec![];
    let mut start_us: u64 = 0;
    loop {
        // take what arrived; while recording, each writer keeps its inputs of every frame
        while let Ok(v) = rx.pop() {
            frame[fi] = v;
            fi += 1;
            if fi == ch {
                fi = 0;
                if !writers.is_empty() && start_us == 0 {
                    // The input may not have delivered its first callback at rec_start yet.
                    // Date the first frame actually written, including any pre-roll in the ring.
                    let (af, au) = (anchor_frame.load(Ordering::Relaxed), anchor_us.load(Ordering::Relaxed));
                    let d = (popped as f64 - af as f64) / sr as f64 * 1e6;
                    start_us = (au as f64 + d).max(1.0) as u64;
                }
                popped += 1;
                for w in writers.iter_mut() {
                    let _ = w.write(&frame);
                }
            }
        }
        match msgs.recv_timeout(std::time::Duration::from_millis(15)) {
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) | Ok(Msg::Close) => break,
            Ok(Msg::RecStart(specs, reply)) => {
                if !writers.is_empty() {
                    let _ = reply.send(Err("Already recording".into()));
                    continue;
                }
                let res = create_writers(specs, ch, sr).map(|ws| {
                    writers = ws;
                    *live.lock().unwrap() = writers.iter().map(|w| (w.spec.track, w.meter.out.clone())).collect();
                    start_us = 0;
                    recording.store(!writers.is_empty(), Ordering::Relaxed);
                });
                let _ = reply.send(res);
            }
            Ok(Msg::RecStop(reply)) => {
                let mut takes = vec![];
                for w in writers.drain(..) {
                    if let Ok(take) = w.finish(sr, start_us) {
                        // nothing worth keeping (stopped at once): the file goes
                        if take.seconds < 0.05 { let _ = std::fs::remove_file(&take.path); } else { takes.push(take); }
                    }
                }
                recording.store(false, Ordering::Relaxed);
                live.lock().unwrap().clear();
                let _ = reply.send(takes);
            }
        }
    }
    drop(stream);
    for w in writers {
        let _ = w.w.finalize();
    }
    recording.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("loom-rec-{}-{label}-{}", std::process::id(), now_us()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn separate_mono_and_stereo_takes_keep_their_inputs_and_timing() {
        let dir = folder("tracks");
        let specs = (1..=3).map(|mode| TakeSpec { path: dir.join(format!("{mode}.wav")), track: mode + 3, mode }).collect();
        let mut writers = create_writers(specs, 2, 48000).unwrap();
        for _ in 0..480 {
            for w in &mut writers { w.write(&[0.25, -0.5]).unwrap(); }
        }
        for w in writers {
            let mode = w.spec.mode;
            let take = w.finish(48000, 123456).unwrap();
            assert_eq!(take.track, mode + 3);
            assert_eq!(take.start_us, 123456);
            assert!((take.seconds - 0.01).abs() < 1e-6);
            let mut wav = hound::WavReader::open(&take.path).unwrap();
            assert_eq!(wav.spec().channels, if mode == 3 { 2 } else { 1 });
            let samples: Vec<f32> = wav.samples::<f32>().map(Result::unwrap).collect();
            match mode {
                1 => assert!(samples.iter().all(|&v| v == 0.25)),
                2 => assert!(samples.iter().all(|&v| v == -0.5)),
                _ => assert!(samples.chunks_exact(2).all(|f| f == [0.25, -0.5])),
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_start_rolls_back_new_files_and_preserves_existing_takes() {
        let dir = folder("rollback");
        let existing = dir.join("old.wav");
        std::fs::write(&existing, b"keep this take").unwrap();
        let new = dir.join("new.wav");
        let specs = vec![TakeSpec { path: new.clone(), track: 1, mode: 1 }, TakeSpec { path: existing.clone(), track: 2, mode: 2 }];
        assert!(create_writers(specs, 2, 48000).is_err());
        assert!(!new.exists());
        assert_eq!(std::fs::read(existing).unwrap(), b"keep this take");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stereo_selection_on_a_mono_device_duplicates_the_input() {
        let dir = folder("mono-stereo");
        let specs = vec![TakeSpec { path: dir.join("stereo.wav"), track: 1, mode: 3 }];
        let mut writers = create_writers(specs, 1, 48000).unwrap();
        writers[0].write(&[0.25]).unwrap();
        let take = writers.pop().unwrap().finish(48000, 123).unwrap();
        let mut wav = hound::WavReader::open(take.path).unwrap();
        assert_eq!(wav.spec().channels, 2);
        assert_eq!(wav.samples::<f32>().map(Result::unwrap).collect::<Vec<_>>(), [0.25, 0.25]);
        drop(wav);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn monitoring_feed_handles_mono_and_sample_rate_changes() {
        let (mut tx, rx) = rtrb::RingBuffer::new(16);
        for v in [0.1, 0.2, 0.3, 0.4] { tx.push(v).unwrap(); }
        let mut feed = Feed { rx, ch: 1, in_sr: 48000.0, step: 2.0, pos: 0.0, frame: [0.0; MAX_INPUT_CHANNELS], block: vec![0.0; MAX_INPUT_CHANNELS * MAX_BLOCK], frames: 0 };
        let (mut l, mut r) = ([0.0; 3], [0.0; 3]);
        feed.read(&mut l, &mut r);
        assert_eq!(l, [0.2, 0.4, 0.0]);
        assert_eq!(r, l);
    }

    #[test]
    fn later_device_channels_reach_monitoring_and_their_wav_files() {
        let dir = folder("more-inputs");
        let (mut tx, rx) = rtrb::RingBuffer::new(24);
        for _ in 0..4 { for v in [0.1, 0.2, 0.3, 0.4] { tx.push(v).unwrap(); } }
        let mut feed = Feed { rx, ch: 4, in_sr: 48000.0, step: 1.0, pos: 0.0, frame: [0.0; MAX_INPUT_CHANNELS], block: vec![0.0; MAX_INPUT_CHANNELS * MAX_BLOCK], frames: 0 };
        let (mut left, mut right) = ([0.0; 4], [0.0; 4]);
        feed.read(&mut left, &mut right);
        assert_eq!(feed.channel(2).unwrap(), &[0.3; 4]);
        assert_eq!(feed.channel(3).unwrap(), &[0.4; 4]);
        let specs = vec![TakeSpec { path: dir.join("mono3.wav"), track: 1, mode: 18 }, TakeSpec { path: dir.join("stereo34.wav"), track: 2, mode: 1026 }];
        let mut writers = create_writers(specs, 4, 48000).unwrap();
        for w in &mut writers { w.write(&[0.1, 0.2, 0.3, 0.4]).unwrap(); }
        let takes: Vec<_> = writers.into_iter().map(|w| w.finish(48000, 1).unwrap()).collect();
        for (i, take) in takes.iter().enumerate() {
            let mut wav = hound::WavReader::open(&take.path).unwrap();
            let samples: Vec<f32> = wav.samples::<f32>().map(Result::unwrap).collect();
            assert_eq!(samples, if i == 0 { vec![0.3] } else { vec![0.3, 0.4] });
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn live_peaks_come_in_ten_millisecond_pairs_and_drain() {
        let mut m = Meter::new(48000);
        for i in 0..1000 {
            m.frame(if i == 10 { -0.5 } else { 0.1 }, if i == 600 { 0.9 } else { 0.0 });
        }
        let p = drain(&m.out);
        assert_eq!(p, vec![-0.5, 0.1, 0.0, 0.9], "two whole 480-frame chunks: min/max each");
        assert!(drain(&m.out).is_empty(), "taken once");
    }
}