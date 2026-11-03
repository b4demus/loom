//! loom's plugin host: VST2 (own ABI definitions) and VST3 (the `vst3` bindings), Windows only.
//!
//! Threading: an `Instance` is created, used and dropped on the UI thread (the plugin's
//! "main" thread). `Instance::processor` hands out a `Processor` for the audio thread; the
//! instance and its processors share one core, torn down when the last of them is dropped.
//! The app drops processors on the UI thread too, so teardown always happens there.

#![allow(non_snake_case)]

mod b64;
mod vst2;
mod vst3host;
pub mod window;

pub use b64::{decode as b64_decode, encode as b64_encode};
pub use loom_engine::plugin::Processor;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One plugin class found on disk.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PluginInfo {
    /// "vst2" | "vst3"
    pub format: String,
    pub path: String,
    /// VST3 class id (hex) or VST2 unique id (decimal)
    pub cid: String,
    pub name: String,
    pub vendor: String,
    pub instrument: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Setup {
    pub sr: f32,
    pub max_block: usize,
}

pub trait Instance {
    fn info(&self) -> &PluginInfo;
    /// a new audio-thread view of this instance
    fn processor(&mut self) -> Box<dyn Processor>;
    fn has_editor(&self) -> bool;
    /// opens (or brings forward) the plugin's own window, owned by `owner` (an HWND)
    fn open_editor(&mut self, owner: isize, title: &str) -> Result<(), String>;
    fn close_editor(&mut self);
    fn editor_open(&self) -> bool;
    fn get_state(&mut self) -> Vec<u8>;
    fn set_state(&mut self, data: &[u8]) -> Result<(), String>;
    /// new sample rate or block size: suspend, set up, resume
    fn reconfigure(&mut self, setup: Setup);
    /// the parameters that can be automated
    fn params(&mut self) -> Vec<ParamInfo>;
    /// All current values, including program/hidden parameters excluded from the automation menu.
    fn param_values(&mut self) -> std::collections::BTreeMap<u32, f32> {
        self.params().into_iter().filter(|p| p.value.is_finite()).map(|p| (p.id, p.value.clamp(0.0, 1.0))).collect()
    }
    /// shows an automated value (normalized) in the plugin's own window
    fn follow_param(&mut self, id: u32, value: f32);
    /// parameters the user grabbed in the plugin's window since the last call
    fn touched(&mut self) -> Vec<u32>;
    /// User gestures from the editor, independent of automation and audio processing.
    fn take_edits(&mut self) -> Vec<ParamEdit>;
    /// Restore a manual parameter value in both the editor and processor.
    fn set_param(&mut self, id: u32, value: f32);
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ParamEdit {
    Begin { id: u32 },
    Value { id: u32, value: f32 },
    End { id: u32 },
}

pub(crate) fn journal(queue: &std::sync::Mutex<Vec<ParamEdit>>, edit: ParamEdit) {
    if let Ok(mut q) = queue.lock() {
        if let (Some(ParamEdit::Value { id: old, value: v }), ParamEdit::Value { id, value }) = (q.last_mut(), &edit) {
            if old == id { *v = *value; return; }
        }
        if q.len() < 4096 { q.push(edit); }
    }
}

/// One automatable parameter: VST3 ParamID or VST2 index, its name, its default (0..1).
#[derive(Serialize, Clone, Debug)]
pub struct ParamInfo {
    pub id: u32,
    pub name: String,
    pub default: f32,
    pub value: f32,
}

/// Loads an instance on the calling (UI) thread.
pub fn load(info: &PluginInfo, setup: Setup) -> Result<Box<dyn Instance>, String> {
    match info.format.as_str() {
        "vst2" => vst2::load(info, setup).map(|i| Box::new(i) as Box<dyn Instance>),
        "vst3" => vst3host::load(info, setup).map(|i| Box::new(i) as Box<dyn Instance>),
        f => Err(format!("unknown plugin format {f}")),
    }
}

/// Reads the classes in one plugin file. Loads the module into this process, so the app
/// runs it in a child process (`loom --scan <file>`) to survive plugins that crash.
pub fn probe(path: &Path) -> Result<Vec<PluginInfo>, String> {
    let bin = if is_vst3(path) { vst3_binary(path) } else { path.to_path_buf() };
    if pe_machine(&bin) == Some(0x014c) {
        return Err("32-bit plugin: loom loads 64-bit plugins only".into());
    }
    if is_vst3(path) {
        vst3host::probe(path)
    } else {
        vst2::probe(path)
    }
}

fn is_vst3(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vst3"))
}

/// Standard plugin folders that exist on this machine.
pub fn default_folders() -> Vec<PathBuf> {
    let mut v = vec![];
    for var in ["CommonProgramFiles", "ProgramFiles"] {
        if let Ok(base) = std::env::var(var) {
            let base = PathBuf::from(base);
            v.push(base.join("VST3"));
            v.push(base.join("VSTPlugins"));
            v.push(base.join("Steinberg").join("VSTPlugins"));
            v.push(base.join("VST2"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        v.push(PathBuf::from(local).join("Programs").join("Common").join("VST3"));
    }
    v.retain(|p| p.is_dir());
    v.dedup();
    v
}

/// Every plugin file under `folders`: `.vst3` bundles or files, and `.dll` files (VST2).
/// A `.vst3` bundle is a folder: it counts as one file and is not searched inside.
pub fn find_files(folders: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = vec![];
    for f in folders {
        walk(f, 0, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext == "vst3" {
            out.push(p);
        } else if p.is_dir() {
            walk(&p, depth + 1, out);
        } else if ext == "dll" {
            out.push(p);
        }
    }
}

/// The binary inside a `.vst3` bundle, or the path itself for a single-file plugin.
pub(crate) fn vst3_binary(path: &Path) -> PathBuf {
    if path.is_dir() {
        let name = path.file_name().unwrap_or_default();
        path.join("Contents").join("x86_64-win").join(name)
    } else {
        path.to_path_buf()
    }
}

/// The machine field of a PE file's header (0x8664 x64, 0x014c x86), read without loading it.
fn pe_machine(path: &Path) -> Option<u16> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut b = [0u8; 4];
    f.seek(SeekFrom::Start(0x3c)).ok()?;
    f.read_exact(&mut b).ok()?;
    let pe = u32::from_le_bytes(b) as u64;
    f.seek(SeekFrom::Start(pe)).ok()?;
    let mut h = [0u8; 6];
    f.read_exact(&mut h).ok()?;
    (&h[..4] == b"PE\0\0").then(|| u16::from_le_bytes([h[4], h[5]]))
}

/// C string in a fixed array → String
pub(crate) fn cstr(b: &[std::ffi::c_char]) -> String {
    let bytes: Vec<u8> = b.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}
