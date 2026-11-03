//! The real-time engine: transport, sample-accurate sequencer, instruments, plugins and the mixer.
//!
//! The UI sends whole projects; `Song::build` turns one into flat, pre-sorted data off the
//! audio thread, together with fresh channel runtimes. `Engine::set_song` swaps it in without
//! allocating: channels that kept their id keep their runtime (voices ring on), and the old
//! song comes back to the caller so it is dropped off the audio thread.
//!
//! Signal flow: channel → its fader and pan → mixer track `mix` → effect slots → track fader and
//! pan → master (track 0) → master effects → master fader → soft clip.
//! Plugin processors live in a table indexed by plugin id; they come and go through
//! `add_plugin`/`remove_plugin`, which hand the old box back so it is freed off the audio thread.

use crate::dsp::pan_gains;
use crate::plugin::{InputSource, MidiEv, Processor, TapSink, TimeInfo};
use crate::project::{auto_value, lane_value, AutoPoint, AutoTarget, Inst, Note, Project, SamplerParams, BAR, PPQ, STEP};
use crate::sampler::{SampleBuf, SamplerRt};
use crate::synth::SynthRt;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

pub const MAX_BLOCK: usize = 512;
pub const MAX_CH: usize = 256;
pub const MAX_MIX: usize = 64;
pub const MAX_PLUGINS: usize = 512;
pub const MAX_FX: usize = 10;
const PENDING: usize = 128;
const PLUG_EVS: usize = 256;
/// swing never moves a note by more than half a step
const SWING_MAX: u32 = STEP / 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// loop one pattern (by id)
    Pattern(u32),
    /// play the playlist
    Song,
}

pub struct ChanInfo {
    pub id: u32,
    pub vol: f32,
    pub pan: f32,
    pub audible: bool,
    pub mix: usize,
    pub inst: Inst,
    pub sample: Option<Arc<SampleBuf>>,
}

pub struct MixInfo {
    pub vol: f32,
    pub pan: f32,
    pub audible: bool,
    /// live input heard through the track (MixTrack::input)
    pub input: u32,
    /// (plugin id, dry/wet) of the slots that are on
    pub fx: Vec<(u32, f32)>,
    /// the tracks it plays into (never itself; loops are cut when the song is built)
    pub out: Vec<usize>,
}

pub struct PatInfo {
    pub id: u32,
    pub len: u32,
    /// notes per channel index, sorted by start
    pub notes: Vec<Vec<Note>>,
}

pub struct ClipInfo {
    pub pat: usize,
    pub t: u32,
    pub l: u32,
    pub off: u32,
}

/// An audio clip on the playlist: plays its channel's sound from `off` for `l` ticks, at its own
/// speed, through that channel's fader and pan into its mixer track.
pub struct AudioInfo {
    pub t: u32,
    pub l: u32,
    /// in the sound's own ticks
    pub off: f64,
    /// channel index
    pub ci: usize,
    /// speed through the sound (stretch); 1 plays it as it is
    pub rate: f64,
    /// how fast its grains read the sound: the pitch (1 = as recorded). When it equals `rate`
    /// the sound is simply resampled; otherwise WSOLA grains keep time and pitch apart.
    pub speed: f64,
    /// its own volume and its fades, in ticks
    pub gain: f32,
    pub fade_in: f64,
    pub fade_out: f64,
    grains: crate::stretch::Grains,
}

/// What an automation lane drives, resolved to indices into the song.
#[derive(Clone, Copy, Debug)]
enum AutoRt {
    MixVol(usize),
    MixPan(usize),
    ChanVol(usize),
    ChanPan(usize),
    /// mixer track, index into its `fx`
    FxMix(usize, usize),
    Param(u32, u32),
}

/// An automation lane in song mode: each block writes its value into the song's live values,
/// which the mix then ramps to like any fader move; plugin parameters go to the processor.
pub struct AutoInfo {
    rt: AutoRt,
    target: AutoTarget,
    points: Vec<AutoPoint>,
    /// last value sent to a plugin, so an unchanged lane sends nothing
    sent: f32,
}

/// A stretch of one audio clip inside the current block.
#[derive(Clone, Copy)]
struct AudioSeg {
    clip: u16,
    frame: u32,
    n: u32,
    /// timeline position of the first frame, in ticks
    tick: f64,
}

/// fade at the edges of audio clips, so a cut never clicks
const AUDIO_FADE: f64 = 0.003;

/// The metronome's click: a short sine ping, higher and louder on the first beat of a bar.
#[derive(Clone, Copy, Default)]
struct Click {
    /// samples left
    left: u32,
    phase: f32,
    inc: f32,
    amp: f32,
    env: f32,
    decay: f32,
}

/// a click due at `frame` of the current block
#[derive(Clone, Copy)]
struct ClickEv {
    frame: u32,
    accent: bool,
}

/// note events for a plugin instrument, collected over a block and handed over in one call
struct PlugRt {
    evs: [MidiEv; PLUG_EVS],
    nev: usize,
    /// sounding notes: (note id, key)
    held: [(u32, u8); PENDING],
    nheld: usize,
    next_id: u32,
    frame: u32,
}

impl Default for PlugRt {
    fn default() -> Self {
        let ev = MidiEv { frame: 0, key: 0, vel: 0.0, on: false };
        Self { evs: [ev; PLUG_EVS], nev: 0, held: [(0, 0); PENDING], nheld: 0, next_id: 1, frame: 0 }
    }
}

impl PlugRt {
    fn push(&mut self, key: u8, vel: f32, on: bool) {
        if self.nev < PLUG_EVS {
            self.evs[self.nev] = MidiEv { frame: self.frame, key, vel, on };
            self.nev += 1;
        }
    }
    fn note_on(&mut self, key: u8, vel: f32) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        if self.nheld < PENDING {
            self.held[self.nheld] = (id, key);
            self.nheld += 1;
        }
        self.push(key, vel, true);
        id
    }
    fn release(&mut self, id: u32) {
        if let Some(i) = self.held[..self.nheld].iter().position(|h| h.0 == id) {
            let key = self.held[i].1;
            self.nheld -= 1;
            self.held[i] = self.held[self.nheld];
            self.push(key, 0.0, false);
        }
    }
    fn release_key(&mut self, key: u8) {
        let mut i = 0;
        while i < self.nheld {
            if self.held[i].1 == key {
                self.nheld -= 1;
                self.held[i] = self.held[self.nheld];
                self.push(key, 0.0, false);
            } else {
                i += 1;
            }
        }
    }
    fn release_all(&mut self) {
        for i in 0..self.nheld {
            let key = self.held[i].1;
            self.push(key, 0.0, false);
        }
        self.nheld = 0;
    }
}

