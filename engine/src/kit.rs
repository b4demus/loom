//! The built-in drum kit, synthesized at startup: no sample files to ship.

use crate::dsp::{Rng, Svf};
use crate::sampler::SampleBuf;
use std::f32::consts::TAU;
use std::sync::{Arc, OnceLock};

const SR: f32 = 44100.0;

/// name, label for the UI
pub const KIT: &[(&str, &str)] = &[
    ("kick", "kick"),
    ("snare", "snare"),
    ("clap", "clap"),
    ("hat", "hat"),
    ("openhat", "open hat"),
    ("rim", "rim"),
    ("tom", "tom"),
    ("sub", "sub 808"),
    ("crash", "crash"),
    ("shaker", "shaker"),
    ("snap", "snap"),
    ("cowbell", "cowbell"),
];

fn mono(v: Vec<f32>) -> Arc<SampleBuf> {
    // peak-normalise to -1 dBFS so every sound starts at the same level
    let peak = v.iter().fold(0f32, |m, x| m.max(x.abs())).max(1e-9);
    let g = 0.89 / peak;
    let l: Vec<f32> = v.iter().map(|x| x * g).collect();
    Arc::new(SampleBuf { r: l.clone(), l, sr: SR })
}

fn len(sec: f32) -> usize {
    (sec * SR) as usize
}

/// a click-free fade over the last few ms
fn tail(v: &mut [f32]) {
    let n = v.len().min(len(0.004));
    let start = v.len() - n;
    for (i, x) in v[start..].iter_mut().enumerate() {
        *x *= 1.0 - i as f32 / n as f32;
    }
}

fn kick() -> Vec<f32> {
    let mut rng = Rng(17);
    let mut hp = Svf::default();
    hp.set(3000.0, 0.0, SR);
    let mut out = vec![0.0; len(0.55)];
    let mut ph = 0f32;
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let f = 46.0 + 120.0 * (-t / 0.028).exp() + 300.0 * (-t / 0.004).exp();
        ph += f / SR;
        let body = (ph * TAU).sin() * (-t / 0.32).exp();
        let click = hp.tick(rng.next()).2 * (-t / 0.0025).exp() * 0.5;
        *o = (1.6 * (body + click)).tanh();
    }
    tail(&mut out);
    out
}

fn snare() -> Vec<f32> {
    let mut rng = Rng(23);
    let mut bp = Svf::default();
    bp.set(4200.0, 0.15, SR);
    let mut out = vec![0.0; len(0.32)];
    let (mut p1, mut p2) = (0f32, 0f32);
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let drop = 1.0 + 0.5 * (-t / 0.01).exp();
        p1 += 185.0 * drop / SR;
        p2 += 330.0 * drop / SR;
        let tone = ((p1 * TAU).sin() * 0.7 + (p2 * TAU).sin() * 0.35) * (-t / 0.07).exp();
        let (_, band, high) = bp.tick(rng.next());
        let noise = (band * 0.6 + high * 0.5) * (-t / 0.11).exp();
        *o = tone * 0.8 + noise;
    }
    tail(&mut out);
    out
}

fn clap() -> Vec<f32> {
    let mut rng = Rng(31);
    let mut bp = Svf::default();
    bp.set(1300.0, 0.55, SR);
    let mut out = vec![0.0; len(0.4)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        // three quick slaps, then the room
        let mut e = 0.0f32;
        for k in 0..3 {
            let tk = t - k as f32 * 0.011;
            if tk >= 0.0 {
                e = e.max((-tk / 0.007).exp());
            }
        }
        if t > 0.022 {
            e = e.max(0.8 * (-(t - 0.022) / 0.12).exp());
        }
        let (_, band, _) = bp.tick(rng.next());
        *o = band * e;
    }
    tail(&mut out);
    out
}

/// six detuned square partials: a metallic body for hats, cymbals and the cowbell
fn metal(t: f32, freqs: &[f32]) -> f32 {
    freqs.iter().map(|f| if (t * f).fract() < 0.5 { 1.0 } else { -1.0 }).sum::<f32>() / freqs.len() as f32
}

const METAL: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

fn hat(sec: f32, decay: f32) -> Vec<f32> {
    let mut rng = Rng(41);
    let mut hp = Svf::default();
    hp.set(7600.0, 0.2, SR);
    let mut hp2 = Svf::default();
    hp2.set(6000.0, 0.0, SR);
    let mut out = vec![0.0; len(sec)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let x = metal(t, &METAL) * 0.6 + rng.next() * 0.5;
        let y = hp2.tick(hp.tick(x).2).2;
        *o = y * (-t / decay).exp();
    }
    tail(&mut out);
    out
}

