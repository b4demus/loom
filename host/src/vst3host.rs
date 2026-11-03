//! VST3 hosting through the `vst3` bindings (VST 3 SDK headers, MIT since VST 3.8).
//!
//! An instance: component + audio processor, an edit controller (inside the component or a
//! separate object, then connected both ways), and the host objects the plugin talks to —
//! host application (with messages and attribute lists), component handler (parameter edits
//! from the plugin's window, passed to the audio thread), streams for state, a frame for
//! the editor view, and the event list / parameter changes handed to `process`.

#![allow(non_upper_case_globals)]

use crate::window::{self, Events};
use crate::{cstr, journal, vst3_binary, Instance, ParamEdit, ParamInfo, PluginInfo, Setup};
use libloading::Library;
use loom_engine::plugin::{MidiEv, Processor, TimeInfo};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, Weak};
use vst3::Steinberg::Vst::IAttributeList_::AttrID;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper, Interface};

const STEREO: SpeakerArrangement = 3; // left | right
const AUDIO_MODULE_CLASS: &str = "Audio Module Class";

fn ok(r: tresult) -> bool {
    r == kResultOk
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut n = 0;
    for (s, d) in src.encode_utf16().zip(dst.iter_mut()) {
        *d = s as TChar;
        n += 1;
    }
    if n < dst.len() {
        dst[n] = 0;
    } else if let Some(l) = dst.last_mut() {
        *l = 0;
    }
}

fn hex(t: &TUID) -> String {
    t.iter().map(|b| format!("{:02X}", *b as u8)).collect()
}

fn unhex(s: &str) -> Option<TUID> {
    if s.len() != 32 {
        return None;
    }
    let mut t: TUID = [0; 16];
    for i in 0..16 {
        t[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()? as std::ffi::c_char;
    }
    Some(t)
}

fn iid<I: Interface>() -> FIDString {
    I::IID.as_ptr() as FIDString
}

// ---------- module ----------

/// A loaded .vst3 binary and its factory. Shared by every instance of the file; the last one
/// gone calls ExitDll and unloads it.
struct Module {
    factory: Option<ComPtr<IPluginFactory>>,
    lib: Option<Library>,
}

unsafe impl Send for Module {}
unsafe impl Sync for Module {}

impl Drop for Module {
    fn drop(&mut self) {
        self.factory = None;
        if let Some(lib) = self.lib.take() {
            unsafe {
                if let Ok(exit) = lib.get::<unsafe extern "system" fn() -> bool>(b"ExitDll\0") {
                    exit();
                }
            }
        }
    }
}

impl Module {
    fn factory(&self) -> &ComPtr<IPluginFactory> {
        self.factory.as_ref().unwrap()
    }

    fn get(path: &Path) -> Result<Arc<Module>, String> {
        static MODULES: Mutex<Option<HashMap<PathBuf, Weak<Module>>>> = Mutex::new(None);
        let bin = vst3_binary(path);
        let mut map = MODULES.lock().unwrap();
        let map = map.get_or_insert_with(HashMap::new);
        if let Some(m) = map.get(&bin).and_then(Weak::upgrade) {
            return Ok(m);
        }
        let lib = unsafe { Library::new(&bin) }.map_err(|e| e.to_string())?;
        let factory = unsafe {
            if let Ok(init) = lib.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0") {
                init();
            }
            let get = lib
                .get::<unsafe extern "system" fn() -> *mut IPluginFactory>(b"GetPluginFactory\0")
                .map_err(|_| "not a VST3 plugin".to_string())?;
            ComPtr::from_raw(get()).ok_or("the plugin has no factory")?
        };
        let m = Arc::new(Module { factory: Some(factory), lib: Some(lib) });
        map.insert(bin, Arc::downgrade(&m));
        Ok(m)
    }
}

pub fn probe(path: &Path) -> Result<Vec<PluginInfo>, String> {
    let m = Module::get(path)?;
    let f = m.factory();
    let f2 = f.cast::<IPluginFactory2>();
    let mut fi: PFactoryInfo = unsafe { std::mem::zeroed() };
    unsafe { f.getFactoryInfo(&mut fi) };
    let factory_vendor = cstr(&fi.vendor);
    let mut out = vec![];
    for i in 0..unsafe { f.countClasses() } {
        let mut ci: PClassInfo = unsafe { std::mem::zeroed() };
        if !ok(unsafe { f.getClassInfo(i, &mut ci) }) || cstr(&ci.category) != AUDIO_MODULE_CLASS {
            continue;
        }
        let (mut vendor, mut instrument) = (factory_vendor.clone(), false);
        if let Some(f2) = &f2 {
            let mut c2: PClassInfo2 = unsafe { std::mem::zeroed() };
            if ok(unsafe { f2.getClassInfo2(i, &mut c2) }) {
                let sub = cstr(&c2.subCategories);
                instrument = sub.split('|').any(|s| s == "Instrument" || s.starts_with("Instrument") || s == "Synth");
                let v = cstr(&c2.vendor);
                if !v.is_empty() {
                    vendor = v;
                }
            }
        }
        out.push(PluginInfo {
            format: "vst3".into(),
            path: path.to_string_lossy().into_owned(),
            cid: hex(&ci.cid),
            name: cstr(&ci.name),
            vendor,
            instrument,
        });
    }
    Ok(out)
}

