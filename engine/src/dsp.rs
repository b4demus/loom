//! Small DSP pieces shared by the instruments.

use std::f32::consts::PI;

pub fn key_hz(key: f32) -> f32 {
    440.0 * ((key - 69.0) / 12.0).exp2()
}

/// PolyBLEP residual for a discontinuity at phase 0 (t in 0..1, dt = phase step).
#[inline]
pub fn blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// xorshift: cheap white noise that never allocates
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    #[inline]
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// Topology-preserving state variable filter (lowpass / bandpass / highpass outputs).
#[derive(Clone, Copy, Default)]
pub struct Svf {
    ic1: f32,
    ic2: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32,
}

impl Svf {
    pub fn set(&mut self, hz: f32, res: f32, sr: f32) {
        let g = (PI * (hz / sr).clamp(1e-5, 0.49)).tan();
        self.k = 2.0 - 1.96 * res.clamp(0.0, 1.0);
        self.a1 = 1.0 / (1.0 + g * (g + self.k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }
    /// returns (low, band, high)
    #[inline]
    pub fn tick(&mut self, x: f32) -> (f32, f32, f32) {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, x - self.k * v1 - v2)
    }
    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// ADSR with a linear attack and exponential decay/release.
#[derive(Clone, Copy)]
pub struct Adsr {
    pub stage: Stage,
    pub v: f32,
}

impl Default for Adsr {
    fn default() -> Self {
        Self { stage: Stage::Idle, v: 0.0 }
    }
}

/// per-sample coefficient of a one-pole that gets ~99% of the way in `sec`
#[inline]
pub fn pole(sec: f32, sr: f32) -> f32 {
    if sec <= 0.0 {
        0.0
    } else {
        (-4.6 / (sec * sr)).exp()
    }
}

impl Adsr {
    pub fn on(&mut self) {
        self.stage = Stage::Attack;
    }
    pub fn off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }
    pub fn idle(&self) -> bool {
        self.stage == Stage::Idle
    }
    /// `att` is the per-sample attack increment, the poles come from `pole()`.
    #[inline]
    pub fn tick(&mut self, att: f32, dec: f32, sus: f32, rel: f32) -> f32 {
        match self.stage {
            Stage::Idle => {}
            Stage::Attack => {
                self.v += att;
                if self.v >= 1.0 {
                    self.v = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.v = sus + (self.v - sus) * dec;
                if (self.v - sus).abs() < 1e-4 {
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.v = sus,
            Stage::Release => {
                self.v *= rel;
                if self.v < 1e-4 {
                    self.v = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.v
    }
}

/// equal-power pan, unity at the centre
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let a = (pan.clamp(-1.0, 1.0) + 1.0) * PI * 0.25;
    (a.cos() * std::f32::consts::SQRT_2, a.sin() * std::f32::consts::SQRT_2)
}
