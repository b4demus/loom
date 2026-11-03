//! VST 2.4 hosting. Steinberg no longer licenses the VST2 SDK; the binary interface below is
//! written from the publicly documented ABI (AEffect layout, dispatcher and host opcodes), the
//! same ground community headers such as VeSTige and FST cover. Nothing of the SDK is used.

use crate::window::{self, Events};
use crate::{cstr, journal, Instance, ParamEdit, ParamInfo, PluginInfo, Setup};
use libloading::Library;
use loom_engine::plugin::{MidiEv, Processor, TimeInfo};
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr};
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

type Dispatcher = unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type HostCallback = unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type Entry = unsafe extern "C" fn(HostCallback) -> *mut AEffect;

#[repr(C)]
struct AEffect {
    magic: i32,
    dispatcher: Option<Dispatcher>,
    _process: usize,
    set_parameter: Option<unsafe extern "C" fn(*mut AEffect, i32, f32)>,
    get_parameter: Option<unsafe extern "C" fn(*mut AEffect, i32) -> f32>,
    num_programs: i32,
    num_params: i32,
    num_inputs: i32,
    num_outputs: i32,
    flags: i32,
    /// reserved for the host: loom keeps its `HostData` here
    resvd1: isize,
    resvd2: isize,
    initial_delay: i32,
    _real_qualities: i32,
    _off_qualities: i32,
    _io_ratio: f32,
    _object: *mut c_void,
    _user: *mut c_void,
    unique_id: i32,
    _version: i32,
    process_replacing: Option<unsafe extern "C" fn(*mut AEffect, *const *const f32, *mut *mut f32, i32)>,
    _process_double: usize,
    _future: [u8; 56],
}

const MAGIC: i32 = 0x5673_7450; // 'VstP'
const FLAG_EDITOR: i32 = 1;
const FLAG_REPLACING: i32 = 1 << 4;
const FLAG_CHUNKS: i32 = 1 << 5;
const FLAG_SYNTH: i32 = 1 << 8;

// dispatcher opcodes
const EFF_OPEN: i32 = 0;
const EFF_CLOSE: i32 = 1;
const EFF_SET_SAMPLE_RATE: i32 = 10;
const EFF_SET_BLOCK_SIZE: i32 = 11;
const EFF_MAINS_CHANGED: i32 = 12;
const EFF_GET_PARAM_NAME: i32 = 8;
const EFF_EDIT_GET_RECT: i32 = 13;
const EFF_EDIT_OPEN: i32 = 14;
const EFF_EDIT_CLOSE: i32 = 15;
const EFF_EDIT_IDLE: i32 = 19;
const EFF_GET_CHUNK: i32 = 23;
const EFF_SET_CHUNK: i32 = 24;
const EFF_PROCESS_EVENTS: i32 = 25;
const EFF_GET_PLUG_CATEGORY: i32 = 35;
const EFF_GET_EFFECT_NAME: i32 = 45;
const EFF_GET_VENDOR_STRING: i32 = 47;
const EFF_GET_PRODUCT_STRING: i32 = 48;
const EFF_START_PROCESS: i32 = 71;
const EFF_STOP_PROCESS: i32 = 72;
const EFF_SET_PROCESS_PRECISION: i32 = 77;
const CATEGORY_SYNTH: isize = 2;