// ---------- host objects ----------

struct HostApp;

impl Class for HostApp {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        copy_wstring("loom", &mut *name);
        kResultOk
    }
    unsafe fn createInstance(&self, _cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        let want = *(iid as *const [u8; 16]);
        if want == IMessage::IID {
            let m = ComWrapper::new(HostMessage::default());
            *obj = m.to_com_ptr::<IMessage>().unwrap().into_raw() as *mut c_void;
            kResultOk
        } else if want == IAttributeList::IID {
            let a = ComWrapper::new(AttrList::default());
            *obj = a.to_com_ptr::<IAttributeList>().unwrap().into_raw() as *mut c_void;
            kResultOk
        } else {
            *obj = std::ptr::null_mut();
            kResultFalse
        }
    }
}

enum Attr {
    Int(i64),
    Float(f64),
    Str(Vec<u16>),
    Bin(Vec<u8>),
}

#[derive(Default)]
struct AttrList {
    map: RefCell<HashMap<String, Attr>>,
}

impl Class for AttrList {
    type Interfaces = (IAttributeList,);
}

unsafe fn key(id: AttrID) -> String {
    if id.is_null() {
        String::new()
    } else {
        CStr::from_ptr(id).to_string_lossy().into_owned()
    }
}

impl IAttributeListTrait for AttrList {
    unsafe fn setInt(&self, id: AttrID, value: int64) -> tresult {
        self.map.borrow_mut().insert(key(id), Attr::Int(value));
        kResultOk
    }
    unsafe fn getInt(&self, id: AttrID, value: *mut int64) -> tresult {
        match self.map.borrow().get(&key(id)) {
            Some(Attr::Int(v)) => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: AttrID, value: f64) -> tresult {
        self.map.borrow_mut().insert(key(id), Attr::Float(value));
        kResultOk
    }
    unsafe fn getFloat(&self, id: AttrID, value: *mut f64) -> tresult {
        match self.map.borrow().get(&key(id)) {
            Some(Attr::Float(v)) => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: AttrID, string: *const TChar) -> tresult {
        let mut v = vec![];
        let mut p = string;
        while !p.is_null() && *p != 0 {
            v.push(*p);
            p = p.add(1);
        }
        v.push(0);
        self.map.borrow_mut().insert(key(id), Attr::Str(v));
        kResultOk
    }
    unsafe fn getString(&self, id: AttrID, string: *mut TChar, size_in_bytes: uint32) -> tresult {
        match self.map.borrow().get(&key(id)) {
            Some(Attr::Str(v)) => {
                let n = (size_in_bytes as usize / 2).min(v.len());
                if n == 0 {
                    return kResultFalse;
                }
                std::ptr::copy_nonoverlapping(v.as_ptr(), string, n);
                *string.add(n - 1) = 0;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setBinary(&self, id: AttrID, data: *const c_void, size: uint32) -> tresult {
        let v = std::slice::from_raw_parts(data as *const u8, size as usize).to_vec();
        self.map.borrow_mut().insert(key(id), Attr::Bin(v));
        kResultOk
    }
    unsafe fn getBinary(&self, id: AttrID, data: *mut *const c_void, size: *mut uint32) -> tresult {
        match self.map.borrow().get(&key(id)) {
            Some(Attr::Bin(v)) => {
                // the bytes stay where they are while the list lives
                *data = v.as_ptr() as *const c_void;
                *size = v.len() as uint32;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
}

struct HostMessage {
    id: RefCell<CString>,
    attrs: ComWrapper<AttrList>,
}

impl Default for HostMessage {
    fn default() -> Self {
        Self { id: RefCell::new(CString::default()), attrs: ComWrapper::new(AttrList::default()) }
    }
}

impl Class for HostMessage {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for HostMessage {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.borrow().as_ptr()
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        if !id.is_null() {
            *self.id.borrow_mut() = CStr::from_ptr(id).to_owned();
        }
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        self.attrs.as_com_ref::<IAttributeList>().unwrap().as_ptr()
    }
}

/// Parameter edits from the plugin's own window, waiting for the next process call.
type Edits = Arc<Mutex<Vec<(ParamID, ParamValue)>>>;
type Touched = Arc<Mutex<Vec<u32>>>;

struct Handler {
    edits: Edits,
    journal: Arc<Mutex<Vec<ParamEdit>>>,
    /// parameters the user grabbed in the plugin's window (beginEdit is a gesture, never
    /// a host-driven change), read by the app to stop their automation
    touched: Touched,
}

impl Class for Handler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for Handler {
    unsafe fn beginEdit(&self, id: ParamID) -> tresult {
        journal(&self.journal, ParamEdit::Begin { id });
        if let Ok(mut t) = self.touched.lock() {
            if !t.contains(&id) && t.len() < 256 {
                t.push(id);
            }
        }
        kResultOk
    }
    unsafe fn performEdit(&self, id: ParamID, value: ParamValue) -> tresult {
        if value.is_finite() { journal(&self.journal, ParamEdit::Value { id, value: value.clamp(0.0, 1.0) as f32 }); }
        if let Ok(mut t) = self.touched.lock() {
            if !t.contains(&id) && t.len() < 256 { t.push(id); }
        }
        if let Ok(mut e) = self.edits.lock() {
            if let Some(x) = e.iter_mut().find(|x| x.0 == id) {
                x.1 = value;
            } else if e.len() < 1024 {
                e.push((id, value));
            }
        }
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        journal(&self.journal, ParamEdit::End { id: _id });
        kResultOk
    }
    unsafe fn restartComponent(&self, _flags: int32) -> tresult {
        kResultOk
    }
}

#[cfg(test)]
mod undo_tests {
    use super::*;
    #[test]
    fn controller_gestures_are_journaled_separately_from_processor_edits() {
        let h = Handler { edits: Arc::new(Mutex::new(Vec::new())), touched: Arc::new(Mutex::new(Vec::new())), journal: Arc::new(Mutex::new(Vec::new())) };
        unsafe {
            h.beginEdit(7); h.performEdit(7, 0.4); h.performEdit(7, 0.8); h.endEdit(7);
            h.beginEdit(7); h.performEdit(7, 0.2); h.endEdit(7);
        }
        assert_eq!(*h.journal.lock().unwrap(), vec![
            ParamEdit::Begin { id: 7 }, ParamEdit::Value { id: 7, value: 0.8 }, ParamEdit::End { id: 7 },
            ParamEdit::Begin { id: 7 }, ParamEdit::Value { id: 7, value: 0.2 }, ParamEdit::End { id: 7 },
        ]);
        assert_eq!(*h.edits.lock().unwrap(), vec![(7, 0.2)]);
        assert_eq!(*h.touched.lock().unwrap(), vec![7]);
    }
}

#[derive(Default)]
struct MemStream {
    data: RefCell<Vec<u8>>,
    pos: Cell<usize>,
}

impl Class for MemStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemStream {
    unsafe fn read(&self, buffer: *mut c_void, n: int32, read: *mut int32) -> tresult {
        let d = self.data.borrow();
        let p = self.pos.get().min(d.len());
        let k = (n.max(0) as usize).min(d.len() - p);
        std::ptr::copy_nonoverlapping(d.as_ptr().add(p), buffer as *mut u8, k);
        self.pos.set(p + k);
        if !read.is_null() {
            *read = k as int32;
        }
        kResultOk
    }
    unsafe fn write(&self, buffer: *mut c_void, n: int32, written: *mut int32) -> tresult {
        let mut d = self.data.borrow_mut();
        let p = self.pos.get();
        let n = n.max(0) as usize;
        if d.len() < p + n {
            d.resize(p + n, 0);
        }
        std::ptr::copy_nonoverlapping(buffer as *const u8, d.as_mut_ptr().add(p), n);
        self.pos.set(p + n);
        if !written.is_null() {
            *written = n as int32;
        }
        kResultOk
    }
    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let len = self.data.borrow().len() as i64;
        let base = match mode as u32 {
            0 => 0,
            1 => self.pos.get() as i64,
            _ => len,
        };
        let np = (base + pos).clamp(0, len.max(base + pos).max(0));
        self.pos.set(np as usize);
        if !result.is_null() {
            *result = np;
        }
        kResultOk
    }
    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if !pos.is_null() {
            *pos = self.pos.get() as int64;
        }
        kResultOk
    }
}

fn stream(data: Vec<u8>) -> ComWrapper<MemStream> {
    ComWrapper::new(MemStream { data: RefCell::new(data), pos: Cell::new(0) })
}

fn stream_ptr(s: &ComWrapper<MemStream>) -> *mut IBStream {
    s.as_com_ref::<IBStream>().unwrap().as_ptr()
}

struct EventList {
    evs: RefCell<Vec<Event>>,
}

impl Class for EventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 {
        self.evs.borrow().len() as int32
    }
    unsafe fn getEvent(&self, index: int32, e: *mut Event) -> tresult {
        match self.evs.borrow().get(index as usize) {
            Some(ev) => {
                *e = *ev;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }
    unsafe fn addEvent(&self, e: *mut Event) -> tresult {
        let mut v = self.evs.borrow_mut();
        // never grow on the audio thread: the capacity was reserved up front
        if v.len() < v.capacity() {
            v.push(*e);
            kResultOk
        } else {
            kResultFalse
        }
    }
}

struct ParamQueue {
    id: Cell<ParamID>,
    value: Cell<ParamValue>,
}

impl Class for ParamQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.id.get()
    }
    unsafe fn getPointCount(&self) -> int32 {
        1
    }
    unsafe fn getPoint(&self, index: int32, offset: *mut int32, value: *mut ParamValue) -> tresult {
        if index != 0 {
            return kInvalidArgument;
        }
        *offset = 0;
        *value = self.value.get();
        kResultOk
    }
    unsafe fn addPoint(&self, _offset: int32, value: ParamValue, index: *mut int32) -> tresult {
        // only output changes are written by plugins; loom does not read them back
        self.value.set(value);
        if !index.is_null() {
            *index = 0;
        }
        kResultOk
    }
}

const MAX_CHANGES: usize = 64;

struct ParamChanges {
    queues: Vec<ComWrapper<ParamQueue>>,
    n: Cell<usize>,
}

impl ParamChanges {
    fn new() -> Self {
        Self {
            queues: (0..MAX_CHANGES).map(|_| ComWrapper::new(ParamQueue { id: Cell::new(0), value: Cell::new(0.0) })).collect(),
            n: Cell::new(0),
        }
    }
}

impl Class for ParamChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParamChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        self.n.get() as int32
    }
    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        if (index as usize) < self.n.get() {
            self.queues[index as usize].as_com_ref::<IParamValueQueue>().unwrap().as_ptr()
        } else {
            std::ptr::null_mut()
        }
    }
    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        // output side: one scratch queue takes whatever the plugin reports
        let q = &self.queues[0];
        q.id.set(*id);
        if !index.is_null() {
            *index = 0;
        }
        q.as_com_ref::<IParamValueQueue>().unwrap().as_ptr()
    }
}

struct Frame {
    hwnd: Cell<isize>,
}

impl Class for Frame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, _view: *mut IPlugView, size: *mut ViewRect) -> tresult {
        let r = &*size;
        let hwnd = self.hwnd.get();
        if window::alive(hwnd) {
            // WM_SIZE follows and calls onSize with the new client size
            window::set_client_size(hwnd, r.right - r.left, r.bottom - r.top);
        }
        kResultOk
    }
}

