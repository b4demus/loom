//! loom engine: everything that makes sound, with no UI and no audio device.

pub mod decode;
pub mod dsp;
pub mod engine;
pub mod kit;
pub mod plugin;
pub mod project;
pub mod render;
pub mod sampler;
pub mod stretch;
pub mod synth;

pub use engine::{Engine, Mode, Shared, Song};
pub use project::Project;

use sampler::SampleBuf;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// Resolves sampler channels to buffers: the built-in kit, or files decoded once and kept.
#[derive(Default)]
pub struct SampleCache {
    files: HashMap<PathBuf, Option<Arc<SampleBuf>>>,
    /// backwards copies for reversed audio channels, by file path or "kit:<name>"
    reversed: HashMap<String, Arc<SampleBuf>>,
}

impl SampleCache {
    /// The sound of a sampler or audio channel. `reverse` asks for it backwards (audio channels;
    /// samplers play their own buffer backwards and ask for it as it is).
    pub fn get(&mut self, p: &project::SamplerParams) -> Option<Arc<SampleBuf>> {
        let fwd = if let Some(path) = &p.path {
            let path = PathBuf::from(path);
            self.files.entry(path.clone()).or_insert_with(|| decode::load(&path).ok().map(Arc::new)).clone()
        } else {
            p.sample.strip_prefix("kit:").and_then(kit::get)
        }?;
        if !p.reverse {
            return Some(fwd);
        }
        let key = p.path.clone().unwrap_or_else(|| p.sample.clone());
        Some(self.reversed.entry(key).or_insert_with(|| {
            let rev = |v: &Vec<f32>| v.iter().rev().copied().collect();
            Arc::new(SampleBuf { l: rev(&fwd.l), r: rev(&fwd.r), sr: fwd.sr })
        }).clone())
    }

    /// Loads a file now so the caller can report errors.
    pub fn load(&mut self, path: &str) -> Result<Arc<SampleBuf>, String> {
        let buf = Arc::new(decode::load(std::path::Path::new(path))?);
        self.files.insert(PathBuf::from(path), Some(buf.clone()));
        self.reversed.remove(path);
        Ok(buf)
    }

    pub fn build(&mut self, p: &Project) -> Song {
        Song::build(p, &mut |sp| self.get(sp))
    }
}
