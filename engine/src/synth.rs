//! "tone": the built-in subtractive synth. Two band-limited oscillators, a resonant
//! lowpass with its own decay envelope, an ADSR amp, poly or mono with glide.

use crate::dsp::{blep, key_hz, pole, Adsr, Rng, Svf};
use crate::project::{SynthParams, Wave};

const VOICES: usize = 16;
/// filter and pitch are updated every CTRL samples
const CTRL: u32 = 16;

#[derive(Clone, Copy, Default)]
struct Voice {
    on: bool,
    held: bool,
    id: u32,
    age: u32,
    key: f32,
    pitch: f32,
    vel: f32,
    ph1: f32,
    ph2: f32,
    env: Adsr,
    fe: f32,
    svf: Svf,
    ctrl: u32,
    inc1: f32,
    inc2: f32,
    /// the note's pan as left/right gains
    pl: f32,
    pr: f32,
    /// a slide under way: semitones per sample and samples left
    slide: f32,
    slide_left: u32,
}

pub struct SynthRt {
    voices: [Voice; VOICES],
    next_id: u32,
    age: u32,
    rng: Rng,
    /// mono: the pitch the next glide starts from
    last_pitch: f32,
}

impl Default for SynthRt {
    fn default() -> Self {
        Self { voices: [Voice::default(); VOICES], next_id: 1, age: 0, rng: Rng(0x9e37_79b9), last_pitch: -1.0 }
    }
}

#[inline]
fn osc(w: Wave, ph: f32, dt: f32, rng: &mut Rng) -> f32 {
    match w {
        Wave::Sine => (ph * std::f32::consts::TAU).sin(),
        Wave::Tri => 1.0 - 4.0 * (ph - 0.5).abs(),
        Wave::Saw => 2.0 * ph - 1.0 - blep(ph, dt),
        Wave::Square => {
            let s = if ph < 0.5 { 1.0 } else { -1.0 };
            let ph2 = if ph < 0.5 { ph + 0.5 } else { ph - 0.5 };
            s + blep(ph, dt) - blep(ph2, dt)
        }
        Wave::Noise => rng.next(),
    }
}

impl SynthRt {
    pub fn note_on(&mut self, p: &SynthParams, key: u8, vel: f32, pan: f32) -> u32 {
        let (pl, pr) = crate::project::balance(pan);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.age = self.age.wrapping_add(1);
        let key = key as f32;
        if p.mono {
            // legato: a held voice slides to the new key and keeps its envelope
            if let Some(v) = self.voices.iter_mut().find(|v| v.on && v.held) {
                v.key = key;
                v.id = id;
                v.vel = vel;
                (v.pl, v.pr) = (pl, pr);
                v.age = self.age;
                return id;
            }
            for v in self.voices.iter_mut().filter(|v| v.on) {
                v.env.off();
            }
        }
        let slot = match self.voices.iter().position(|v| !v.on) {
            Some(i) => i,
            None => (0..VOICES).min_by_key(|&i| self.voices[i].age).unwrap(),
        };
        let start = if p.mono && self.last_pitch >= 0.0 { self.last_pitch } else { key };
        let v = &mut self.voices[slot];
        *v = Voice { on: true, held: true, id, age: self.age, key, pitch: start, vel, fe: 1.0, pl, pr, ..Voice::default() };
        v.env.on();
        id
    }

    /// A slide note: the held voices glide from where they are to key over rames samples.
    pub fn slide(&mut self, key: u8, frames: u32) {
        let frames = frames.max(1);
        for v in self.voices.iter_mut().filter(|v| v.on && v.held) {
            let to = key as f32;
            v.slide = (to - v.pitch) / frames as f32;
            v.slide_left = frames;
            v.key = to;
        }
        self.last_pitch = key as f32;
    }

    pub fn release(&mut self, id: u32) {
        for v in self.voices.iter_mut().filter(|v| v.on && v.id == id) {
            v.held = false;
            v.env.off();
        }
    }

    pub fn release_key(&mut self, key: u8) {
        for v in self.voices.iter_mut().filter(|v| v.on && v.held && v.key == key as f32) {
            v.held = false;
            v.env.off();
        }
    }

    pub fn release_all(&mut self) {
        for v in self.voices.iter_mut().filter(|v| v.on) {
            v.held = false;
            v.env.off();
        }
    }

    pub fn kill(&mut self) {
        for v in self.voices.iter_mut() {
            v.on = false;
        }
    }

    pub fn active(&self) -> usize {
        self.voices.iter().filter(|v| v.on).count()
    }

    /// Adds the voices into `l`/`r` (mono instrument: the same signal on both).
    pub fn render(&mut self, p: &SynthParams, l: &mut [f32], r: &mut [f32], sr: f32) {
        let att = 1.0 / (p.a.max(0.0005) * sr);
        let dec = pole(p.d, sr);
        let rel = pole(p.r.max(0.002), sr);
        let fdec = pole(p.fdecay.max(0.005), sr);
        let glide = if p.mono { pole(p.glide, sr * (1.0 / CTRL as f32)) } else { 0.0 };
        let off2 = p.semi2 + p.fine2 * 0.01;
        let base_oct = 10.0 * p.cutoff.clamp(0.0, 1.0); // octaves above 20 Hz
        let amp = p.gain * 0.6;
        let mix = p.mix.clamp(0.0, 1.0);
        let n = l.len();
        for v in self.voices.iter_mut().filter(|v| v.on) {
            for i in 0..n {
                if v.slide_left > 0 {
                    // a slide moves the pitch on every sample, straight to the slide note's key
                    v.pitch += v.slide;
                    v.slide_left -= 1;
                    if v.slide_left == 0 { v.pitch = v.key; }
                }
                if v.ctrl == 0 {
                    if v.slide_left == 0 {
                        v.pitch = if glide > 0.0 { v.key + (v.pitch - v.key) * glide } else { v.key };
                    }
                    v.inc1 = key_hz(v.pitch) / sr;
                    v.inc2 = key_hz(v.pitch + off2) / sr;
                    let oct = base_oct + p.fenv * 8.0 * v.fe + (v.pitch - 60.0) / 24.0;
                    let hz = (20.0 * oct.exp2()).clamp(20.0, sr * 0.45);
                    v.svf.set(hz, p.res, sr);
                }
                v.ctrl = (v.ctrl + 1) % CTRL;
                let a = osc(p.osc1, v.ph1, v.inc1, &mut self.rng);
                let b = osc(p.osc2, v.ph2, v.inc2, &mut self.rng);
                v.ph1 += v.inc1;
                if v.ph1 >= 1.0 {
                    v.ph1 -= 1.0;
                }
                v.ph2 += v.inc2;
                if v.ph2 >= 1.0 {
                    v.ph2 -= 1.0;
                }
                v.fe *= fdec;
                let (lp, _, _) = v.svf.tick(a + (b - a) * mix);
                let e = v.env.tick(att, dec, p.s, rel);
                let s = lp * e * v.vel * amp;
                l[i] += s * v.pl;
                r[i] += s * v.pr;
                if v.env.idle() {
                    v.on = false;
                    break;
                }
            }
            if p.mono {
                self.last_pitch = v.pitch;
            }
        }
    }
}