// host opcodes
const AM_AUTOMATE: i32 = 0;
const AM_VERSION: i32 = 1;
const AM_IDLE: i32 = 3;
const AM_WANT_MIDI: i32 = 6;
const AM_GET_TIME: i32 = 7;
const AM_SIZE_WINDOW: i32 = 15;
const AM_GET_SAMPLE_RATE: i32 = 16;
const AM_GET_BLOCK_SIZE: i32 = 17;
const AM_GET_PROCESS_LEVEL: i32 = 23;
const AM_GET_AUTOMATION_STATE: i32 = 24;
const AM_GET_VENDOR_STRING: i32 = 32;
const AM_GET_PRODUCT_STRING: i32 = 33;
const AM_GET_VENDOR_VERSION: i32 = 34;
const AM_CAN_DO: i32 = 37;
const AM_GET_LANGUAGE: i32 = 38;
const AM_UPDATE_DISPLAY: i32 = 42;
const AM_BEGIN_EDIT: i32 = 43;
const AM_END_EDIT: i32 = 44;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct VstTimeInfo {
    sample_pos: f64,
    sample_rate: f64,
    nano_seconds: f64,
    ppq_pos: f64,
    tempo: f64,
    bar_start_pos: f64,
    cycle_start_pos: f64,
    cycle_end_pos: f64,
    time_sig_numerator: i32,
    time_sig_denominator: i32,
    smpte_offset: i32,
    smpte_frame_rate: i32,
    samples_to_next_clock: i32,
    flags: i32,
}
const TIME_PLAYING: i32 = 1 << 1;
const TIME_PPQ_VALID: i32 = 1 << 9;
const TIME_TEMPO_VALID: i32 = 1 << 10;
const TIME_BARS_VALID: i32 = 1 << 11;
const TIME_SIG_VALID: i32 = 1 << 13;

#[repr(C)]
#[derive(Clone, Copy)]
struct VstMidiEvent {
    kind: i32,
    byte_size: i32,
    delta_frames: i32,
    flags: i32,
    note_length: i32,
    note_offset: i32,
    midi_data: [u8; 4],
    detune: i8,
    note_off_velocity: u8,
    _reserved1: u8,
    _reserved2: u8,
}

const MAX_EVENTS: usize = 256;

#[repr(C)]
struct VstEvents {
    num_events: i32,
    _reserved: isize,
    events: [*mut VstMidiEvent; MAX_EVENTS],
}

/// What the host callback needs to answer a plugin, reached through `AEffect::resvd1`.
struct HostData {
    sr: AtomicU32,
    block: AtomicU32,
    /// written by the audio thread before each process call, read back by the plugin
    time: RefCell<VstTimeInfo>,
    editor: AtomicIsize,
    /// parameters the user grabbed in the plugin's window (audioMasterBeginEdit)
    touched: Mutex<Vec<u32>>,
    journal: Mutex<Vec<ParamEdit>>,
}