enum InstRt {
    Synth(SynthRt),
    Sampler(SamplerRt),
    Plugin(Box<PlugRt>),
    /// audio channels have no voices: their clips are rendered from the sequencer's segments
    Audio,
}

#[derive(Clone, Copy, Default)]
struct Pending {
    id: u32,
    at: u64,
}

pub struct ChanRt {
    inst: InstRt,
    pending: [Pending; PENDING],
    npending: usize,
    gl: f32,
    gr: f32,
    fresh: bool,
}

impl ChanRt {
    fn new(inst: &Inst) -> Self {
        Self { inst: InstRt::for_inst(inst), pending: [Pending::default(); PENDING], npending: 0, gl: 0.0, gr: 0.0, fresh: true }
    }
}

impl InstRt {
    /// Plugin runtimes are boxed: Song::build makes them, the audio thread only swaps them.
    fn for_inst(inst: &Inst) -> Self {
        match inst {
            Inst::Synth(_) => InstRt::Synth(SynthRt::default()),
            Inst::Sampler(_) => InstRt::Sampler(SamplerRt::default()),
            Inst::Plugin(_) => InstRt::Plugin(Box::default()),
            Inst::Audio(_) => InstRt::Audio,
        }
    }
    fn matches(&self, inst: &Inst) -> bool {
        matches!(
            (self, inst),
            (InstRt::Synth(_), Inst::Synth(_)) | (InstRt::Sampler(_), Inst::Sampler(_)) | (InstRt::Plugin(_), Inst::Plugin(_)) | (InstRt::Audio, Inst::Audio(_))
        )
    }
    fn note_on(&mut self, c: &ChanInfo, key: u8, vel: f32, pan: f32) -> u32 {
        match (self, &c.inst) {
            (InstRt::Synth(s), Inst::Synth(p)) => s.note_on(p, key, vel, pan),
            (InstRt::Sampler(s), Inst::Sampler(p)) => s.note_on(p, c.sample.as_deref(), key, vel, pan),
            (InstRt::Plugin(s), _) => s.note_on(key, vel),
            _ => 0,
        }
    }
    fn slide(&mut self, key: u8, frames: u32) {
        match self {
            InstRt::Synth(s) => s.slide(key, frames),
            InstRt::Sampler(s) => s.slide(key, frames),
            _ => {}
        }
    }
    fn release(&mut self, c: &ChanInfo, id: u32) {
        match (self, &c.inst) {
            (InstRt::Synth(s), _) => s.release(id),
            (InstRt::Sampler(s), Inst::Sampler(p)) => s.release(p, id),
            (InstRt::Plugin(s), _) => s.release(id),
            _ => {}
        }
    }
    fn release_key(&mut self, c: &ChanInfo, key: u8) {
        match (self, &c.inst) {
            (InstRt::Synth(s), _) => s.release_key(key),
            (InstRt::Sampler(s), Inst::Sampler(p)) => s.release_key(p, key),
            (InstRt::Plugin(s), _) => s.release_key(key),
            _ => {}
        }
    }
    fn release_all(&mut self) {
        match self {
            InstRt::Synth(s) => s.release_all(),
            InstRt::Sampler(s) => s.release_all(),
            InstRt::Plugin(s) => s.release_all(),
            InstRt::Audio => {}
        }
    }
    fn kill(&mut self) {
        match self {
            InstRt::Synth(s) => s.kill(),
            InstRt::Sampler(s) => s.kill(),
            InstRt::Plugin(s) => s.release_all(),
            InstRt::Audio => {}
        }
    }
    fn active(&self) -> usize {
        match self {
            InstRt::Synth(s) => s.active(),
            InstRt::Sampler(s) => s.active(),
            InstRt::Plugin(s) => s.nheld,
            InstRt::Audio => 0,
        }
    }
    fn render(&mut self, c: &ChanInfo, l: &mut [f32], r: &mut [f32], sr: f32) {
        match (self, &c.inst) {
            (InstRt::Synth(s), Inst::Synth(p)) => s.render(p, l, r, sr),
            (InstRt::Sampler(s), Inst::Sampler(p)) => s.render(p, c.sample.as_deref(), l, r, sr),
            // plugins render the whole block at once, after their events are collected
            _ => {}
        }
    }
}

pub struct Song {
    pub bpm: f64,
    pub swing: f32,
    pub chans: Vec<ChanInfo>,
    /// mixer tracks, 0 is the master; never empty
    pub mix: Vec<MixInfo>,
    pub pats: Vec<PatInfo>,
    pub clips: Vec<ClipInfo>,
    pub audio: Vec<AudioInfo>,
    /// playlist length in ticks, whole bars
    pub song_len: u32,
    pub loop_region: Option<(f64, f64)>,
    /// the piano roll's loop, for pattern playback
    pub pat_loop: Option<(f64, f64)>,
    pub autos: Vec<AutoInfo>,
    /// mixer tracks in processing order: each before the tracks it feeds, the master last
    pub order: Vec<usize>,
    rts: Vec<ChanRt>,
}

