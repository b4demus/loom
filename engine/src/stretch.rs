//! Time-stretch for audio clips that keep their pitch: WSOLA (waveform-similarity overlap-add).
//!
//! The output is a chain of Hann-windowed grains at half-grain hops; each grain reads the sound at
//! its own speed (1: the pitch stays; 2: an octave up), whatever the clip's rate through time. Grain k nominally starts at `base + k·hop·rate` in
//! the sound and is nudged (within a quarter hop) to where it best continues the grain before it,
//! which keeps the waveform in phase instead of flanging. Any output sample can be computed on
//! its own; the nudges are cached per clip, and a cache miss (after a seek) aligns to the
//! previous grain's nominal place instead, so playback never depends on what was played before.

use crate::sampler::SampleBuf;

/// Grain length in source samples: about 46 ms, even.
pub fn grain_len(sr: f32) -> f64 {
    (((sr as f64 * 0.046) as usize) & !1).max(256) as f64
}

/// Cached grain starts of one clip: (grain index, start in source samples).
#[derive(Clone, Debug)]
pub struct Grains {
    keys: [i64; 8],
    starts: [f64; 8],
    next: usize,
}

impl Default for Grains {
    fn default() -> Self {
        Self { keys: [i64::MIN; 8], starts: [0.0; 8], next: 0 }
    }
}

impl Grains {
    fn get(&self, k: i64) -> Option<f64> {
        self.keys.iter().position(|&x| x == k).map(|i| self.starts[i])
    }
    fn put(&mut self, k: i64, s: f64) {
        self.keys[self.next] = k;
        self.starts[self.next] = s;
        self.next = (self.next + 1) % self.keys.len();
    }
}

/// Mono sample at a fractional position, 0 outside the sound.
fn mono(buf: &SampleBuf, pos: f64) -> f32 {
    let (l, r) = read(buf, pos);
    l + r
}

/// Stereo sample at a fractional position (linear), 0 outside the sound.
pub fn read(buf: &SampleBuf, pos: f64) -> (f32, f32) {
    if pos < 0.0 {
        return (0.0, 0.0);
    }
    let i = pos as usize;
    if i + 1 >= buf.len() {
        return (0.0, 0.0);
    }
    let f = (pos - i as f64) as f32;
    (buf.l[i] + (buf.l[i + 1] - buf.l[i]) * f, buf.r[i] + (buf.r[i + 1] - buf.r[i]) * f)
}

/// Where grain `k` starts in the sound.
fn grain_start(buf: &SampleBuf, g: &mut Grains, k: i64, base: f64, rate: f64, speed: f64, glen: f64) -> f64 {
    let hop = glen / 2.0;
    let nominal = |k: i64| base + k as f64 * hop * rate;
    if k <= 0 {
        return nominal(k.max(0));
    }
    if let Some(s) = g.get(k) {
        return s;
    }
    // what the previous grain would play next if it ran on
    let want = g.get(k - 1).unwrap_or_else(|| nominal(k - 1)) + hop * speed;
    let tol = (hop / 4.0).floor() as i64;
    let len = (hop / 2.0) as usize;
    let mut best = (f32::MIN, 0i64);
    let mut d = -tol;
    while d <= tol {
        let at = nominal(k) + d as f64;
        let (mut xy, mut yy) = (0f32, 1e-9f32);
        let mut i = 0;
        while i < len {
            let a = mono(buf, want + i as f64 * speed);
            let b = mono(buf, at + i as f64 * speed);
            xy += a * b;
            yy += b * b;
            i += 2;
        }
        let score = xy / yy.sqrt();
        if score > best.0 {
            best = (score, d);
        }
        d += 2;
    }
    let s = nominal(k) + best.1 as f64;
    g.put(k, s);
    s
}

/// One output sample of a stretched sound: `o` is the time since the clip's start in source
/// samples as if it played at normal speed, `base` the sound position the clip starts at, `rate`
/// how fast the clip goes through the sound and `speed` how fast each grain reads it (pitch).
pub fn sample(buf: &SampleBuf, g: &mut Grains, base: f64, o: f64, rate: f64, speed: f64, glen: f64) -> (f32, f32) {
    let hop = glen / 2.0;
    let k1 = (o / hop).floor() as i64;
    let (mut l, mut r, mut w) = (0f32, 0f32, 0f32);
    for k in [k1 - 1, k1] {
        if k < 0 {
            continue;
        }
        let d = o - k as f64 * hop;
        if !(0.0..glen).contains(&d) {
            continue;
        }
        let pos = grain_start(buf, g, k, base, rate, speed, glen) + d * speed;
        if pos < 0.0 || pos + 1.0 >= buf.len() as f64 {
            continue;
        }
        let wk = (0.5 - 0.5 * (std::f64::consts::TAU * d / glen).cos()) as f32;
        let (a, b) = read(buf, pos);
        l += a * wk;
        r += b * wk;
        w += wk;
    }
    // two grains always sum to 1; alone (the first one, or at the end of the sound) it is scaled up
    if w > 1e-4 { (l / w, r / w) } else { (0.0, 0.0) }
}
