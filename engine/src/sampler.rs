//! The sampler: plays a sample buffer pitched by key, with attack/release, one-shot,
//! reverse and choke.

use crate::dsp::pole;
use crate::project::SamplerParams;

const VOICES: usize = 16;

/// A decoded sample. Mono files keep `r` equal to `l`.
pub struct SampleBuf {
    pub l: Vec<f32>,
    pub r: Vec<f32>,
    pub sr: f32,
}

impl SampleBuf {
    pub fn len(&self) -> usize {
        self.l.len()
    }
    pub fn is_empty(&self) -> bool {
        self.l.is_empty()
    }
    pub fn seconds(&self) -> f32 {
        self.l.len() as f32 / self.sr
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Stage {
    #[default]
    Off,
    Attack,
    Hold,
    Release,
}

#[derive(Clone, Copy, Default)]
struct Voice {
    stage: Stage,
    held: bool,
    id: u32,
    age: u32,
    key: u8,
    vel: f32,
    pos: f64,
    rev: bool,
    env: f32,
    /// release pole override for choke (fast fade)
    fast: bool,
    /// the note's pan as left/right gains
    pl: f32,
    pr: f32,
    /// semitones off its key (a slide), how fast that moves and for how long
    bend: f32,
    bend_step: f32,
    bend_left: u32,
}

#[derive(Default)]
pub struct SamplerRt {
    voices: [Voice; VOICES],
    next_id: u32,
    age: u32,
}

#[inline]
fn hermite(d: &[f32], pos: f64) -> f32 {
    let i = pos as isize;
    let f = (pos - i as f64) as f32;
    let at = |k: isize| -> f32 {
        if k < 0 || k as usize >= d.len() {
            0.0
        } else {
            d[k as usize]
        }
    };
    let (xm, x0, x1, x2) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    let c1 = 0.5 * (x1 - xm);
    let c2 = xm - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    ((c3 * f + c2) * f + c1) * f + x0
}

impl SamplerRt {
    pub fn note_on(&mut self, p: &SamplerParams, buf: Option<&SampleBuf>, key: u8, vel: f32, pan: f32) -> u32 {
        let (pl, pr) = crate::project::balance(pan);
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.age = self.age.wrapping_add(1);
        let id = self.next_id;
        if p.choke {
            for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off) {
                v.stage = Stage::Release;
                v.fast = true;
            }
        }
        let slot = match self.voices.iter().position(|v| v.stage == Stage::Off) {
            Some(i) => i,
            None => (0..VOICES).min_by_key(|&i| self.voices[i].age).unwrap(),
        };
        let len = buf.map_or(0, |b| b.len());
        let rev = p.reverse;
        self.voices[slot] = Voice {
            stage: if p.attack > 0.0 { Stage::Attack } else { Stage::Hold },
            held: true,
            id,
            age: self.age,
            key,
            vel,
            pos: if rev { len as f64 - 1.0 } else { 0.0 },
            rev,
            env: if p.attack > 0.0 { 0.0 } else { 1.0 },
            fast: false,
            pl,
            pr,
            bend: 0.0,
            bend_step: 0.0,
            bend_left: 0,
        };
        id
    }

    /// A slide note: the held voices glide from where they are to key over rames samples.
    pub fn slide(&mut self, key: u8, frames: u32) {
        let frames = frames.max(1);
        for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off && v.held) {
            let target = key as f32 - v.key as f32;
            v.bend_step = (target - v.bend) / frames as f32;
            v.bend_left = frames;
        }
    }

    pub fn release(&mut self, p: &SamplerParams, id: u32) {
        for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off && v.id == id) {
            v.held = false;
            if !p.oneshot {
                v.stage = Stage::Release;
            }
        }
    }

    pub fn release_key(&mut self, p: &SamplerParams, key: u8) {
        for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off && v.held && v.key == key) {
            v.held = false;
            if !p.oneshot {
                v.stage = Stage::Release;
            }
        }
    }

    /// transport stop: everything fades out, one-shots too
    pub fn release_all(&mut self) {
        for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off) {
            v.held = false;
            v.stage = Stage::Release;
        }
    }

    pub fn kill(&mut self) {
        for v in self.voices.iter_mut() {
            v.stage = Stage::Off;
        }
    }

    pub fn active(&self) -> usize {
        self.voices.iter().filter(|v| v.stage != Stage::Off).count()
    }

    pub fn render(&mut self, p: &SamplerParams, buf: Option<&SampleBuf>, l: &mut [f32], r: &mut [f32], sr: f32) {
        let Some(b) = buf.filter(|b| !b.is_empty()) else {
            self.kill();
            return;
        };
        let att = 1.0 / (p.attack.max(0.0005) * sr);
        let rel = pole(p.release.max(0.003), sr);
        let fast = pole(0.012, sr);
        let last = b.len() as f64 - 1.0;
        for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off) {
            let (vkey, vrev) = (v.key as f32, v.rev);
            let rate = |bend: f32| {
                let s = (((vkey + bend - p.root as f32 + p.tune) / 12.0).exp2() * b.sr / sr) as f64;
                if vrev { -s } else { s }
            };
            let mut step = rate(v.bend);
            let g = v.vel * p.gain;
            for i in 0..l.len() {
                match v.stage {
                    Stage::Attack => {
                        v.env += att;
                        if v.env >= 1.0 {
                            v.env = 1.0;
                            v.stage = Stage::Hold;
                        }
                    }
                    Stage::Release => {
                        v.env *= if v.fast { fast } else { rel };
                        if v.env < 1e-4 {
                            v.stage = Stage::Off;
                            break;
                        }
                    }
                    _ => {}
                }
                if v.pos < 0.0 || v.pos > last {
                    v.stage = Stage::Off;
                    break;
                }
                let e = v.env * g;
                l[i] += hermite(&b.l, v.pos) * e * v.pl;
                r[i] += hermite(&b.r, v.pos) * e * v.pr;
                v.pos += step;
                if v.bend_left > 0 {
                    v.bend += v.bend_step;
                    v.bend_left -= 1;
                    step = rate(v.bend);
                }
            }
        }
    }
}