// ---------- the instance ----------

struct Core {
    component: Option<ComPtr<IComponent>>,
    processor: Option<ComPtr<IAudioProcessor>>,
    controller: Option<ComPtr<IEditController>>,
    separate: bool,
    points: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
    _host: ComWrapper<HostApp>,
    _handler: ComWrapper<Handler>,
    edits: Edits,
    touched: Touched,
    journal: Arc<Mutex<Vec<ParamEdit>>>,
    /// channel counts of the audio buses
    ins: Vec<i32>,
    outs: Vec<i32>,
    _module: Arc<Module>,
}

unsafe impl Send for Core {}
unsafe impl Sync for Core {}

impl Core {
    fn component(&self) -> &ComPtr<IComponent> {
        self.component.as_ref().unwrap()
    }
    fn processor(&self) -> &ComPtr<IAudioProcessor> {
        self.processor.as_ref().unwrap()
    }
    fn start(&self, setup: Setup) {
        let mut ps = ProcessSetup {
            processMode: ProcessModes_::kRealtime as int32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as int32,
            maxSamplesPerBlock: setup.max_block as int32,
            sampleRate: setup.sr as f64,
        };
        unsafe {
            self.processor().setupProcessing(&mut ps);
            self.component().setActive(1);
            self.processor().setProcessing(1);
        }
    }
    fn stop(&self) {
        unsafe {
            self.processor().setProcessing(0);
            self.component().setActive(0);
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        unsafe {
            self.stop();
            if let Some((a, b)) = self.points.take() {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
            if let Some(c) = &self.controller {
                c.setComponentHandler(std::ptr::null_mut());
                if self.separate {
                    c.terminate();
                }
            }
            self.component().terminate();
        }
        self.controller = None;
        self.processor = None;
        self.component = None;
    }
}

struct EditorState {
    hwnd: isize,
    view: Option<ComPtr<IPlugView>>,
    frame: Option<ComWrapper<Frame>>,
    resizable: bool,
}

pub struct Vst3Instance {
    core: Arc<Core>,
    info: PluginInfo,
    setup: Setup,
    editor: Rc<RefCell<EditorState>>,
}

pub fn load(info: &PluginInfo, setup: Setup) -> Result<Vst3Instance, String> {
    let module = Module::get(Path::new(&info.path))?;
    let cid = unhex(&info.cid).ok_or("bad class id")?;
    let host = ComWrapper::new(HostApp);
    let host_ptr = host.as_com_ref::<IHostApplication>().unwrap().as_ptr() as *mut FUnknown;
    unsafe {
        let mut obj = std::ptr::null_mut();
        module.factory().createInstance(cid.as_ptr(), iid::<IComponent>(), &mut obj);
        let component = ComPtr::<IComponent>::from_raw(obj as *mut IComponent).ok_or("the plugin did not create its component")?;
        if !ok(component.initialize(host_ptr)) {
            return Err("the plugin failed to initialize".into());
        }
        let Some(processor) = component.cast::<IAudioProcessor>() else {
            component.terminate();
            return Err("the plugin has no audio processor".into());
        };
        // the controller: part of the component, or a separate object to create and connect
        let (controller, separate) = match component.cast::<IEditController>() {
            Some(c) => (Some(c), false),
            None => {
                let mut ccid: TUID = [0; 16];
                let mut c = None;
                if ok(component.getControllerClassId(&mut ccid)) {
                    let mut obj = std::ptr::null_mut();
                    module.factory().createInstance(ccid.as_ptr(), iid::<IEditController>(), &mut obj);
                    if let Some(ctrl) = ComPtr::<IEditController>::from_raw(obj as *mut IEditController) {
                        if ok(ctrl.initialize(host_ptr)) {
                            c = Some(ctrl);
                        }
                    }
                }
                (c, true)
            }
        };
        let mut points = None;
        if let (true, Some(ctrl)) = (separate, &controller) {
            if let (Some(a), Some(b)) = (component.cast::<IConnectionPoint>(), ctrl.cast::<IConnectionPoint>()) {
                a.connect(b.as_ptr());
                b.connect(a.as_ptr());
                points = Some((a, b));
            }
        }
        let edits: Edits = Arc::new(Mutex::new(Vec::with_capacity(1024)));
        let touched: Touched = Arc::new(Mutex::new(Vec::new()));
        let journal = Arc::new(Mutex::new(Vec::new()));
        let handler = ComWrapper::new(Handler { edits: edits.clone(), touched: touched.clone(), journal: journal.clone() });
        if let Some(ctrl) = &controller {
            ctrl.setComponentHandler(handler.as_com_ref::<IComponentHandler>().unwrap().as_ptr());
            // the controller starts from the component's state
            let s = stream(vec![]);
            if ok(component.getState(stream_ptr(&s))) {
                s.pos.set(0);
                ctrl.setComponentState(stream_ptr(&s));
            }
        }

        // buses: main in/out stereo, the event input on, aux buses as the plugin left them
        let audio = MediaTypes_::kAudio as MediaType;
        let event = MediaTypes_::kEvent as MediaType;
        let (din, dout) = (BusDirections_::kInput as BusDirection, BusDirections_::kOutput as BusDirection);
        let nin = component.getBusCount(audio, din).max(0);
        let nout = component.getBusCount(audio, dout).max(0);
        let mut ain: Vec<SpeakerArrangement> = (0..nin).map(|i| { let mut a = 0; processor.getBusArrangement(din, i, &mut a); a }).collect();
        let mut aout: Vec<SpeakerArrangement> = (0..nout).map(|i| { let mut a = 0; processor.getBusArrangement(dout, i, &mut a); a }).collect();
        if let Some(a) = ain.first_mut() {
            *a = STEREO;
        }
        if let Some(a) = aout.first_mut() {
            *a = STEREO;
        }
        processor.setBusArrangements(ain.as_mut_ptr(), nin, aout.as_mut_ptr(), nout);
        let count = |dir, n| -> Vec<i32> {
            (0..n).map(|i| {
                let mut b: BusInfo = std::mem::zeroed();
                component.getBusInfo(audio, dir, i, &mut b);
                b.channelCount.max(0)
            }).collect()
        };
        let ins = count(din, nin);
        let outs = count(dout, nout);
        if nin > 0 {
            component.activateBus(audio, din, 0, 1);
        }
        if nout > 0 {
            component.activateBus(audio, dout, 0, 1);
        }
        if component.getBusCount(event, din) > 0 {
            component.activateBus(event, din, 0, 1);
        }
        let core = Core {
            component: Some(component),
            processor: Some(processor),
            controller,
            separate,
            points,
            _host: host,
            _handler: handler,
            edits,
            touched,
            journal,
            ins,
            outs,
            _module: module,
        };
        if core.outs.is_empty() {
            return Err("the plugin has no audio output".into());
        }
        core.start(setup);
        Ok(Vst3Instance {
            core: Arc::new(core),
            info: info.clone(),
            setup,
            editor: Rc::new(RefCell::new(EditorState { hwnd: 0, view: None, frame: None, resizable: false })),
        })
    }
}

struct ViewEvents {
    state: Rc<RefCell<EditorState>>,
}

impl Events for ViewEvents {
    fn closed(&mut self) {
        let mut st = self.state.borrow_mut();
        if let Some(v) = st.view.take() {
            unsafe {
                v.setFrame(std::ptr::null_mut());
                v.removed();
            }
        }
        st.frame = None;
        st.hwnd = 0;
    }
    fn resized(&mut self, w: i32, h: i32) {
        let Ok(st) = self.state.try_borrow() else { return };
        if let Some(v) = &st.view {
            let mut r = ViewRect { left: 0, top: 0, right: w, bottom: h };
            unsafe {
                if st.resizable {
                    v.checkSizeConstraint(&mut r);
                }
                v.onSize(&mut r);
            }
        }
    }
}

impl Instance for Vst3Instance {
    fn info(&self) -> &PluginInfo {
        &self.info
    }

    fn processor(&mut self) -> Box<dyn Processor> {
        let mb = self.setup.max_block;
        let mk = |counts: &[i32]| -> Vec<Vec<Vec<f32>>> { counts.iter().map(|&c| (0..c).map(|_| vec![0.0; mb]).collect()).collect() };
        let mut p = Vst3Proc {
            core: self.core.clone(),
            ibuf: mk(&self.core.ins),
            obuf: mk(&self.core.outs),
            iptr: vec![],
            optr: vec![],
            ibus: vec![],
            obus: vec![],
            events: ComWrapper::new(EventList { evs: RefCell::new(Vec::with_capacity(512)) }),
            out_events: ComWrapper::new(EventList { evs: RefCell::new(Vec::with_capacity(512)) }),
            changes: ComWrapper::new(ParamChanges::new()),
            out_changes: ComWrapper::new(ParamChanges::new()),
            auto: Vec::with_capacity(MAX_CHANGES),
            ctx: unsafe { std::mem::zeroed() },
        };
        // pointer tables point into the buffers above, which never move after this
        p.iptr = p.ibuf.iter_mut().map(|b| b.iter_mut().map(|c| c.as_mut_ptr()).collect()).collect();
        p.optr = p.obuf.iter_mut().map(|b| b.iter_mut().map(|c| c.as_mut_ptr()).collect()).collect();
        let bus = |ptrs: &mut Vec<*mut f32>| AudioBusBuffers {
            numChannels: ptrs.len() as int32,
            silenceFlags: 0,
            __field0: AudioBusBuffers__type0 { channelBuffers32: ptrs.as_mut_ptr() },
        };
        p.ibus = p.iptr.iter_mut().map(bus).collect();
        p.obus = p.optr.iter_mut().map(bus).collect();
        Box::new(p)
    }

    fn has_editor(&self) -> bool {
        self.core.controller.is_some()
    }

    fn open_editor(&mut self, owner: isize, title: &str) -> Result<(), String> {
        let open = self.editor.borrow().hwnd;
        if window::alive(open) {
            window::focus(open);
            return Ok(());
        }
        let ctrl = self.core.controller.as_ref().ok_or("the plugin has no window")?;
        unsafe {
            let view = ComPtr::<IPlugView>::from_raw(ctrl.createView(b"editor\0".as_ptr() as FIDString)).ok_or("the plugin has no window")?;
            if !ok(view.isPlatformTypeSupported(kPlatformTypeHWND)) {
                return Err("the plugin window is not for Windows".into());
            }
            let mut r = ViewRect { left: 0, top: 0, right: 640, bottom: 400 };
            view.getSize(&mut r);
            let resizable = ok(view.canResize());
            let frame = ComWrapper::new(Frame { hwnd: Cell::new(0) });
            let ev = Box::new(ViewEvents { state: self.editor.clone() });
            let hwnd = window::create(owner, title, r.right - r.left, r.bottom - r.top, resizable, 0, ev)?;
            frame.hwnd.set(hwnd);
            view.setFrame(frame.as_com_ref::<IPlugFrame>().unwrap().as_ptr());
            {
                let mut st = self.editor.borrow_mut();
                st.hwnd = hwnd;
                st.view = Some(view.clone());
                st.frame = Some(frame);
                st.resizable = resizable;
            }
            if !ok(view.attached(hwnd as *mut c_void, kPlatformTypeHWND)) {
                window::close(hwnd);
                return Err("the plugin window did not open".into());
            }
            // some views settle their size only once attached
            let mut r2 = r;
            if ok(view.getSize(&mut r2)) && (r2.right - r2.left, r2.bottom - r2.top) != window::client_size(hwnd) {
                window::set_client_size(hwnd, r2.right - r2.left, r2.bottom - r2.top);
            }
            window::show(hwnd);
        }
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
        let comp = stream(vec![]);
        let ctrl = stream(vec![]);
        unsafe {
            self.core.component().getState(stream_ptr(&comp));
            if let Some(c) = &self.core.controller {
                c.getState(stream_ptr(&ctrl));
            }
        }
        let (a, b) = (comp.data.borrow(), ctrl.data.borrow());
        let mut v = b"L3ST".to_vec();
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(&a);
        v.extend_from_slice(&(b.len() as u32).to_le_bytes());
        v.extend_from_slice(&b);
        v
    }

    fn set_state(&mut self, data: &[u8]) -> Result<(), String> {
        let bad = || "unknown state format".to_string();
        if data.len() < 8 || &data[..4] != b"L3ST" {
            return Err(bad());
        }
        let n = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
        let comp = data.get(8..8 + n).ok_or_else(bad)?;
        let rest = &data[8 + n..];
        let m = rest.get(..4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize).unwrap_or(0);
        let ctrl = rest.get(4..4 + m).unwrap_or(&[]);
        unsafe {
            let s = stream(comp.to_vec());
            self.core.component().setState(stream_ptr(&s));
            if let Some(c) = &self.core.controller {
                let s = stream(comp.to_vec());
                c.setComponentState(stream_ptr(&s));
                if !ctrl.is_empty() {
                    let s = stream(ctrl.to_vec());
                    c.setState(stream_ptr(&s));
                }
            }
        }
        Ok(())
    }

    fn reconfigure(&mut self, setup: Setup) {
        self.setup = setup;
        self.core.stop();
        self.core.start(setup);
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        use ParameterInfo_::ParameterFlags_::*;
        let Some(ctrl) = &self.core.controller else { return vec![] };
        let mut out = vec![];
        unsafe {
            for i in 0..ctrl.getParameterCount().max(0) {
                let mut p: ParameterInfo = std::mem::zeroed();
                if !ok(ctrl.getParameterInfo(i, &mut p)) || p.flags & kCanAutomate == 0 || p.flags & (kIsReadOnly | kIsHidden | kIsProgramChange) != 0 {
                    continue;
                }
                let n = p.title.iter().position(|&c| c == 0).unwrap_or(p.title.len());
                let name = String::from_utf16_lossy(&p.title[..n].iter().map(|&c| c as u16).collect::<Vec<_>>());
                out.push(ParamInfo { id: p.id, name: name.trim().to_string(), default: p.defaultNormalizedValue as f32, value: ctrl.getParamNormalized(p.id) as f32 });
            }
        }
        out
    }

    fn param_values(&mut self) -> std::collections::BTreeMap<u32, f32> {
        let mut values = std::collections::BTreeMap::new();
        if let Some(ctrl) = &self.core.controller {
            unsafe {
                for i in 0..ctrl.getParameterCount().max(0) {
                    let mut info: ParameterInfo = std::mem::zeroed();
                    if ok(ctrl.getParameterInfo(i, &mut info)) {
                        let value = ctrl.getParamNormalized(info.id) as f32;
                        if value.is_finite() { values.insert(info.id, value.clamp(0.0, 1.0)); }
                    }
                }
            }
        }
        values
    }
    fn follow_param(&mut self, id: u32, value: f32) {
        if let Some(c) = &self.core.controller {
            unsafe { c.setParamNormalized(id, value as f64) };
        }
    }

    fn touched(&mut self) -> Vec<u32> {
        self.core.touched.lock().map(|mut t| std::mem::take(&mut *t)).unwrap_or_default()
    }
    fn take_edits(&mut self) -> Vec<ParamEdit> {
        self.core.journal.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }
    fn set_param(&mut self, id: u32, value: f32) {
        let value = value.clamp(0.0, 1.0);
        self.follow_param(id, value);
        if let Ok(mut e) = self.core.edits.lock() {
            if let Some(x) = e.iter_mut().find(|x| x.0 == id) { x.1 = value as f64; }
            else { e.push((id, value as f64)); }
        }
    }
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        self.close_editor();
    }
}

struct Vst3Proc {
    core: Arc<Core>,
    ibuf: Vec<Vec<Vec<f32>>>,
    obuf: Vec<Vec<Vec<f32>>>,
    iptr: Vec<Vec<*mut f32>>,
    optr: Vec<Vec<*mut f32>>,
    ibus: Vec<AudioBusBuffers>,
    obus: Vec<AudioBusBuffers>,
    events: ComWrapper<EventList>,
    out_events: ComWrapper<EventList>,
    changes: ComWrapper<ParamChanges>,
    out_changes: ComWrapper<ParamChanges>,
    /// automated values for the next block
    auto: Vec<(ParamID, ParamValue)>,
    ctx: ProcessContext,
}

unsafe impl Send for Vst3Proc {}

impl Processor for Vst3Proc {
    fn process(&mut self, inp: [&[f32]; 2], out: [&mut [f32]; 2], events: &[MidiEv], time: &TimeInfo) {
        let [ol, or] = out;
        let n = ol.len().min(self.obuf[0].first().map_or(0, |c| c.len()));
        // parameter edits from the plugin's window since the last block
        let mut k = 0;
        if let Ok(mut e) = self.core.edits.try_lock() {
            // A preset/undo can restore more than one block's parameter capacity.
            // Leave the rest queued for subsequent blocks instead of discarding them.
            let count = e.len().min(MAX_CHANGES);
            for (id, v) in e.drain(..count) {
                let q = &self.changes.queues[k];
                q.id.set(id);
                q.value.set(v);
                k += 1;
            }
        }
        // then the playlist's automation; it never allocates (auto keeps its capacity)
        for (id, v) in self.auto.drain(..) {
            if k == MAX_CHANGES {
                break;
            }
            let q = &self.changes.queues[k];
            q.id.set(id);
            q.value.set(v);
            k += 1;
        }
        self.changes.n.set(k);
        {
            let mut evs = self.events.evs.borrow_mut();
            evs.clear();
            for e in events.iter().take(evs.capacity()) {
                let mut ev: Event = unsafe { std::mem::zeroed() };
                ev.sampleOffset = e.frame as int32;
                ev.flags = Event_::EventFlags_::kIsLive as u16;
                if e.on {
                    ev.r#type = Event_::EventTypes_::kNoteOnEvent as u16;
                    ev.__field0.noteOn = NoteOnEvent { channel: 0, pitch: e.key as int16, tuning: 0.0, velocity: e.vel, length: 0, noteId: -1 };
                } else {
                    ev.r#type = Event_::EventTypes_::kNoteOffEvent as u16;
                    ev.__field0.noteOff = NoteOffEvent { channel: 0, pitch: e.key as int16, velocity: 0.0, noteId: -1, tuning: 0.0 };
                }
                evs.push(ev);
            }
        }
        self.out_events.evs.borrow_mut().clear();
        self.out_changes.n.set(0);
        for (bi, bus) in self.ibuf.iter_mut().enumerate() {
            for (ci, ch) in bus.iter_mut().enumerate() {
                if bi == 0 && ci < 2 {
                    ch[..n].copy_from_slice(&inp[ci][..n]);
                } else {
                    ch[..n].fill(0.0);
                }
            }
            // mono main input: both sides summed
            if bi == 0 && bus.len() == 1 {
                for j in 0..n {
                    bus[0][j] = 0.5 * (inp[0][j] + inp[1][j]);
                }
            }
        }
        for bus in self.obuf.iter_mut() {
            for ch in bus.iter_mut() {
                ch[..n].fill(0.0);
            }
        }
        use ProcessContext_::StatesAndFlags_::*;
        let c = &mut self.ctx;
        c.state = (kTempoValid | kProjectTimeMusicValid | kBarPositionValid | kTimeSigValid | if time.playing { kPlaying } else { 0 }) as uint32;
        c.sampleRate = time.sr as f64;
        c.projectTimeSamples = time.frames;
        c.continousTimeSamples = time.frames;
        c.projectTimeMusic = time.ppq;
        c.barPositionMusic = (time.ppq / 4.0).floor() * 4.0;
        c.tempo = time.bpm;
        c.timeSigNumerator = 4;
        c.timeSigDenominator = 4;
        let mut data = ProcessData {
            processMode: ProcessModes_::kRealtime as int32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as int32,
            numSamples: n as int32,
            numInputs: self.ibus.len() as int32,
            numOutputs: self.obus.len() as int32,
            inputs: if self.ibus.is_empty() { std::ptr::null_mut() } else { self.ibus.as_mut_ptr() },
            outputs: self.obus.as_mut_ptr(),
            inputParameterChanges: self.changes.as_com_ref::<IParameterChanges>().unwrap().as_ptr(),
            outputParameterChanges: self.out_changes.as_com_ref::<IParameterChanges>().unwrap().as_ptr(),
            inputEvents: self.events.as_com_ref::<IEventList>().unwrap().as_ptr(),
            outputEvents: self.out_events.as_com_ref::<IEventList>().unwrap().as_ptr(),
            processContext: &mut self.ctx,
        };
        unsafe { self.core.processor().process(&mut data) };
        let main = &self.obuf[0];
        if let Some(l) = main.first() {
            ol[..n].copy_from_slice(&l[..n]);
            or[..n].copy_from_slice(&main.get(1).unwrap_or(l)[..n]);
        }
    }

    fn set_param(&mut self, id: u32, value: f32) {
        if let Some(x) = self.auto.iter_mut().find(|x| x.0 == id) {
            x.1 = value as f64;
        } else if self.auto.len() < MAX_CHANGES {
            self.auto.push((id, value as f64));
        }
    }
}