impl Song {
    /// `sample` resolves a sampler channel to its buffer (kit or a loaded file).
    pub fn build(p: &Project, sample: &mut dyn FnMut(&SamplerParams) -> Option<Arc<SampleBuf>>) -> Song {
        let mut mix: Vec<MixInfo> = if p.mixer.is_empty() {
            vec![MixInfo { vol: p.master.clamp(0.0, 1.5), pan: 0.0, audible: true, input: 0, fx: vec![], out: vec![] }]
        } else {
            let n = p.mixer.len().min(MAX_MIX);
            p.mixer.iter().take(MAX_MIX).enumerate().map(|(i, m)| MixInfo {
                vol: m.vol.clamp(0.0, 1.5),
                pan: m.pan.clamp(-1.0, 1.0),
                audible: i == 0 || !m.mute,
                input: if crate::project::input_route(m.input).is_some() { m.input } else { 0 },
                // the track's or the whole mixer's processing switched off: the slots pass through
                fx: if p.fx_off || m.fx_off { vec![] } else { m.fx.iter().filter(|f| f.on && (f.pid as usize) < MAX_PLUGINS).take(MAX_FX).map(|f| (f.pid, f.mix.clamp(0.0, 1.0))).collect() },
                out: if i == 0 { vec![] } else {
                    let mut o: Vec<usize> = m.out.iter().map(|&d| d as usize).filter(|&d| d < n && d != i).collect();
                    o.sort_unstable();
                    o.dedup();
                    o
                },
            }).collect()
        };
        let order = route_order(&mut mix);
        // Solo, through the routing: a soloed insert keeps sounding with everything that plays
        // into it and everything it plays into; other inserts go quiet. The master always sounds.
        let soloed: Vec<usize> = p.mixer.iter().take(mix.len()).enumerate().filter(|(i, m)| *i > 0 && m.solo).map(|(i, _)| i).collect();
        if !soloed.is_empty() {
            let n = mix.len();
            let mut keep = vec![false; n];
            keep[0] = true;
            for &s in &soloed {
                // downstream
                let mut stack = vec![s];
                while let Some(i) = stack.pop() {
                    if !keep[i] { keep[i] = true; }
                    stack.extend(mix[i].out.iter().copied().filter(|&d| !keep[d]));
                }
                // upstream
                let mut stack = vec![s];
                let mut seen = vec![false; n];
                while let Some(i) = stack.pop() {
                    if seen[i] { continue; }
                    seen[i] = true;
                    keep[i] = true;
                    stack.extend((0..n).filter(|&j| mix[j].out.contains(&i)));
                }
            }
            for (i, m) in mix.iter_mut().enumerate() {
                m.audible &= keep[i];
            }
        }
        let nmix = mix.len();
        let solo = p.channels.iter().any(|c| c.solo);
        let chans: Vec<ChanInfo> = p.channels.iter().take(MAX_CH).map(|c| ChanInfo {
            id: c.id,
            vol: c.vol.clamp(0.0, 1.25),
            pan: c.pan.clamp(-1.0, 1.0),
            audible: !c.mute && (!solo || c.solo),
            mix: (c.mix as usize).min(nmix - 1),
            sample: match &c.inst {
                // a sampler reverses on its own: it always gets the sound as it is
                Inst::Sampler(sp) => sample(&SamplerParams { reverse: false, ..sp.clone() }),
                Inst::Audio(a) => sample(&SamplerParams { sample: a.sample.clone(), path: a.path.clone(), reverse: a.reverse, ..Default::default() }),
                _ => None,
            },
            inst: c.inst.clone(),
        }).collect();
        let pats: Vec<PatInfo> = p.patterns.iter().map(|pat| PatInfo {
            id: pat.id,
            len: pat.len(),
            notes: chans.iter().map(|c| {
                let mut v = pat.notes.get(&c.id).cloned().unwrap_or_default();
                v.retain(|n| n.l > 0);
                v.sort_by_key(|n| n.t);
                v
            }).collect(),
        }).collect();
        let muted = |c: &crate::project::Clip| c.mute || p.tracks.get(c.track as usize).is_some_and(|t| t.mute);
        let clips: Vec<ClipInfo> = p.clips.iter().filter(|c| c.ch == 0).filter_map(|c| {
            let pat = pats.iter().position(|x| x.id == c.p)?;
            (!muted(c) && c.l > 0).then_some(ClipInfo { pat, t: c.t, l: c.l, off: c.off.max(0.0).round() as u32 })
        }).collect();
        // audio clips of audio channels that have a sound
        let audio: Vec<AudioInfo> = p.clips.iter().filter(|c| c.ch != 0 && !muted(c) && c.l > 0).filter_map(|c| {
            let ci = chans.iter().position(|x| x.id == c.ch)?;
            let Inst::Audio(ap) = &chans[ci].inst else { return None };
            let rate = if c.rate.is_finite() && c.rate > 0.0 { c.rate.clamp(0.05, 20.0) } else { 1.0 };
            // pitch: the transposition, times the rate when stretching changes pitch (a record)
            let transpose = 2f64.powf(ap.pitch.clamp(-48.0, 48.0) as f64 / 12.0);
            let speed = transpose * if ap.stretch_pitch { rate } else { 1.0 };
            let fade = |x: f64| if x.is_finite() { x.clamp(0.0, c.l as f64) } else { 0.0 };
            chans[ci].sample.is_some().then(|| AudioInfo {
                t: c.t, l: c.l, off: c.off.max(0.0), ci, rate, speed,
                gain: if c.gain.is_finite() { c.gain.clamp(0.0, 4.0) } else { 1.0 },
                fade_in: fade(c.fade_in), fade_out: fade(c.fade_out), grains: Default::default(),
            })
        }).take(u16::MAX as usize).collect();
        let end = p.clips.iter().map(|c| c.t + c.l).max().unwrap_or(0);
        let song_len = end.div_ceil(BAR).max(1) * BAR;
        let rts = chans.iter().map(|c| ChanRt::new(&c.inst)).collect();
        let loop_region = p.loop_region.filter(|r| r.enabled && r.end > r.start).map(|r| (r.start as f64, r.end as f64));
        // lanes that are on and have points; a target that is gone is skipped
        let autos = p.automation.iter().filter(|a| a.on && !a.points.is_empty()).filter_map(|a| {
            let chan = |id: u32| chans.iter().position(|c| c.id == id);
            let track = |t: u32| ((t as usize) < mix.len()).then_some(t as usize);
            let rt = match a.target {
                AutoTarget::MixVol { track: t } => AutoRt::MixVol(track(t)?),
                AutoTarget::MixPan { track: t } => AutoRt::MixPan(track(t)?),
                AutoTarget::ChanVol { ch } => AutoRt::ChanVol(chan(ch)?),
                AutoTarget::ChanPan { ch } => AutoRt::ChanPan(chan(ch)?),
                AutoTarget::FxMix { pid } => mix.iter().enumerate().find_map(|(ti, m)| m.fx.iter().position(|f| f.0 == pid).map(|k| AutoRt::FxMix(ti, k)))?,
                AutoTarget::Param { pid, param } => ((pid as usize) < MAX_PLUGINS).then_some(AutoRt::Param(pid, param))?,
            };
            let mut points = a.points.clone();
            points.retain(|x| x.t.is_finite());
            points.sort_by(|x, y| x.t.total_cmp(&y.t));
            Some(AutoInfo { rt, target: a.target, points, sent: f32::NAN })
        }).collect();
        let pat_loop = p.pat_loop.filter(|r| r.enabled && r.end > r.start).map(|r| (r.start as f64, r.end as f64));
        Song { bpm: p.bpm.clamp(10.0, 999.0), swing: p.swing.clamp(0.0, 1.0), chans, mix, pats, clips, audio, song_len, loop_region, pat_loop, autos, order, rts }
    }

    pub fn chan_index(&self, id: u32) -> Option<usize> {
        self.chans.iter().position(|c| c.id == id)
    }
}

