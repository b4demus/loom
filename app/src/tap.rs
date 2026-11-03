//! Recording a mixer track's own sound: an armed track, with or without an input, records what
//! it plays (its effects and fader included). The engine hands each block of the track to a
//! `Sink` (a lock-free ring) while the transport runs; a thread per take writes the ring into a
//! 32-bit float WAV. The first block carries its timeline position, so the take lands exactly
//! where it was played: it comes from the engine, there is no latency to take out.

use loom_engine::plugin::TapSink;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub struct Sink {
    tx: rtrb::Producer<f32>,
    start: Arc<AtomicU64>,
    started: bool,
}

impl TapSink for Sink {
    fn write(&mut self, l: &[f32], r: &[f32], tick: f64) {
        if !self.started {
            self.started = true;
            self.start.store(tick.to_bits(), Ordering::Relaxed);
        }
        // a full ring (a stalled disk) drops the block rather than blocking the audio thread
        if self.tx.slots() < l.len() * 2 {
            return;
        }
        for (a, b) in l.iter().zip(r) {
            let _ = self.tx.push(*a);
            let _ = self.tx.push(*b);
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct TapTake {
    pub path: String,
    /// the mixer track it was recorded from
    pub track: u32,
    pub seconds: f32,
    /// where its first sample sits on the timeline, in ticks
    pub tick: f64,
}

struct Running {
    path: PathBuf,
    track: u32,
    /// its new peaks, for drawing it while it records
    peaks: Arc<Mutex<Vec<f32>>>,
    start: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<u64, String>>,
}

#[derive(Default)]
pub struct Taps {
    running: Mutex<Vec<Running>>,
    sr: Mutex<u32>,
}

impl Taps {
    pub fn recording(&self) -> bool {
        !self.running.lock().unwrap().is_empty()
    }

    /// Opens one file per track (never over an existing one) and returns the sinks for the engine.
    pub fn start(&self, specs: Vec<(u32, PathBuf)>, sr: u32) -> Result<Vec<(usize, Box<dyn TapSink>)>, String> {
        let mut run = self.running.lock().unwrap();
        if !run.is_empty() {
            return Err("Already recording".into());
        }
        let mut sinks: Vec<(usize, Box<dyn TapSink>)> = vec![];
        let mut opened = vec![];
        for (track, path) in specs {
            let made = (|| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
                let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
                hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| e.to_string())
            })();
            let w = match made {
                Ok(w) => w,
                Err(e) => {
                    // all or none: the files opened so far go
                    drop(sinks);
                    for r in opened.drain(..) {
                        let r: Running = r;
                        r.stop.store(true, Ordering::Relaxed);
                        let _ = r.thread.join();
                        let _ = std::fs::remove_file(&r.path);
                    }
                    return Err(e);
                }
            };
            // four seconds of stereo: the writer empties it every few ms
            let (tx, rx) = rtrb::RingBuffer::<f32>::new(sr as usize * 8);
            // unknown (NaN) until the engine hands over the first block
            let start = Arc::new(AtomicU64::new(f64::NAN.to_bits()));
            let meter = crate::rec::Meter::new(sr);
            let peaks = meter.out.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let st = stop.clone();
            let thread = std::thread::Builder::new()
                .name("loom-tap".into())
                .spawn(move || write(rx, w, st, meter))
                .map_err(|e| e.to_string())?;
            sinks.push((track as usize, Box::new(Sink { tx, start: start.clone(), started: false })));
            opened.push(Running { path, track, peaks, start, stop, thread });
        }
        *run = opened;
        *self.sr.lock().unwrap() = sr;
        Ok(sinks)
    }

    /// The takes being written now: (track, where it starts if known, its new peaks).
    pub fn live(&self) -> Vec<(u32, Option<f64>, Vec<f32>)> {
        self.running.lock().unwrap().iter().map(|r| {
            let t = f64::from_bits(r.start.load(Ordering::Relaxed));
            (r.track, t.is_finite().then_some(t), crate::rec::drain(&r.peaks))
        }).collect()
    }

    /// Ends the takes once the engine has let go of their sinks (`settle` empties its trash and
    /// says when a little time passed); a take whose sink never comes back is ended anyway.
    pub fn stop(&self, mut settle: impl FnMut() -> bool) -> Vec<TapTake> {
        let run = std::mem::take(&mut *self.running.lock().unwrap());
        let sr = (*self.sr.lock().unwrap()).max(1) as f32;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while run.iter().any(|r| !r.thread.is_finished()) && std::time::Instant::now() < deadline {
            if !settle() {
                break;
            }
        }
        run.into_iter().filter_map(|r| {
            r.stop.store(true, Ordering::Relaxed);
            let frames = r.thread.join().ok()?.ok()?;
            // stopped before anything played (a count-in, a double press): no file left behind
            if (frames as f32) < sr * 0.05 {
                let _ = std::fs::remove_file(&r.path);
                return None;
            }
            Some(TapTake {
                path: r.path.to_string_lossy().into_owned(),
                track: r.track,
                seconds: frames as f32 / sr,
                tick: { let t = f64::from_bits(r.start.load(Ordering::Relaxed)); if t.is_finite() { t } else { 0.0 } },
            })
        }).collect()
    }
}

/// The writer: until the engine drops the sink (or stop), and the ring is empty.
fn write(mut rx: rtrb::Consumer<f32>, mut w: hound::WavWriter<std::io::BufWriter<std::fs::File>>, stop: Arc<AtomicBool>, mut meter: crate::rec::Meter) -> Result<u64, String> {
    let mut samples = 0u64;
    loop {
        // whole stereo frames only: the sink pushes left and right one after the other
        let n = rx.slots() & !1;
        if n > 0 {
            let chunk = rx.read_chunk(n).map_err(|e| e.to_string())?;
            let (a, b) = chunk.as_slices();
            for v in a.iter().chain(b) {
                w.write_sample(*v).map_err(|e| e.to_string())?;
            }
            let mut it = a.iter().chain(b);
            while let (Some(l), Some(r)) = (it.next(), it.next()) {
                meter.frame(*l, *r);
            }
            samples += n as u64;
            chunk.commit_all();
            continue;
        }
        if rx.is_abandoned() || stop.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    w.finalize().map_err(|e| e.to_string())?;
    Ok(samples / 2)
}