fn crash() -> Vec<f32> {
    let mut rng = Rng(43);
    let mut hp = Svf::default();
    hp.set(4500.0, 0.1, SR);
    let freqs: Vec<f32> = METAL.iter().map(|f| f * 1.47).collect();
    let mut out = vec![0.0; len(1.8)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let x = metal(t, &freqs) * 0.35 + rng.next() * 0.8;
        let e = (-t / 0.55).exp() * (1.0 - (-t / 0.002).exp());
        *o = hp.tick(x).2 * e;
    }
    tail(&mut out);
    out
}

fn rim() -> Vec<f32> {
    let mut out = vec![0.0; len(0.08)];
    let mut bp = Svf::default();
    bp.set(1700.0, 0.7, SR);
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let x = (t * 820.0 * TAU).sin() * (-t / 0.012).exp() + if i < 40 { 1.0 } else { 0.0 };
        *o = bp.tick(x).1;
    }
    tail(&mut out);
    out
}

fn tom() -> Vec<f32> {
    let mut out = vec![0.0; len(0.5)];
    let mut ph = 0f32;
    let mut rng = Rng(53);
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        ph += (110.0 + 70.0 * (-t / 0.05).exp()) / SR;
        *o = (ph * TAU).sin() * (-t / 0.2).exp() + rng.next() * 0.05 * (-t / 0.01).exp();
    }
    tail(&mut out);
    out
}

/// a long 808-style sub, tuned to C2 (key 36) so its channel can play bass lines
fn sub() -> Vec<f32> {
    let f0 = 440.0 * ((36.0f32 - 69.0) / 12.0).exp2();
    let mut out = vec![0.0; len(1.6)];
    let mut ph = 0f32;
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        ph += f0 * (1.0 + 1.2 * (-t / 0.018).exp()) / SR;
        let e = (-t / 0.7).exp();
        *o = (2.2 * (ph * TAU).sin()).tanh() * e;
    }
    tail(&mut out);
    out
}

fn shaker() -> Vec<f32> {
    let mut rng = Rng(61);
    let mut bp = Svf::default();
    bp.set(6500.0, 0.4, SR);
    let mut out = vec![0.0; len(0.14)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let e = (t / 0.025).min(1.0) * (-t / 0.035).exp();
        *o = bp.tick(rng.next()).1 * e;
    }
    tail(&mut out);
    out
}

fn snap() -> Vec<f32> {
    let mut rng = Rng(67);
    let mut bp = Svf::default();
    bp.set(2600.0, 0.6, SR);
    let mut out = vec![0.0; len(0.15)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        *o = bp.tick(rng.next()).1 * (-t / 0.03).exp() + (t * 1900.0 * TAU).sin() * 0.3 * (-t / 0.006).exp();
    }
    tail(&mut out);
    out
}

fn cowbell() -> Vec<f32> {
    let mut bp = Svf::default();
    bp.set(900.0, 0.3, SR);
    let mut out = vec![0.0; len(0.4)];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let x = metal(t, &[562.0, 845.0]);
        let e = 0.6 * (-t / 0.012).exp() + 0.4 * (-t / 0.15).exp();
        *o = bp.tick(x).1 * e;
    }
    tail(&mut out);
    out
}

fn build() -> Vec<Arc<SampleBuf>> {
    KIT.iter()
        .map(|(name, _)| {
            mono(match *name {
                "kick" => kick(),
                "snare" => snare(),
                "clap" => clap(),
                "hat" => hat(0.12, 0.035),
                "openhat" => hat(0.6, 0.22),
                "rim" => rim(),
                "tom" => tom(),
                "sub" => sub(),
                "crash" => crash(),
                "shaker" => shaker(),
                "snap" => snap(),
                "cowbell" => cowbell(),
                _ => unreachable!(),
            })
        })
        .collect()
}

/// `name` without the "kit:" prefix
pub fn get(name: &str) -> Option<Arc<SampleBuf>> {
    static CACHE: OnceLock<Vec<Arc<SampleBuf>>> = OnceLock::new();
    let all = CACHE.get_or_init(build);
    KIT.iter().position(|(n, _)| *n == name).map(|i| all[i].clone())
}