/// The order mixer tracks are processed in: every track before the tracks it plays into, the
/// master (0) last. A route that would close a loop is dropped (the UI never makes one).
fn route_order(mix: &mut [MixInfo]) -> Vec<usize> {
    fn visit(i: usize, mix: &mut [MixInfo], state: &mut [u8], post: &mut Vec<usize>) {
        state[i] = 1;
        let outs = std::mem::take(&mut mix[i].out);
        let mut keep = Vec::with_capacity(outs.len());
        for d in outs {
            // a track still being visited: this route would loop back
            if state[d] == 1 {
                continue;
            }
            keep.push(d);
            if state[d] == 0 {
                visit(d, mix, state, post);
            }
        }
        mix[i].out = keep;
        state[i] = 2;
        post.push(i);
    }
    let n = mix.len();
    let mut state = vec![0u8; n];
    let mut post = Vec::with_capacity(n);
    // from the lowest track up: of a loop, the route back to a lower track is the one dropped
    for i in 0..n {
        if state[i] == 0 {
            visit(i, mix, &mut state, &mut post);
        }
    }
    post.reverse();
    // the master is the output: it goes last whatever else happens
    post.retain(|&i| i != 0);
    post.push(0);
    post
}

/// What the UI reads back without locking: position, transport, levels.
pub struct Shared {
    pub pos: AtomicU64,
    pub playing: AtomicBool,
    pub master: [AtomicU32; 2],
    pub peaks: Vec<AtomicU32>,
    /// per mixer track, left and right interleaved
    pub mix_peaks: Vec<AtomicU32>,
    pub voices: AtomicU32,
    /// share of the block time the last callback took, ×1000
    pub load: AtomicU32,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            pos: AtomicU64::new(0f64.to_bits()),
            playing: AtomicBool::new(false),
            master: [AtomicU32::new(0), AtomicU32::new(0)],
            peaks: (0..MAX_CH).map(|_| AtomicU32::new(0)).collect(),
            mix_peaks: (0..MAX_MIX * 2).map(|_| AtomicU32::new(0)).collect(),
            voices: AtomicU32::new(0),
            load: AtomicU32::new(0),
        }
    }
}

impl Shared {
    /// Peak since the last read (the reader resets it).
    pub fn take_peak(a: &AtomicU32) -> f32 {
        f32::from_bits(a.swap(0, Ordering::Relaxed))
    }
    pub fn pos(&self) -> f64 {
        f64::from_bits(self.pos.load(Ordering::Relaxed))
    }
}

