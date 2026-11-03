//! What the engine knows about plugins: a stereo processor that may take notes.
//! The host crate wraps VST2/VST3 instances in this; tests use plain Rust ones.

/// a note event inside the current block
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MidiEv {
    pub frame: u32,
    pub key: u8,
    pub vel: f32,
    pub on: bool,
}

/// transport facts plugins ask for (tempo-synced delays, arpeggiators)
#[derive(Clone, Copy, Debug, Default)]
pub struct TimeInfo {
    pub playing: bool,
    pub bpm: f64,
    /// position at the block start, in quarter notes
    pub ppq: f64,
    /// position at the block start, in samples since play started
    pub frames: i64,
    pub sr: f32,
}

/// Live audio coming in (a sound card's inputs), read once per block. The engine sends it into
/// the mixer tracks that have an input set, so it is heard through their effects and faders.
pub trait InputSource: Send {
    /// Fills input 1 and input 2 for this block (a mono input fills both alike).
    /// False when nothing came in: the block then has no input.
    fn read(&mut self, in1: &mut [f32], in2: &mut [f32]) -> bool;
    /// Additional channels from the last read, without advancing the input again. Sources
    /// with only two channels can keep the default. The slices live until the next read.
    fn channel(&self, _index: usize) -> Option<&[f32]> { None }
}

/// Where an armed mixer track's own sound goes while the transport runs (a recording).
pub trait TapSink: Send {
    /// One block of the track after its fader; `tick` is where the block starts on the timeline.
    /// Called on the audio thread: it must not block or allocate.
    fn write(&mut self, l: &[f32], r: &[f32], tick: f64);
}

pub trait Processor: Send {
    /// `inp` and `out` are stereo and `n` frames long; effects read `inp`, instruments ignore it.
    /// `events` are sorted by frame.
    fn process(&mut self, inp: [&[f32]; 2], out: [&mut [f32]; 2], events: &[MidiEv], time: &TimeInfo);
    /// An automated parameter (normalized 0..1), applied from the next `process` on.
    fn set_param(&mut self, _id: u32, _value: f32) {}
}
