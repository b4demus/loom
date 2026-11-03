//! The project as the UI edits it and as `.loom` files store it (JSON).
//! The UI is the owner: every edit sends the whole project, the engine prepares a `Song` from it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Ticks per quarter note. A step of the channel rack is a 16th note.
pub const PPQ: u32 = 96;
pub const STEP: u32 = PPQ / 4;
pub const BAR: u32 = PPQ * 4;
pub const MAX_INPUT_CHANNELS: usize = 64;

/// Legacy 1/2/3 remain input 1/input 2/stereo 1+2. Extended selections address the rest
/// of an ASIO device without changing the format of existing projects.
pub fn input_route(code: u32) -> Option<(usize, usize, bool)> {
    match code {
        1 => Some((0, 0, false)),
        2 => Some((1, 1, false)),
        3 => Some((0, 1, true)),
        16..=79 => { let ch = (code - 16) as usize; Some((ch, ch, false)) }
        1024..=1086 => { let ch = (code - 1024) as usize; Some((ch, ch + 1, true)) }
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Project {
    pub version: u32,
    pub bpm: f64,
    pub master: f32,
    /// 0..1: how far every second 16th is pushed late (half a step at 1).
    pub swing: f32,
    pub channels: Vec<Channel>,
    pub patterns: Vec<Pattern>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    /// mixer tracks; 0 is the master. Empty in old projects: then the master is `master`.
    pub mixer: Vec<MixTrack>,
    /// every plugin instance the project uses (instruments and effects), by id
    pub plugins: Vec<PluginDesc>,
    /// Optional playlist time selection. Pattern playback ignores it.
    pub loop_region: Option<LoopRegion>,
    /// automation lanes of the playlist (song mode only)
    pub automation: Vec<AutoLane>,
    /// every mixer effect bypassed at once (a dry check of the mix)
    pub fx_off: bool,
    /// the piano roll's loop: pattern playback goes round inside it (song mode ignores it)
    pub pat_loop: Option<LoopRegion>,
}

/// Automation as in Ableton's arrangement: one lane per parameter, breakpoints on the playlist
/// timeline, straight or bent segments between them. Values are normalized 0..1 and mapped onto
/// the parameter by `auto_value` (the UI mirrors it in core.js).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AutoLane {
    pub id: u32,
    /// the playlist track the lane is shown under
    pub track: u32,
    pub target: AutoTarget,
    /// sorted by time; two points at one time make a jump
    pub points: Vec<AutoPoint>,
    /// false while a manual change overrides the lane, until automation is re-enabled
    pub on: bool,
}

impl Default for AutoLane {
    fn default() -> Self {
        Self { id: 0, track: 0, target: AutoTarget::MixVol { track: 0 }, points: vec![], on: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutoTarget {
    /// a mixer track's fader and pan (0 = master)
    MixVol { track: u32 },
    MixPan { track: u32 },
    /// a channel's fader and pan
    ChanVol { ch: u32 },
    ChanPan { ch: u32 },
    /// the dry/wet of an effect slot, by plugin id
    FxMix { pid: u32 },
    /// a plugin's own parameter (VST3 ParamID, VST2 index), normalized
    Param { pid: u32, param: u32 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(default)]
pub struct AutoPoint {
    /// ticks
    pub t: f64,
    /// 0..1
    pub v: f32,
    /// bend of the segment that starts here, -1..1; 0 is straight
    pub c: f32,
}

/// The lane's value at `t`: held before the first point and after the last.
pub fn lane_value(points: &[AutoPoint], t: f64) -> Option<f32> {
    let first = points.first()?;
    if t < first.t {
        return Some(first.v);
    }
    // the last point at or before t
    let i = points.partition_point(|p| p.t <= t) - 1;
    let a = points[i];
    let Some(b) = points.get(i + 1) else { return Some(a.v) };
    let x = ((t - a.t) / (b.t - a.t)).clamp(0.0, 1.0) as f32;
    Some(a.v + (b.v - a.v) * bend(x, a.c))
}

/// Segment shape: straight at 0, rising early towards 1, late towards -1.
pub fn bend(x: f32, c: f32) -> f32 {
    if c.abs() < 1e-3 { x } else { x.powf(2f32.powf(-c.clamp(-1.0, 1.0) * 3.0)) }
}

/// Gains for a sound placed at pan (-1..1) that leave it as it is in the middle.
pub fn balance(pan: f32) -> (f32, f32) {
    let p = pan.clamp(-1.0, 1.0);
    ((1.0 - p).min(1.0), (1.0 + p).min(1.0))
}

/// A fader at fader position `p` (0..1): the mixer's curve, 1.0 (0 dB) near 80%.
pub fn fader_vol(p: f32) -> f32 {
    p.clamp(0.0, 1.0).powf(2.2) * 1.25
}

/// A normalized lane value as the parameter's own value.
pub fn auto_value(target: AutoTarget, v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    match target {
        AutoTarget::MixVol { .. } => fader_vol(v),
        AutoTarget::ChanVol { .. } => v * 1.25,
        AutoTarget::MixPan { .. } | AutoTarget::ChanPan { .. } => v * 2.0 - 1.0,
        AutoTarget::FxMix { .. } | AutoTarget::Param { .. } => v,
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct LoopRegion {
    pub start: u32,
    pub end: u32,
    pub enabled: bool,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            version: 1, bpm: 130.0, master: 0.8, swing: 0.0, channels: vec![], patterns: vec![], tracks: vec![], clips: vec![],
            mixer: vec![], plugins: vec![], loop_region: None, automation: vec![], fx_off: false, pat_loop: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct MixTrack {
    pub name: String,
    pub vol: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub fx: Vec<FxSlot>,
    /// Live input selection; see input_route. 0 means no input.
    pub input: u32,
    /// Driver-provided name of the selected input, for display in the mixer.
    pub input_name: String,
    /// records when recording audio: the track's own sound (or its dry input, an app choice)
    pub arm: bool,
    /// the tracks this one plays into, after its fader (FL routing); the master by default.
    /// Empty: heard nowhere. Ignored for the master itself, which is the output.
    pub out: Vec<u32>,
    /// all of this track's effects bypassed
    pub fx_off: bool,
}

impl Default for MixTrack {
    fn default() -> Self {
        Self { name: String::new(), vol: 0.8, pan: 0.0, mute: false, solo: false, fx: vec![], input: 0, input_name: String::new(), arm: false, out: vec![0], fx_off: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(default)]
pub struct FxSlot {
    /// plugin instance id (Project::plugins)
    pub pid: u32,
    pub on: bool,
    /// dry/wet, 1 = fully processed
    pub mix: f32,
}

impl Default for FxSlot {
    fn default() -> Self {
        Self { pid: 0, on: true, mix: 1.0 }
    }
}

/// A plugin instance as the project stores it. The engine only sees ids; the app loads these.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct PluginDesc {
    pub id: u32,
    /// "vst2" | "vst3"
    pub format: String,
    pub path: String,
    /// VST3 class id (32 hex digits); VST2 unique id as decimal
    pub cid: String,
    pub name: String,
    pub vendor: String,
    pub instrument: bool,
    /// the plugin's own state, base64
    pub state: String,
    /// Manual editor values layered over the saved plugin state (also used by undo).
    pub params: std::collections::BTreeMap<u32, f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Channel {
    pub id: u32,
    pub name: String,
    pub vol: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// mixer track the channel plays into (0 = master)
    pub mix: u32,
    pub inst: Inst,
}

impl Default for Channel {
    fn default() -> Self {
        Self { id: 0, name: String::new(), vol: 0.8, pan: 0.0, mute: false, solo: false, mix: 0, inst: Inst::Sampler(SamplerParams::default()) }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Inst {
    Synth(SynthParams),
    Sampler(SamplerParams),
    /// an instrument plugin, by instance id
    Plugin(PluginInst),
    /// the sound of audio clips on the playlist
    Audio(AudioParams),
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(default)]
pub struct PluginInst {
    pub pid: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Wave {
    Sine,
    Tri,
    Saw,
    Square,
    Noise,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct SynthParams {
    pub osc1: Wave,
    pub osc2: Wave,
    /// osc 2 offset in semitones and cents
    pub semi2: f32,
    pub fine2: f32,
    /// 0 = only osc 1, 1 = only osc 2
    pub mix: f32,
    /// 0..1 → 20 Hz..20 kHz
    pub cutoff: f32,
    pub res: f32,
    /// filter envelope depth, -1..1 → ±8 octaves
    pub fenv: f32,
    pub fdecay: f32,
    pub a: f32,
    pub d: f32,
    pub s: f32,
    pub r: f32,
    pub gain: f32,
    /// 1 = mono with glide
    pub mono: bool,
    pub glide: f32,
}

impl Default for SynthParams {
    fn default() -> Self {
        Self {
            osc1: Wave::Saw, osc2: Wave::Square, semi2: 0.0, fine2: 7.0, mix: 0.4,
            cutoff: 0.62, res: 0.2, fenv: 0.3, fdecay: 0.3,
            a: 0.003, d: 0.3, s: 0.7, r: 0.18, gain: 0.5, mono: false, glide: 0.06,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct SamplerParams {
    /// "kit:<name>" for the built-in kit, otherwise the file name of `path`
    pub sample: String,
    pub path: Option<String>,
    /// the key that plays the sample at its own pitch
    pub root: u8,
    pub tune: f32,
    pub attack: f32,
    pub release: f32,
    /// play to the end and ignore the note length
    pub oneshot: bool,
    pub reverse: bool,
    /// a new note fades out the ones still sounding (hats)
    pub choke: bool,
    pub gain: f32,
}

impl Default for SamplerParams {
    fn default() -> Self {
        Self {
            sample: "kit:kick".into(), path: None, root: 60, tune: 0.0, attack: 0.0, release: 0.05,
            oneshot: true, reverse: false, choke: false, gain: 1.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Note {
    /// start and length in ticks, MIDI key, velocity 0..1
    pub t: u32,
    pub l: u32,
    pub k: u8,
    pub v: f32,
    /// pan of this note, -1..1 (built-in instruments; plugins get notes without it)
    #[serde(default)]
    pub p: f32,
    /// a slide note (FL): it starts no voice, the channel's sounding notes glide to its key over
    /// its length (built-in instruments)
    #[serde(default)]
    pub s: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Pattern {
    pub id: u32,
    pub name: String,
    /// shortest length in bars; notes past it make the pattern longer
    pub bars: u32,
    /// notes of every channel, keyed by channel id
    pub notes: BTreeMap<u32, Vec<Note>>,
}

impl Default for Pattern {
    fn default() -> Self {
        Self { id: 0, name: String::new(), bars: 1, notes: BTreeMap::new() }
    }
}

impl Pattern {
    /// Length in ticks: whole bars, at least `bars`, long enough for every note to start inside.
    /// The UI computes the same thing (core.js patLen).
    pub fn len(&self) -> u32 {
        let last = self.notes.values().flatten().map(|n| n.t + 1).max().unwrap_or(0);
        let bars = last.div_ceil(BAR).max(self.bars.max(1));
        bars * BAR
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Track {
    pub name: String,
    pub mute: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Clip {
    /// pattern id (pattern clips), playlist track index, start and length in ticks
    pub p: u32,
    pub track: u32,
    pub t: u32,
    pub l: u32,
    /// where in the pattern (or the audio) the clip starts, in ticks: trimmed from the left.
    /// For a stretched audio clip it is in the sound's own ticks (before `rate`), so it can
    /// be fractional after a cut.
    pub off: f64,
    /// audio clip: the id of the audio channel whose sound it plays (0 = a pattern clip).
    /// The channel's fader, pan, mute and mixer track apply to all its clips.
    pub ch: u32,
    /// silenced on its own (the playlist's mute tool)
    pub mute: bool,
    /// audio clip: how fast it runs through its sound (the stretch tool); 2 = twice as fast
    pub rate: f64,
    /// audio clip: its own volume (1 = as the sound is), and fades at its ends, in ticks
    pub gain: f32,
    pub fade_in: f64,
    pub fade_out: f64,
}

impl Default for Clip {
    fn default() -> Self {
        Self { p: 0, track: 0, t: 0, l: 0, off: 0.0, ch: 0, mute: false, rate: 1.0, gain: 1.0, fade_in: 0.0, fade_out: 0.0 }
    }
}

/// An audio channel: a sound the playlist plays as audio clips, at its own speed.
/// `sample` is "kit:<name>" for the kit, otherwise the file name of `path`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AudioParams {
    pub sample: String,
    pub path: Option<String>,
    /// a stretched clip changes pitch with its speed (resampling); otherwise its pitch stays
    pub stretch_pitch: bool,
    /// transposition in semitones, the length kept
    pub pitch: f32,
    /// the sound played backwards
    pub reverse: bool,
}