unsafe extern "C" fn host_cb(effect: *mut AEffect, op: i32, index: i32, value: isize, ptr: *mut c_void, _opt: f32) -> isize {
    let hd = if effect.is_null() || (*effect).resvd1 == 0 { None } else { Some(&*((*effect).resvd1 as *const HostData)) };
    let copy = |s: &str| {
        if !ptr.is_null() {
            let b = s.as_bytes();
            let n = b.len().min(63);
            std::ptr::copy_nonoverlapping(b.as_ptr(), ptr as *mut u8, n);
            *(ptr as *mut u8).add(n) = 0;
        }
        1
    };
    match op {
        AM_VERSION => 2400,
        AM_IDLE => 0,
        AM_AUTOMATE => {
            if let Some(h) = hd.filter(|_| index >= 0 && _opt.is_finite()) {
                journal(&h.journal, ParamEdit::Value { id: index as u32, value: _opt.clamp(0.0, 1.0) });
                if let Ok(mut t) = h.touched.lock() {
                    if !t.contains(&(index as u32)) && t.len() < 256 { t.push(index as u32); }
                }
            }
            0
        }
        AM_WANT_MIDI => 1,
        AM_GET_TIME => hd.map_or(0, |h| h.time.as_ptr() as isize),
        AM_SIZE_WINDOW => {
            if let Some(h) = hd {
                let hwnd = h.editor.load(Ordering::Relaxed);
                if window::alive(hwnd) {
                    window::set_client_size(hwnd, index, value as i32);
                    return 1;
                }
            }
            0
        }
        AM_GET_SAMPLE_RATE => hd.map_or(44100, |h| f32::from_bits(h.sr.load(Ordering::Relaxed)) as isize),
        AM_GET_BLOCK_SIZE => hd.map_or(512, |h| h.block.load(Ordering::Relaxed) as isize),
        AM_GET_PROCESS_LEVEL => 0,
        AM_GET_AUTOMATION_STATE => 1,
        AM_GET_VENDOR_STRING => copy("b4demus"),
        AM_GET_PRODUCT_STRING => copy("loom"),
        AM_GET_VENDOR_VERSION => 100,
        AM_CAN_DO => {
            if ptr.is_null() {
                return 0;
            }
            let what = CStr::from_ptr(ptr as *const c_char).to_string_lossy();
            match what.as_ref() {
                "sendVstEvents" | "sendVstMidiEvent" | "sendVstTimeInfo" | "receiveVstEvents" | "receiveVstMidiEvent"
                | "sizeWindow" | "supplyIdle" | "startStopProcess" => 1,
                _ => -1,
            }
        }
        AM_GET_LANGUAGE => 1,
        AM_BEGIN_EDIT => {
            if let Some(h) = hd {
                if index >= 0 { journal(&h.journal, ParamEdit::Begin { id: index as u32 }); }
                if let Ok(mut t) = h.touched.lock() {
                    if index >= 0 && !t.contains(&(index as u32)) && t.len() < 256 {
                        t.push(index as u32);
                    }
                }
            }
            1
        }
        AM_END_EDIT => {
            if let Some(h) = hd { if index >= 0 { journal(&h.journal, ParamEdit::End { id: index as u32 }); } }
            1
        }
        AM_UPDATE_DISPLAY => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod undo_tests {
    use super::*;
    #[test]
    fn vst2_automate_reports_values_with_and_without_explicit_gestures() {
        let h = HostData {
            sr: AtomicU32::new(48000f32.to_bits()), block: AtomicU32::new(512),
            time: RefCell::new(VstTimeInfo::default()), editor: AtomicIsize::new(0),
            touched: Mutex::new(Vec::new()), journal: Mutex::new(Vec::new()),
        };
        unsafe {
            let mut fx: AEffect = std::mem::zeroed(); fx.resvd1 = &h as *const _ as isize;
            let nil = std::ptr::null_mut();
            host_cb(&mut fx, AM_BEGIN_EDIT, 3, 0, nil, 0.0);
            host_cb(&mut fx, AM_AUTOMATE, 3, 0, nil, 0.2);
            host_cb(&mut fx, AM_AUTOMATE, 3, 0, nil, 0.7);
            host_cb(&mut fx, AM_END_EDIT, 3, 0, nil, 0.0);
            host_cb(&mut fx, AM_AUTOMATE, 4, 0, nil, 0.4);
        }
        assert_eq!(*h.journal.lock().unwrap(), vec![
            ParamEdit::Begin { id: 3 }, ParamEdit::Value { id: 3, value: 0.7 }, ParamEdit::End { id: 3 },
            ParamEdit::Value { id: 4, value: 0.4 },
        ]);
        assert_eq!(*h.touched.lock().unwrap(), vec![3, 4]);
    }
}

/// The loaded module and the effect, shared by the instance and its processors.
struct Core {
    effect: *mut AEffect,
    host: *mut HostData,
    _lib: Library,
}

unsafe impl Send for Core {}
unsafe impl Sync for Core {}

impl Core {
    fn call(&self, op: i32, index: i32, value: isize, ptr: *mut c_void, opt: f32) -> isize {
        unsafe {
            match (*self.effect).dispatcher {
                Some(d) => d(self.effect, op, index, value, ptr, opt),
                None => 0,
            }
        }
    }
    fn string(&self, op: i32) -> String {
        let mut buf = [0 as c_char; 256];
        self.call(op, 0, 0, buf.as_mut_ptr() as *mut c_void, 0.0);
        cstr(&buf)
    }
    fn flags(&self) -> i32 {
        unsafe { (*self.effect).flags }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.call(EFF_STOP_PROCESS, 0, 0, std::ptr::null_mut(), 0.0);
        self.call(EFF_MAINS_CHANGED, 0, 0, std::ptr::null_mut(), 0.0);
        self.call(EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
        unsafe { drop(Box::from_raw(self.host)) };
    }
}

fn open(path: &Path) -> Result<Core, String> {
    let lib = unsafe { Library::new(path) }.map_err(|e| e.to_string())?;
    let entry: Entry = unsafe {
        match lib.get::<Entry>(b"VSTPluginMain\0").or_else(|_| lib.get::<Entry>(b"main\0")) {
            Ok(f) => *f,
            Err(_) => return Err("not a VST2 plugin".into()),
        }
    };
    let effect = unsafe { entry(host_cb) };
    if effect.is_null() || unsafe { (*effect).magic } != MAGIC {
        return Err("the plugin did not start".into());
    }
    let host = Box::into_raw(Box::new(HostData {
        sr: AtomicU32::new(44100f32.to_bits()),
        block: AtomicU32::new(512),
        time: RefCell::new(VstTimeInfo { sample_rate: 44100.0, tempo: 120.0, time_sig_numerator: 4, time_sig_denominator: 4, ..Default::default() }),
        editor: AtomicIsize::new(0),
        touched: Mutex::new(Vec::new()),
        journal: Mutex::new(Vec::new()),
    }));
    unsafe { (*effect).resvd1 = host as isize };
    let core = Core { effect, host, _lib: lib };
    core.call(EFF_OPEN, 0, 0, std::ptr::null_mut(), 0.0);
    Ok(core)
}

fn describe(core: &Core, path: &Path) -> PluginInfo {
    let mut name = core.string(EFF_GET_EFFECT_NAME);
    if name.is_empty() {
        name = core.string(EFF_GET_PRODUCT_STRING);
    }
    if name.is_empty() {
        name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    }
    let instrument = core.flags() & FLAG_SYNTH != 0 || core.call(EFF_GET_PLUG_CATEGORY, 0, 0, std::ptr::null_mut(), 0.0) == CATEGORY_SYNTH;
    PluginInfo {
        format: "vst2".into(),
        path: path.to_string_lossy().into_owned(),
        cid: unsafe { (*core.effect).unique_id }.to_string(),
        name,
        vendor: core.string(EFF_GET_VENDOR_STRING),
        instrument,
    }
}

pub fn probe(path: &Path) -> Result<Vec<PluginInfo>, String> {
    match open(path) {
        Ok(core) => Ok(vec![describe(&core, path)]),
        // DLLs next to plugins are often helpers: not an error, just nothing to list
        Err(e) if e == "not a VST2 plugin" => Ok(vec![]),
        Err(e) => Err(e),
    }
}

struct EditorState {
    hwnd: isize,
}

pub struct Vst2Instance {
    core: Arc<Core>,
    info: PluginInfo,
    setup: Setup,
    editor: Rc<RefCell<EditorState>>,
}

fn start(core: &Core, setup: Setup) {
    unsafe {
        (*core.host).sr.store(setup.sr.to_bits(), Ordering::Relaxed);
        (*core.host).block.store(setup.max_block as u32, Ordering::Relaxed);
        (*core.host).time.borrow_mut().sample_rate = setup.sr as f64;
    }
    core.call(EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), setup.sr);
    core.call(EFF_SET_BLOCK_SIZE, 0, setup.max_block as isize, std::ptr::null_mut(), 0.0);
    core.call(EFF_SET_PROCESS_PRECISION, 0, 0, std::ptr::null_mut(), 0.0);
    core.call(EFF_MAINS_CHANGED, 0, 1, std::ptr::null_mut(), 0.0);
    core.call(EFF_START_PROCESS, 0, 0, std::ptr::null_mut(), 0.0);
}

pub fn load(info: &PluginInfo, setup: Setup) -> Result<Vst2Instance, String> {
    let path = Path::new(&info.path);
    let core = open(path)?;
    if core.flags() & FLAG_REPLACING == 0 {
        return Err("the plugin has no 32-bit replacing process".into());
    }
    let mut info = info.clone();
    let d = describe(&core, path);
    if info.name.is_empty() {
        info.name = d.name;
    }
    info.instrument = d.instrument;
    start(&core, setup);
    Ok(Vst2Instance { core: Arc::new(core), info, setup, editor: Rc::new(RefCell::new(EditorState { hwnd: 0 })) })
}

struct EditorEvents {
    core: Arc<Core>,
    state: Rc<RefCell<EditorState>>,
}

impl Events for EditorEvents {
    fn closed(&mut self) {
        self.core.call(EFF_EDIT_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
        self.state.borrow_mut().hwnd = 0;
        unsafe { (*self.core.host).editor.store(0, Ordering::Relaxed) };
    }
    fn timer(&mut self) {
        self.core.call(EFF_EDIT_IDLE, 0, 0, std::ptr::null_mut(), 0.0);
    }
}

#[repr(C)]
struct ERect {
    top: i16,
    left: i16,
    bottom: i16,
    right: i16,
}

impl Vst2Instance {
    fn rect(&self) -> Option<(i32, i32)> {
        let mut r: *mut ERect = std::ptr::null_mut();
        self.core.call(EFF_EDIT_GET_RECT, 0, 0, &mut r as *mut *mut ERect as *mut c_void, 0.0);
        if r.is_null() {
            return None;
        }
        let r = unsafe { &*r };
        let (w, h) = ((r.right - r.left) as i32, (r.bottom - r.top) as i32);
        (w > 0 && h > 0).then_some((w, h))
    }
}

impl Instance for Vst2Instance {
    fn info(&self) -> &PluginInfo {
        &self.info
    }

    fn processor(&mut self) -> Box<dyn Processor> {
        let (ni, no) = unsafe { ((*self.core.effect).num_inputs.max(0) as usize, (*self.core.effect).num_outputs.max(0) as usize) };
        let mb = self.setup.max_block;
        let mut midi = Box::new([VstMidiEvent { kind: 1, byte_size: 32, delta_frames: 0, flags: 1, note_length: 0, note_offset: 0, midi_data: [0; 4], detune: 0, note_off_velocity: 0, _reserved1: 0, _reserved2: 0 }; MAX_EVENTS]);
        let mut events = Box::new(VstEvents { num_events: 0, _reserved: 0, events: [std::ptr::null_mut(); MAX_EVENTS] });
        for i in 0..MAX_EVENTS {
            events.events[i] = &mut midi[i];
        }
        Box::new(Vst2Proc {
            core: self.core.clone(),
            ins: vec![vec![0.0; mb]; ni],
            outs: vec![vec![0.0; mb]; no.max(2)],
            in_ptrs: vec![std::ptr::null(); ni],
            out_ptrs: vec![std::ptr::null_mut(); no.max(2)],
            midi,
            events,
        })
    }

    fn has_editor(&self) -> bool {
        self.core.flags() & FLAG_EDITOR != 0
    }

    fn open_editor(&mut self, owner: isize, title: &str) -> Result<(), String> {
        let open = self.editor.borrow().hwnd;
        if window::alive(open) {
            window::focus(open);
            return Ok(());
        }
        if !self.has_editor() {
            return Err("the plugin has no window".into());
        }
        let (w, h) = self.rect().unwrap_or((480, 320));
        let ev = Box::new(EditorEvents { core: self.core.clone(), state: self.editor.clone() });
        let hwnd = window::create(owner, title, w, h, false, 30, ev)?;
        self.editor.borrow_mut().hwnd = hwnd;
        unsafe { (*self.core.host).editor.store(hwnd, Ordering::Relaxed) };
        self.core.call(EFF_EDIT_OPEN, 0, 0, hwnd as *mut c_void, 0.0);
        // many editors know their real size only once open
        if let Some((w, h)) = self.rect() {
            window::set_client_size(hwnd, w, h);
        }
        window::show(hwnd);
        Ok(())
    }

    fn close_editor(&mut self) {
        let hwnd = self.editor.borrow().hwnd;
        window::close(hwnd);
    }

    fn editor_open(&self) -> bool {
        window::alive(self.editor.borrow().hwnd)
    }

    fn get_state(&mut self) -> Vec<u8> {
        if self.core.flags() & FLAG_CHUNKS != 0 {
            let mut p: *mut c_void = std::ptr::null_mut();
            let n = self.core.call(EFF_GET_CHUNK, 0, 0, &mut p as *mut *mut c_void as *mut c_void, 0.0);
            if n > 0 && !p.is_null() {
                let mut v = b"LCHK".to_vec();
                v.extend_from_slice(unsafe { std::slice::from_raw_parts(p as *const u8, n as usize) });
                return v;
            }
        }
        // no chunks: the parameter values are the state
        let mut v = b"LPRM".to_vec();
        let n = unsafe { (*self.core.effect).num_params.max(0) };
        if let Some(get) = unsafe { (*self.core.effect).get_parameter } {
            for i in 0..n {
                v.extend_from_slice(&unsafe { get(self.core.effect, i) }.to_le_bytes());
            }
        }
        v
    }

    fn set_state(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() < 4 {
            return Ok(());
        }
        let (tag, body) = data.split_at(4);
        match tag {
            b"LCHK" => {
                self.core.call(EFF_SET_CHUNK, 0, body.len() as isize, body.as_ptr() as *mut c_void, 0.0);
            }
            b"LPRM" => {
                if let Some(set) = unsafe { (*self.core.effect).set_parameter } {
                    for (i, c) in body.chunks_exact(4).enumerate() {
                        unsafe { set(self.core.effect, i as i32, f32::from_le_bytes([c[0], c[1], c[2], c[3]])) };
                    }
                }
            }
            _ => return Err("unknown state format".into()),
        }
        Ok(())
    }

    fn reconfigure(&mut self, setup: Setup) {
        self.setup = setup;
        self.core.call(EFF_STOP_PROCESS, 0, 0, std::ptr::null_mut(), 0.0);
        self.core.call(EFF_MAINS_CHANGED, 0, 0, std::ptr::null_mut(), 0.0);
        start(&self.core, setup);
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        let n = unsafe { (*self.core.effect).num_params.max(0) };
        let get = unsafe { (*self.core.effect).get_parameter };
        (0..n).map(|i| {
            let mut buf = [0 as c_char; 64];
            self.core.call(EFF_GET_PARAM_NAME, i, 0, buf.as_mut_ptr() as *mut c_void, 0.0);
            let name = cstr(&buf);
            let default = get.map_or(0.0, |g| unsafe { g(self.core.effect, i) });
            ParamInfo { id: i as u32, name: if name.is_empty() { format!("#{}", i + 1) } else { name }, default, value: default }
        }).collect()
    }

    // the plugin's window reads its own parameters: nothing to tell it
    fn follow_param(&mut self, _id: u32, _value: f32) {}

    fn touched(&mut self) -> Vec<u32> {
        unsafe { (*self.core.host).touched.lock().map(|mut t| std::mem::take(&mut *t)).unwrap_or_default() }
    }
    fn take_edits(&mut self) -> Vec<ParamEdit> {
        unsafe { (*self.core.host).journal.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default() }
    }
    fn set_param(&mut self, id: u32, value: f32) {
        let fx = self.core.effect;
        if id < unsafe { (*fx).num_params.max(0) as u32 } {
            if let Some(set) = unsafe { (*fx).set_parameter } { unsafe { set(fx, id as i32, value.clamp(0.0, 1.0)); } }
        }
    }
}

impl Drop for Vst2Instance {
    fn drop(&mut self) {
        self.close_editor();
    }
}

/// The audio-thread side: buffers sized for the plugin's own channel counts.
struct Vst2Proc {
    core: Arc<Core>,
    ins: Vec<Vec<f32>>,
    outs: Vec<Vec<f32>>,
    in_ptrs: Vec<*const f32>,
    out_ptrs: Vec<*mut f32>,
    midi: Box<[VstMidiEvent; MAX_EVENTS]>,
    events: Box<VstEvents>,
}

unsafe impl Send for Vst2Proc {}

impl Processor for Vst2Proc {
    fn process(&mut self, inp: [&[f32]; 2], out: [&mut [f32]; 2], events: &[MidiEv], time: &TimeInfo) {
        let n = out[0].len().min(self.outs.first().map_or(0, |o| o.len()));
        let [ol, or] = out;
        let Some(proc_) = (unsafe { (*self.core.effect).process_replacing }) else { return };
        unsafe {
            let mut ti = (*self.core.host).time.borrow_mut();
            ti.sample_pos = time.frames as f64;
            ti.sample_rate = time.sr as f64;
            ti.ppq_pos = time.ppq;
            ti.tempo = time.bpm;
            ti.bar_start_pos = (time.ppq / 4.0).floor() * 4.0;
            ti.time_sig_numerator = 4;
            ti.time_sig_denominator = 4;
            ti.flags = TIME_PPQ_VALID | TIME_TEMPO_VALID | TIME_BARS_VALID | TIME_SIG_VALID | if time.playing { TIME_PLAYING } else { 0 };
        }
        if !events.is_empty() {
            let k = events.len().min(MAX_EVENTS);
            for (i, e) in events[..k].iter().enumerate() {
                let m = &mut self.midi[i];
                m.delta_frames = e.frame as i32;
                m.midi_data = if e.on { [0x90, e.key, ((e.vel * 127.0).round() as u8).clamp(1, 127), 0] } else { [0x80, e.key, 0, 0] };
            }
            self.events.num_events = k as i32;
            self.core.call(EFF_PROCESS_EVENTS, 0, 0, &mut *self.events as *mut VstEvents as *mut c_void, 0.0);
        }
        for (i, b) in self.ins.iter_mut().enumerate() {
            match i {
                0 | 1 => b[..n].copy_from_slice(&inp[i][..n]),
                _ => b[..n].fill(0.0),
            }
            self.in_ptrs[i] = b.as_ptr();
        }
        // a mono-in effect gets both sides
        if self.ins.len() == 1 {
            for j in 0..n {
                self.ins[0][j] = 0.5 * (inp[0][j] + inp[1][j]);
            }
        }
        for (i, b) in self.outs.iter_mut().enumerate() {
            b[..n].fill(0.0);
            self.out_ptrs[i] = b.as_mut_ptr();
        }
        unsafe { proc_(self.core.effect, self.in_ptrs.as_ptr(), self.out_ptrs.as_mut_ptr(), n as i32) };
        let no = unsafe { (*self.core.effect).num_outputs.max(0) as usize };
        ol[..n].copy_from_slice(&self.outs[0][..n]);
        if no >= 2 {
            or[..n].copy_from_slice(&self.outs[1][..n]);
        } else {
            or[..n].copy_from_slice(&self.outs[0][..n]);
        }
    }

    // VST2 takes parameter changes on the audio thread, between process calls
    fn set_param(&mut self, id: u32, value: f32) {
        let fx = self.core.effect;
        if (id as i32) < unsafe { (*fx).num_params } {
            if let Some(set) = unsafe { (*fx).set_parameter } {
                unsafe { set(fx, id as i32, value) };
            }
        }
    }
}