fn store_peak(a: &AtomicU32, v: f32) {
    let old = f32::from_bits(a.load(Ordering::Relaxed));
    if v > old {
        a.store(v.to_bits(), Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
struct Ev {
    ch: u16,
    frame: u32,
    key: u8,
    vel: f32,
    pan: f32,
    len: u32,
    /// a slide note: glides the sounding notes instead of starting one
    slide: bool,
}

/// stereo buffers of one mixer track
struct Bus {
    l: Vec<f32>,
    r: Vec<f32>,
    gl: f32,
    gr: f32,
    /// not played yet: start at the track's level instead of ramping to it
    fresh: bool,
}

pub struct Engine {
    pub sr: f32,
    song: Box<Song>,
    playing: bool,
    pos: f64,
    start_pos: f64,
    mode: Mode,
    clock: u64,
    /// frames since play was pressed, for plugin time info
    play_frames: i64,
    evs: Vec<Ev>,
    asegs: Vec<AudioSeg>,
    bl: Vec<f32>,
    br: Vec<f32>,
    tl: Vec<f32>,
    tr: Vec<f32>,
    silence: Vec<f32>,
    bus: Vec<Bus>,
    plugins: Vec<Option<Box<dyn Processor>>>,
    preview: Option<(Arc<SampleBuf>, f64)>,
    metronome: bool,
    click: Click,
    clicks: Vec<ClickEv>,
    /// count-in before the transport starts, in ticks: total and still to go
    count_total: f64,
    count_left: f64,
    started: Option<u64>,
    input: Option<Box<dyn InputSource>>,
    in1: Vec<f32>,
    in2: Vec<f32>,
    /// the input straight into the master (recording with no track armed)
    monitor_master: bool,
    /// armed mixer tracks being recorded: (track, where their sound goes)
    taps: Vec<(usize, Box<dyn TapSink>)>,
    /// recording over a playlist loop: the transport stops at the loop's end instead of going round
    stop_at_end: bool,
    /// the app's own output volume, after everything (not the master track, never exported)
    out_gain: f32,
    out_g: f32,
    pub shared: Arc<Shared>,
}

impl Engine {
    pub fn new(sr: f32, song: Box<Song>, shared: Arc<Shared>) -> Self {
        let mode = Mode::Pattern(song.pats.first().map_or(0, |p| p.id));
        Self {
            sr, song, playing: false, pos: 0.0, start_pos: 0.0, mode, clock: 0, play_frames: 0,
            evs: Vec::with_capacity(4096),
            asegs: Vec::with_capacity(512),
            bl: vec![0.0; MAX_BLOCK], br: vec![0.0; MAX_BLOCK], tl: vec![0.0; MAX_BLOCK], tr: vec![0.0; MAX_BLOCK],
            silence: vec![0.0; MAX_BLOCK],
            bus: (0..MAX_MIX).map(|_| Bus { l: vec![0.0; MAX_BLOCK], r: vec![0.0; MAX_BLOCK], gl: 0.0, gr: 0.0, fresh: true }).collect(),
            plugins: (0..MAX_PLUGINS).map(|_| None).collect(),
            preview: None,
            metronome: false,
            click: Click::default(),
            clicks: Vec::with_capacity(64),
            count_total: 0.0,
            count_left: 0.0,
            started: None,
            input: None,
            in1: vec![0.0; MAX_BLOCK],
            in2: vec![0.0; MAX_BLOCK],
            monitor_master: false,
            taps: Vec::new(),
            stop_at_end: false,
            out_gain: 1.0,
            out_g: 1.0,
            shared,
        }
    }

    /// Mixer tracks to record (their sound after the fader, while the transport runs); the old
    /// sinks come back so they are finished off the audio thread.
    pub fn set_taps(&mut self, taps: Vec<(usize, Box<dyn TapSink>)>) -> Vec<(usize, Box<dyn TapSink>)> {
        std::mem::replace(&mut self.taps, taps)
    }

    /// While on, a song played over an enabled playlist loop stops at the loop's end, once, instead
    /// of wrapping (a take recorded over the loop ends there).
    pub fn set_stop_at_loop_end(&mut self, on: bool) {
        self.stop_at_end = on;
    }

    /// The app's output volume (1 = 100%): the speakers, not the song.
    pub fn set_output_gain(&mut self, g: f32) {
        self.out_gain = if g.is_finite() { g.clamp(0.0, 1.5) } else { 1.0 };
    }

    /// The live input; the previous one comes back to be freed off the audio thread.
    pub fn set_input(&mut self, src: Option<Box<dyn InputSource>>) -> Option<Box<dyn InputSource>> {
        std::mem::replace(&mut self.input, src)
    }

    /// Hear the input in the master even though no track has it.
    pub fn set_monitor_master(&mut self, on: bool) {
        self.monitor_master = on;
    }

    /// Clicks on every beat while the transport runs. Straight to the output: the master
    /// fader does not touch it, and offline renders never have it on.
    pub fn set_metronome(&mut self, on: bool) {
        self.metronome = on;
    }

    pub fn set_song(&mut self, mut new: Box<Song>) -> Box<Song> {
        for i in 0..new.chans.len() {
            if let Some(j) = self.song.chans.iter().position(|c| c.id == new.chans[i].id) {
                if self.song.rts[j].fresh {
                    continue;
                }
                std::mem::swap(&mut new.rts[i], &mut self.song.rts[j]);
                self.song.rts[j].fresh = true;
            }
        }
        std::mem::replace(&mut self.song, new)
    }

    /// Puts a processor in slot `id`; the previous one (if any) comes back to be freed.
    pub fn add_plugin(&mut self, id: u32, p: Box<dyn Processor>) -> Option<Box<dyn Processor>> {
        let slot = self.plugins.get_mut(id as usize)?;
        slot.replace(p)
    }

    pub fn remove_plugin(&mut self, id: u32) -> Option<Box<dyn Processor>> {
        self.plugins.get_mut(id as usize)?.take()
    }

    /// One-shot preview of a sample straight into the master (the browser); None stops it.
    /// The previous buffer comes back so it is freed off the audio thread.
    pub fn preview(&mut self, buf: Option<Arc<SampleBuf>>) -> Option<Arc<SampleBuf>> {
        std::mem::replace(&mut self.preview, buf.map(|b| (b, 0.0))).map(|p| p.0)
    }

    pub fn song(&self) -> &Song {
        &self.song
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, m: Mode) {
        if m != self.mode {
            self.mode = m;
            self.start_pos = 0.0;
            if self.playing {
                // the new loop starts where it starts: a fresh pattern from its first step
                self.pos = 0.0;
                self.release_all();
            }
        }
    }

    pub fn playing(&self) -> bool {
        self.playing
    }

    pub fn play(&mut self) {
        // during a count-in the transport starts by itself when it ends
        if self.count_left > 0.0 {
            return;
        }
        if !self.playing {
            self.play_frames = 0;
            self.started = Some(self.clock);
        }
        self.playing = true;
    }

    /// Play after `bars` bars of metronome clicks (for recording); 0 bars is a plain play.
    /// The clicks sound whether or not the metronome is on.
    pub fn play_count_in(&mut self, bars: u32) {
        if bars == 0 || self.playing || self.count_left > 0.0 {
            self.play();
            return;
        }
        self.count_total = (bars * BAR) as f64;
        self.count_left = self.count_total;
    }

    pub fn stop(&mut self) {
        self.playing = false;
        self.count_left = 0.0;
        self.pos = self.start_pos;
        self.release_all();
    }

    /// The engine clock (frames rendered since it started).
    pub fn clock(&self) -> u64 {
        self.clock
    }

    /// The clock frame where the transport last really started (after any count-in), once:
    /// the audio callback turns it into a wall-clock time for lining up recordings.
    pub fn take_started(&mut self) -> Option<u64> {
        self.started.take()
    }

    pub fn set_pos(&mut self, ticks: f64) {
        self.pos = if ticks.is_finite() { ticks.max(0.0) } else { 0.0 };
        self.start_pos = self.pos;
        if self.playing {
            self.release_all();
        }
    }

    pub fn position(&self) -> f64 {
        self.pos
    }

    fn release_all(&mut self) {
        for rt in self.song.rts.iter_mut() {
            if let InstRt::Plugin(p) = &mut rt.inst {
                p.frame = 0;
            }
            rt.inst.release_all();
            rt.npending = 0;
        }
    }

    pub fn panic(&mut self) {
        for rt in self.song.rts.iter_mut() {
            if let InstRt::Plugin(p) = &mut rt.inst {
                p.frame = 0;
            }
            rt.inst.kill();
            rt.npending = 0;
        }
        self.preview = None;
    }

    /// preview from the UI (piano roll keys, new notes): plays now, held until `note_off`
    pub fn note_on(&mut self, ch: u32, key: u8, vel: f32) {
        if let Some(i) = self.song.chan_index(ch) {
            let song = &mut *self.song;
            let rt = &mut song.rts[i];
            if !rt.inst.matches(&song.chans[i].inst) {
                return;
            }
            rt.fresh = false;
            if let InstRt::Plugin(p) = &mut rt.inst {
                p.frame = 0;
            }
            rt.inst.note_on(&song.chans[i], key, vel, 0.0);
        }
    }

    pub fn note_off(&mut self, ch: u32, key: u8) {
        if let Some(i) = self.song.chan_index(ch) {
            let song = &mut *self.song;
            if let InstRt::Plugin(p) = &mut song.rts[i].inst {
                p.frame = 0;
            }
            song.rts[i].inst.release_key(&song.chans[i], key);
        }
    }

    /// the loop the transport runs in, in ticks
    pub fn loop_range(&self) -> (f64, f64) {
        match self.mode {
            Mode::Song => self.song.loop_region.unwrap_or((0.0, self.song.song_len as f64)),
            Mode::Pattern(id) => {
                // the piano roll's loop, when one is on
                if let Some(r) = self.song.pat_loop {
                    return r;
                }
                let len = self.song.pats.iter().find(|p| p.id == id).map_or(BAR, |p| p.len);
                (0.0, len as f64)
            }
        }
    }

    pub fn ticks_per_frame(&self) -> f64 {
        self.song.bpm * PPQ as f64 / (60.0 * self.sr as f64)
    }

    pub fn active_voices(&self) -> usize {
        self.song.rts.iter().map(|r| r.inst.active()).sum()
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let mut i = 0;
        while i < n {
            let m = (n - i).min(MAX_BLOCK);
            self.block(&mut l[i..i + m], &mut r[i..i + m]);
            i += m;
        }
        self.shared.pos.store(self.pos.to_bits(), Ordering::Relaxed);
        self.shared.playing.store(self.playing, Ordering::Relaxed);
        self.shared.voices.store(self.active_voices() as u32, Ordering::Relaxed);
    }

    fn block(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let time = TimeInfo {
            playing: self.playing,
            bpm: self.song.bpm,
            ppq: self.pos / PPQ as f64,
            frames: self.play_frames,
            sr: self.sr,
        };
        self.evs.clear();
        self.asegs.clear();
        self.clicks.clear();
        let tpf = self.ticks_per_frame();
        // count-in: clicks on its beats, the transport waits; it starts mid-block when it ends
        let mut from = 0usize;
        if self.count_left > 0.0 {
            let done = self.count_total - self.count_left;
            // the epsilon keeps rounding error from pushing the start one frame late
            let to_end = ((self.count_left / tpf - 1e-6).ceil() as usize).max(1);
            let span = n.min(to_end);
            let mut b = (done / PPQ as f64).ceil() * PPQ as f64;
            while b < done + span as f64 * tpf && b < self.count_total && self.clicks.len() < self.clicks.capacity() {
                let f = (((b - done) / tpf).ceil().max(0.0) as usize).min(span - 1);
                self.clicks.push(ClickEv { frame: f as u32, accent: (b as u32) % BAR == 0 });
                b += PPQ as f64;
            }
            if to_end > n {
                self.count_left -= n as f64 * tpf;
                from = n;
            } else {
                self.count_left = 0.0;
                self.playing = true;
                self.play_frames = 0;
                self.started = Some(self.clock + to_end as u64);
                from = to_end;
            }
        }
        // where the block starts on the timeline (recordings of mixer tracks start from it)
        let pos0 = self.pos;
        if self.playing && from < n {
            self.sequence(from, n);
            self.play_frames += (n - from) as i64;
        }
        // the playlist's automation at the block's end: faders ramp to it over the block
        if self.mode == Mode::Song {
            self.automate();
        }
        // per channel in time; at one frame the notes start before a slide moves them
        self.evs.sort_unstable_by_key(|e| (e.ch, e.frame, e.slide));
        let nmix = self.song.mix.len();
        for b in self.bus.iter_mut().take(nmix) {
            b.l[..n].fill(0.0);
            b.r[..n].fill(0.0);
        }

        let sr = self.sr;
        let clock = self.clock;
        let sec_per_tick = 60.0 / (self.song.bpm * PPQ as f64);
        let song = &mut *self.song;
        let mut e = 0;
        for (ci, rt) in song.rts.iter_mut().enumerate() {
            let c = &song.chans[ci];
            if !rt.inst.matches(&c.inst) {
                // only built-in instruments can be made here: a plugin runtime is boxed
                if matches!(c.inst, Inst::Plugin(_)) {
                    continue;
                }
                rt.inst = InstRt::for_inst(&c.inst);
                rt.npending = 0;
            }
            let was_fresh = std::mem::replace(&mut rt.fresh, false);
            let bl = &mut self.bl[..n];
            let br = &mut self.br[..n];
            bl.fill(0.0);
            br.fill(0.0);
            while e < self.evs.len() && (self.evs[e].ch as usize) < ci {
                e += 1;
            }
            let mut f = 0usize;
            loop {
                let next_on = if e < self.evs.len() && self.evs[e].ch as usize == ci { self.evs[e].frame as usize } else { n };
                let next_off = rt.pending[..rt.npending].iter().map(|p| p.at.saturating_sub(clock) as usize).min().unwrap_or(n);
                let next = next_on.min(next_off).min(n).max(f);
                if next > f {
                    rt.inst.render(c, &mut bl[f..next], &mut br[f..next], sr);
                    f = next;
                }
                if f >= n {
                    break;
                }
                if let InstRt::Plugin(p) = &mut rt.inst {
                    p.frame = f as u32;
                }
                // note-offs first: a note that ends where the next one starts must not cut it
                let now = clock + f as u64;
                let mut k = 0;
                while k < rt.npending {
                    if rt.pending[k].at <= now {
                        let id = rt.pending[k].id;
                        rt.inst.release(c, id);
                        rt.npending -= 1;
                        rt.pending[k] = rt.pending[rt.npending];
                    } else {
                        k += 1;
                    }
                }
                while e < self.evs.len() && self.evs[e].ch as usize == ci && self.evs[e].frame as usize <= f {
                    let ev = self.evs[e];
                    if ev.slide {
                        rt.inst.slide(ev.key, ev.len);
                        e += 1;
                        continue;
                    }
                    let id = rt.inst.note_on(c, ev.key, ev.vel, ev.pan);
                    if rt.npending == PENDING {
                        // full: end the oldest early rather than leaving a note stuck
                        let (oi, _) = rt.pending.iter().enumerate().min_by_key(|(_, p)| p.at).unwrap();
                        let old = rt.pending[oi].id;
                        rt.inst.release(c, old);
                        rt.pending[oi] = rt.pending[PENDING - 1];
                        rt.npending -= 1;
                    }
                    rt.pending[rt.npending] = Pending { id, at: now + ev.len as u64 };
                    rt.npending += 1;
                    e += 1;
                }
            }

            // a plugin instrument gets the block's notes in one go
            if let (InstRt::Plugin(p), Inst::Plugin(pi)) = (&mut rt.inst, &c.inst) {
                let evs = &mut p.evs[..p.nev];
                evs.sort_by_key(|x| x.frame);
                if let Some(Some(proc_)) = self.plugins.get_mut(pi.pid as usize) {
                    let sil = &self.silence[..n];
                    proc_.process([sil, sil], [bl, br], evs, &time);
                }
                p.nev = 0;
            }

            // an audio channel plays the stretches of its clips that fall in this block: resampled
            // at its rate, or (pitch kept) through WSOLA grains
            if let (Inst::Audio(_), Some(buf)) = (&c.inst, &c.sample) {
                let sps = sec_per_tick * buf.sr as f64;
                let glen = crate::stretch::grain_len(buf.sr);
                for s in self.asegs.iter() {
                    let a = &mut song.audio[s.clip as usize];
                    if a.ci != ci {
                        continue;
                    }
                    let end = (a.t + a.l) as f64;
                    let base = a.off * sps;
                    for j in 0..s.n as usize {
                        let tick = s.tick + j as f64 * tpf;
                        // time since the clip's start, in source samples at normal speed
                        let o = (tick - a.t as f64) * sps;
                        let (x, y) = if (a.speed - a.rate).abs() > 1e-9 {
                            crate::stretch::sample(buf, &mut a.grains, base, o, a.rate, a.speed, glen)
                        } else {
                            crate::stretch::read(buf, base + o * a.rate)
                        };
                        // a few ms of fade at the clip's edges (a cut never clicks), its own fades, its volume
                        let (from_start, to_end) = (tick - a.t as f64, end - tick);
                        let mut g = ((from_start.min(to_end)) * sec_per_tick / AUDIO_FADE).clamp(0.0, 1.0) as f32 * a.gain;
                        if a.fade_in > 0.0 && from_start < a.fade_in { g *= (from_start / a.fade_in).clamp(0.0, 1.0) as f32; }
                        if a.fade_out > 0.0 && to_end < a.fade_out { g *= (to_end / a.fade_out).clamp(0.0, 1.0) as f32; }
                        let fr = s.frame as usize + j;
                        bl[fr] += x * g;
                        br[fr] += y * g;
                    }
                }
            }

            // fader and pan, ramped over the block, into the channel's mixer track
            let (tl, tr) = pan_gains(c.pan);
            let (tl, tr) = if c.audible { (tl * c.vol, tr * c.vol) } else { (0.0, 0.0) };
            if was_fresh {
                // a new channel starts at its level, not faded in from silence
                (rt.gl, rt.gr) = (tl, tr);
            }
            let (dl, dr) = ((tl - rt.gl) / n as f32, (tr - rt.gr) / n as f32);
            let bus = &mut self.bus[c.mix];
            let mut peak = 0f32;
            for j in 0..n {
                rt.gl += dl;
                rt.gr += dr;
                let (a, b) = (bl[j] * rt.gl, br[j] * rt.gr);
                bus.l[j] += a;
                bus.r[j] += b;
                peak = peak.max(a.abs()).max(b.abs());
            }
            rt.gl = tl;
            rt.gr = tr;
            store_peak(&self.shared.peaks[ci], peak);
        }

        // browser preview goes straight to the master
        if let Some((buf, pos)) = &mut self.preview {
            let step = (buf.sr / sr) as f64;
            let m = &mut self.bus[0];
            for j in 0..n {
                let i = *pos as usize;
                if i >= buf.len() {
                    break;
                }
                m.l[j] += buf.l[i] * 0.8;
                m.r[j] += buf.r[i] * 0.8;
                *pos += step;
            }
        }

        // live input into the tracks that listen to it, ahead of their effects
        if let Some(src) = self.input.as_mut() {
            let (a, b) = (&mut self.in1[..n], &mut self.in2[..n]);
            if src.read(a, b) {
                for (ti, info) in song.mix.iter().enumerate() {
                    let mode = if ti == 0 && info.input == 0 && self.monitor_master { 3 } else { info.input };
                    let Some((left, right, _)) = crate::project::input_route(mode) else { continue };
                    let sample = |channel: usize, frame: usize| {
                        if let Some(samples) = src.channel(channel) { samples.get(frame).copied().unwrap_or(0.0) }
                        else { match channel { 0 => a[frame], 1 => b[frame], _ => 0.0 } }
                    };
                    let bus = &mut self.bus[ti];
                    for j in 0..n {
                        let (x, y) = (sample(left, j), sample(right, j));
                        bus.l[j] += x;
                        bus.r[j] += y;
                    }
                }
            }
        }

        // inserts: effects, fader, pan, then into the tracks they feed (the master by default),
        // each track before the ones it plays into; the master is the output
        let tapping = self.playing && !self.taps.is_empty();
        for &ti in &song.order {
            let info = &song.mix[ti];
            let bus = &mut self.bus[ti];
            for &(pid, wet) in &info.fx {
                if let Some(Some(proc_)) = self.plugins.get_mut(pid as usize) {
                    let (tl, tr) = (&mut self.tl[..n], &mut self.tr[..n]);
                    tl.fill(0.0);
                    tr.fill(0.0);
                    proc_.process([&bus.l[..n], &bus.r[..n]], [tl, tr], &[], &time);
                    for j in 0..n {
                        bus.l[j] += (tl[j] - bus.l[j]) * wet;
                        bus.r[j] += (tr[j] - bus.r[j]) * wet;
                    }
                }
            }
            let (pl, pr) = pan_gains(info.pan);
            let (gl, gr) = if info.audible { (pl * info.vol, pr * info.vol) } else { (0.0, 0.0) };
            if std::mem::replace(&mut bus.fresh, false) {
                (bus.gl, bus.gr) = (gl, gr);
            }
            let (dl, dr) = ((gl - bus.gl) / n as f32, (gr - bus.gr) / n as f32);
            let (mut ml, mut mr) = (0f32, 0f32);
            for j in 0..n {
                bus.gl += dl;
                bus.gr += dr;
                let (a, b) = (bus.l[j] * bus.gl, bus.r[j] * bus.gr);
                if ti == 0 {
                    // no limiter: the master may go past 0 dB (the meters read up to +6), like FL;
                    // only the device boundary clips
                    out_l[j] = a;
                    out_r[j] = b;
                    ml = ml.max(out_l[j].abs());
                    mr = mr.max(out_r[j].abs());
                } else {
                    self.tl[j] = a;
                    self.tr[j] = b;
                    ml = ml.max(a.abs());
                    mr = mr.max(b.abs());
                }
            }
            bus.gl = gl;
            bus.gr = gr;
            if ti != 0 {
                for &d in &info.out {
                    let dst = &mut self.bus[d];
                    for j in 0..n {
                        dst.l[j] += self.tl[j];
                        dst.r[j] += self.tr[j];
                    }
                }
            }
            // an armed track's own sound, after its fader, into its recording
            if tapping {
                // from where the transport ran in this block (a count-in can end mid-block)
                let (l, r) = if ti == 0 { (&out_l[from..n], &out_r[from..n]) } else { (&self.tl[from..n], &self.tr[from..n]) };
                for (t, sink) in self.taps.iter_mut() {
                    if *t == ti {
                        sink.write(l, r, pos0);
                    }
                }
            }
            store_peak(&self.shared.mix_peaks[ti * 2], ml);
            store_peak(&self.shared.mix_peaks[ti * 2 + 1], mr);
            if ti == 0 {
                store_peak(&self.shared.master[0], ml);
                store_peak(&self.shared.master[1], mr);
            }
        }

        // metronome, after the master
        let mut ci = 0;
        for j in 0..n {
            while ci < self.clicks.len() && self.clicks[ci].frame as usize == j {
                let accent = self.clicks[ci].accent;
                let hz = if accent { 1760.0 } else { 1320.0 };
                self.click = Click {
                    left: (0.04 * sr) as u32,
                    phase: 0.0,
                    inc: hz / sr,
                    amp: if accent { 0.32 } else { 0.2 },
                    env: 1.0,
                    decay: (-1.0 / (0.008 * sr)).exp(),
                };
                ci += 1;
            }
            let c = &mut self.click;
            if c.left > 0 {
                let s = (c.phase * std::f32::consts::TAU).sin() * c.env * c.amp;
                c.phase = (c.phase + c.inc).fract();
                c.env *= c.decay;
                c.left -= 1;
                out_l[j] += s;
                out_r[j] += s;
            }
        }
        // the app's volume knob, ramped
        if self.out_g != 1.0 || self.out_gain != 1.0 {
            let d = (self.out_gain - self.out_g) / n as f32;
            for j in 0..n {
                self.out_g += d;
                out_l[j] *= self.out_g;
                out_r[j] *= self.out_g;
            }
            self.out_g = self.out_gain;
        }
        self.clock += n as u64;
    }

    /// Writes every lane's value at the playhead into the song (stopped too, so a seek shows it).
    fn automate(&mut self) {
        let t = self.pos;
        let Song { autos, mix, chans, .. } = &mut *self.song;
        for a in autos.iter_mut() {
            let Some(v) = lane_value(&a.points, t) else { continue };
            let x = auto_value(a.target, v);
            match a.rt {
                AutoRt::MixVol(i) => mix[i].vol = x,
                AutoRt::MixPan(i) => mix[i].pan = x,
                AutoRt::ChanVol(i) => chans[i].vol = x,
                AutoRt::ChanPan(i) => chans[i].pan = x,
                AutoRt::FxMix(i, k) => mix[i].fx[k].1 = x,
                AutoRt::Param(pid, id) => {
                    if a.sent != x {
                        if let Some(Some(p)) = self.plugins.get_mut(pid as usize) {
                            p.set_param(id, x);
                            a.sent = x;
                        }
                    }
                }
            }
        }
    }

    /// Walk the transport over frames `from..n` and queue the notes that start in them.
    fn sequence(&mut self, from: usize, n: usize) {
        let tpf = self.ticks_per_frame();
        let mut frame = from;
        let mut wrapped = false;
        while frame < n {
            let (ls, mut le) = self.loop_range();
            // With no time selection the playlist is a free timeline, including empty space.
            // Pattern playback keeps looping; an enabled playlist selection loops exactly there.
            if self.mode == Mode::Song && self.song.loop_region.is_none() { le = f64::INFINITY; }
            if self.pos >= le || self.pos < ls {
                self.pos = ls;
                wrapped = true;
            }
            let to_end = (((le - self.pos) / tpf).ceil() as usize).max(1);
            let seg = (n - frame).min(to_end);
            let b = self.pos + seg as f64 * tpf;
            // right after a wrap the window opens at the loop start, so notes on it are not skipped
            let wa = if wrapped { ls } else { self.pos };
            self.gather(wa, b.min(le), self.pos, frame, seg, tpf);
            wrapped = false;
            self.pos = b;
            frame += seg;
            if self.pos >= le {
                if self.stop_at_end && self.mode == Mode::Song && self.song.loop_region.is_some() {
                    // the take ends with the loop: the transport stops right on its end
                    self.pos = le;
                    self.playing = false;
                    self.stop_at_end = false;
                    self.release_all();
                    break;
                }
                self.pos = ls + (self.pos - le);
                wrapped = true;
            }
        }
    }

    fn gather(&mut self, wa: f64, wb: f64, pos: f64, base: usize, seg: usize, tpf: f64) {
        if wb <= wa {
            return;
        }
        // metronome: every beat that starts in the window; the loop restarts on a bar line
        if self.metronome {
            let mut b = (wa / PPQ as f64).ceil() * PPQ as f64;
            while b < wb && self.clicks.len() < self.clicks.capacity() {
                let f = ((b - pos) / tpf).ceil().max(0.0) as usize;
                self.clicks.push(ClickEv { frame: (base + f.min(seg - 1)) as u32, accent: (b as u32) % BAR == 0 });
                b += PPQ as f64;
            }
        }
        let song = &*self.song;
        let swing = (song.swing * SWING_MAX as f32) as u32;
        let evs = &mut self.evs;
        // pattern-local window [a, b) of pattern `pi`, placed on the timeline at `shift`
        let mut emit = |pi: usize, a: f64, b: f64, shift: f64| {
            let pat = &song.pats[pi];
            let lo = (a - swing as f64).max(0.0) as u32;
            for (ci, notes) in pat.notes.iter().enumerate() {
                let start = notes.partition_point(|x| x.t < lo);
                for nt in &notes[start..] {
                    if nt.t as f64 >= b {
                        break;
                    }
                    let swung = if swing > 0 && (nt.t / STEP) % 2 == 1 { (nt.t + swing).min(pat.len - 1) } else { nt.t };
                    let st = swung as f64;
                    if st < a || st >= b {
                        continue;
                    }
                    let at = shift + st;
                    let f = ((at - pos) / tpf).ceil().max(0.0) as usize;
                    if evs.len() < evs.capacity() {
                        evs.push(Ev {
                            ch: ci as u16,
                            frame: (base + f.min(seg - 1)) as u32,
                            key: nt.k,
                            vel: nt.v.clamp(0.0, 1.0),
                            pan: if nt.p.is_finite() { nt.p.clamp(-1.0, 1.0) } else { 0.0 },
                            slide: nt.s,
                            len: ((nt.l as f64 / tpf).round() as u32).max(1),
                        });
                    }
                }
            }
        };
        match self.mode {
            Mode::Pattern(id) => {
                if let Some(pi) = song.pats.iter().position(|p| p.id == id) {
                    emit(pi, wa, wb, 0.0);
                }
            }
            Mode::Song => {
                // audio clips: which frames of this window each one covers
                for (ai, a) in song.audio.iter().enumerate() {
                    let (x0, x1) = (wa.max(a.t as f64), wb.min((a.t + a.l) as f64));
                    if x1 <= x0 || self.asegs.len() == self.asegs.capacity() {
                        continue;
                    }
                    let f0 = (((x0 - pos) / tpf).ceil().max(0.0) as usize).min(seg);
                    let f1 = (((x1 - pos) / tpf).ceil().max(0.0) as usize).min(seg);
                    if f1 > f0 {
                        self.asegs.push(AudioSeg { clip: ai as u16, frame: (base + f0) as u32, n: (f1 - f0) as u32, tick: pos + f0 as f64 * tpf });
                    }
                }
                for c in &song.clips {
                    let (x0, x1) = (wa.max(c.t as f64), wb.min((c.t + c.l) as f64));
                    if x1 <= x0 {
                        continue;
                    }
                    // clip time → pattern time; a clip longer than its pattern repeats it
                    let len = song.pats[c.pat].len as f64;
                    let origin = c.t as f64 - c.off as f64;
                    let (l0, l1) = (x0 - origin, x1 - origin);
                    let mut k = (l0 / len).floor();
                    while k * len < l1 {
                        let (a, b) = ((l0 - k * len).max(0.0), (l1 - k * len).min(len));
                        if b > a {
                            emit(c.pat, a, b, origin + k * len);
                        }
                        k += 1.0;
                    }
                }
            }
        }
    }
}
