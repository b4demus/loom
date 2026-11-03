//! The audio device. cpal streams are not `Send`, so one host thread owns the stream and
//! rebuilds it on request; the UI talks to the engine through a lock-free ring, and whatever
//! the engine lets go of comes back through another ring to be freed off the audio thread.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use loom_engine::plugin::{InputSource, Processor, TapSink};
use loom_engine::sampler::SampleBuf;
use loom_engine::{Engine, Mode, Shared, Song};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

/// Microseconds on one clock shared by the output and the input threads: what lines a
/// recording up with the music.
pub fn now_us() -> u64 {
    static EPOCH: OnceLock<std::time::Instant> = OnceLock::new();
    EPOCH.get_or_init(std::time::Instant::now).elapsed().as_micros() as u64
}

pub enum Cmd {
    Song(Box<Song>),
    Play,
    /// play after this many bars of count-in
    PlayCountIn(u32),
    /// the live input, read by the mixer tracks that listen to it
    Input(Option<Box<dyn InputSource>>),
    /// hear the input in the master (recording with no track armed)
    MonitorMaster(bool),
    /// record these mixer tracks' own sound (empty: stop)
    Taps(Vec<(usize, Box<dyn TapSink>)>),
    Stop,
    Pos(f64),
    Mode(Mode),
    NoteOn(u32, u8, f32),
    NoteOff(u32, u8),
    Panic,
    Metronome(bool),
    /// the app's output volume (not the master track)
    OutputGain(f32),
    /// stop at the playlist loop's end instead of wrapping (a take recorded over the loop)
    StopAtLoopEnd(bool),
    AddPlugin(u32, Box<dyn Processor>),
    RemovePlugin(u32),
    Preview(Option<Arc<SampleBuf>>),
}

/// Things the audio thread hands back. Songs and samples are only held to be freed.
#[allow(dead_code)]
pub enum Trash {
    Song(Box<Song>),
    Plugin(Box<dyn Processor>),
    Sample(Arc<SampleBuf>),
    Input(Box<dyn InputSource>),
    Taps(Vec<(usize, Box<dyn TapSink>)>),
}

pub enum Ctl {
    Start(Option<String>, Option<mpsc::Sender<Result<(), String>>>),
    Panel,
    Inputs(mpsc::Sender<Result<Vec<InputChannel>, String>>),
    /// stop the stream and let the driver go, then end the host thread
    Shutdown(mpsc::Sender<()>),
}

pub const DRIVER_TIMEOUT: &str = "the audio driver did not answer in 15 s: another program (often a loom.exe that did not close) still holds it";

#[derive(Clone, serde::Serialize)]
pub struct InputChannel {
    pub index: u32,
    pub name: String,
    pub group: i32,
}

#[derive(serde::Serialize)]
pub struct InputChoice {
    pub code: u32,
    pub name: String,
    pub stereo: bool,
}

#[derive(serde::Serialize)]
pub struct InputCatalog {
    pub device: String,
    pub driver: String,
    pub choices: Vec<InputChoice>,
}

pub fn input_choices(channels: &[InputChannel]) -> Vec<InputChoice> {
    let mut choices = vec![];
    for ch in channels {
        let code = match ch.index { 0 => 1, 1 => 2, n => 16 + n };
        choices.push(InputChoice { code, name: ch.name.clone(), stereo: false });
    }
    let mut i = 0;
    while i + 1 < channels.len() {
        let (a, b) = (&channels[i], &channels[i + 1]);
        if a.group == b.group && b.index == a.index + 1 {
            let code = if a.index == 0 { 3 } else { 1024 + a.index };
            choices.push(InputChoice { code, name: format!("{} + {}", a.name, b.name), stereo: true });
            i += 2;
        } else { i += 1; }
    }
    choices
}

#[derive(Clone, Default, serde::Serialize)]
pub struct DeviceInfo {
    pub device: String,
    /// Stable selector for the UI (ASIO and WASAPI can have the same device name).
    pub id: String,
    pub driver: String,
    pub sr: u32,
    pub channels: u16,
    pub format: String,
    pub error: Option<String>,
}

/// The parts the commands need; the host thread fills them in on every (re)start.
pub struct Link {
    pub tx: Mutex<Option<rtrb::Producer<Cmd>>>,
    pub trash: Mutex<Option<rtrb::Consumer<Trash>>>,
    pub info: Mutex<DeviceInfo>,
    /// ASIO input/output must use clones of the same Device, sharing one driver and buffers.
    pub device: Mutex<Option<cpal::Device>>,
    pub shared: Arc<Shared>,
    /// the transport survives a device switch
    pub mode: Mutex<Mode>,
    pub metronome: Mutex<bool>,
    pub out_gain: Mutex<f32>,
    /// how long from the output callback until its sound comes out
    pub out_latency_us: AtomicU64,
    /// now_us() when the transport last really started sounding (after any count-in)
    pub play_wall_us: AtomicU64,
    ctl: Mutex<mpsc::Sender<Ctl>>,
}

impl Link {
    pub fn send(&self, c: Cmd) {
        if let Some(tx) = self.tx.lock().unwrap().as_mut() {
            let _ = tx.push(c);
        }
    }

    /// What came back from the audio thread. Songs and samples are freed right here; plugin
    /// processors are returned, since they must be freed on the UI thread.
    pub fn empty_trash(&self) -> Vec<Box<dyn Processor>> {
        let mut plugins = vec![];
        if let Some(rx) = self.trash.lock().unwrap().as_mut() {
            while let Ok(t) = rx.pop() {
                if let Trash::Plugin(p) = t {
                    plugins.push(p);
                }
            }
        }
        plugins
    }

    pub fn restart(&self, device: Option<String>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.ctl.lock().unwrap().send(Ctl::Start(device, Some(tx))).map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(15)).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => DRIVER_TIMEOUT.to_string(),
            e => e.to_string(),
        })?
    }

    /// Stops the stream before the process exits. An ASIO driver left running when the process
    /// is torn down (ASIO4ALL over kernel streaming) can wedge the process in the kernel, still
    /// holding the device, so the next start times out.
    pub fn shutdown(&self) {
        let (tx, rx) = mpsc::channel();
        if self.ctl.lock().unwrap().send(Ctl::Shutdown(tx)).is_ok() {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
        }
    }

    pub fn panel(&self) {
        let _ = self.ctl.lock().unwrap().send(Ctl::Panel);
    }

    pub fn input_channels(&self) -> Result<Vec<InputChannel>, String> {
        let (tx, rx) = mpsc::channel();
        self.ctl.lock().unwrap().send(Ctl::Inputs(tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?
    }

    pub fn sample_rate(&self) -> f32 {
        let sr = self.info.lock().unwrap().sr;
        if sr == 0 { 48000.0 } else { sr as f32 }
    }
}

#[derive(serde::Serialize)]
pub struct DeviceChoice {
    pub id: String,
    pub name: String,
    pub driver: String,
}

/// Enumerate ASIO registrations without opening drivers or disturbing the active stream.
#[cfg(feature = "asio")]
fn asio_names() -> Vec<String> {
    use windows_sys::Win32::System::Registry::*;
    let path: Vec<u16> = "SOFTWARE\\ASIO\0".encode_utf16().collect();
    let mut names = vec![];
    unsafe {
        let mut key = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut key) != 0 { return names; }
        for index in 0..256 {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            if RegEnumKeyExW(key, index, buf.as_mut_ptr(), &mut len, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) != 0 { break; }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        RegCloseKey(key);
    }
    names.sort();
    names
}

pub fn output_devices() -> Vec<DeviceChoice> {
    let host = cpal::default_host();
    let choices: Vec<_> = host.output_devices().map(|ds| ds.filter_map(|d| d.description().ok().map(|d| d.name().to_owned())).map(|name| DeviceChoice { id: name.clone(), name, driver: "WASAPI".into() }).collect()).unwrap_or_default();
    #[cfg(feature = "asio")]
    let choices = choices.into_iter().chain(asio_names().into_iter().map(|name| DeviceChoice { id: format!("asio:{name}"), name, driver: "ASIO".into() })).collect();
    choices
}

/// Starts the host thread. `song` builds the current project for a fresh engine;
/// `started` runs after every successful (re)start with the new sample rate.
pub fn start(song: impl Fn() -> Box<Song> + Send + 'static, started: impl Fn(f32) + Send + 'static) -> Arc<Link> {
    let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>();
    let link = Arc::new(Link {
        tx: Mutex::new(None),
        trash: Mutex::new(None),
        info: Mutex::new(DeviceInfo::default()),
        device: Mutex::new(None),
        shared: Arc::new(Shared::default()),
        mode: Mutex::new(Mode::Pattern(0)),
        metronome: Mutex::new(false),
        out_gain: Mutex::new(1.0),
        out_latency_us: AtomicU64::new(0),
        play_wall_us: AtomicU64::new(0),
        ctl: Mutex::new(ctl_tx),
    });
    let l2 = link.clone();
    std::thread::Builder::new()
        .name("loom-audio-host".into())
        .spawn(move || {
            // The SDK loads COM drivers on this thread, including ASIO4ALL.
            unsafe { windows_sys::Win32::System::Com::CoInitializeEx(std::ptr::null(), windows_sys::Win32::System::Com::COINIT_APARTMENTTHREADED as u32); }
            let mut stream: Option<cpal::Stream> = None;
            let mut first = Some(Ctl::Start(None, None));
            loop {
                // Driver control panels and some ASIO implementations own windows on this
                // COM apartment. Keep their messages moving while awaiting audio commands.
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::*;
                    let mut msg = std::mem::zeroed();
                    while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&msg); DispatchMessageW(&msg);
                    }
                }
                let msg = match first.take() {
                    Some(m) => m,
                    None => match ctl_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                        Ok(m) => m,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    },
                };
                match msg {
                    Ctl::Inputs(reply) => {
                        #[cfg(feature = "asio")]
                        let channels = if l2.info.lock().unwrap().driver == "ASIO" {
                            asio_sys::input_channel_names().map(|items| items.into_iter().enumerate().map(|(i, (name, group))| InputChannel { index: i as u32, name: if name.is_empty() { format!("Input {}", i + 1) } else { name }, group }).collect()).map_err(|e| e.to_string())
                        } else { Err("ASIO is not selected".into()) };
                        #[cfg(not(feature = "asio"))]
                        let channels = Err("ASIO is unavailable in this build".into());
                        let _ = reply.send(channels);
                    }
                    Ctl::Panel => {
                        #[cfg(feature = "asio")]
                        if l2.info.lock().unwrap().driver == "ASIO" {
                            let _ = asio_sys::control_panel();
                        }
                    }
                    Ctl::Shutdown(reply) => {
                        *l2.tx.lock().unwrap() = None;
                        // the last Device clone and the stream: the driver stops and unloads here
                        *l2.device.lock().unwrap() = None;
                        drop(stream.take());
                        let _ = reply.send(());
                        break;
                    }
                    Ctl::Start(dev, reply) => {
                        *l2.device.lock().unwrap() = None;
                        drop(stream.take());
                        *l2.tx.lock().unwrap() = None;
                        match open(&l2, dev, song()) {
                            Ok(s) => {
                                stream = Some(s);
                                started(l2.sample_rate());
                                if let Some(tx) = reply { let _ = tx.send(Ok(())); }
                            }
                            Err(e) => {
                                let mut i = l2.info.lock().unwrap();
                                i.error = Some(e.clone());
                                if let Some(tx) = reply { let _ = tx.send(Err(e)); }
                            }
                        }
                    }
                }
            }
        })
        .expect("audio host thread");
    link
}

fn open(link: &Arc<Link>, want: Option<String>, song: Box<Song>) -> Result<cpal::Stream, String> {
    let asio_name = want.as_deref().and_then(|s| s.strip_prefix("asio:"));
    let driver = if asio_name.is_some() { "ASIO" } else { "WASAPI" };
    let host = match asio_name {
        #[cfg(feature = "asio")]
        Some(_) => cpal::host_from_id(cpal::HostId::Asio).map_err(|e| e.to_string())?,
        #[cfg(not(feature = "asio"))]
        Some(_) => return Err("ASIO is unavailable in this build".into()),
        None => cpal::default_host(),
    };
    let target = asio_name.or(want.as_deref());
    let dev = match target {
        Some(name) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.description().ok().map(|d| d.name().to_owned()).as_deref() == Some(name)),
        None => host.default_output_device(),
    }
    .ok_or_else(|| format!("Audio device unavailable: {}", target.unwrap_or("default")))?;
    let sup = dev.default_output_config().map_err(|e| e.to_string())?;
    let format = sup.sample_format();
    let cfg: cpal::StreamConfig = sup.into();

    let mut engine = Engine::new(cfg.sample_rate as f32, song, link.shared.clone());
    engine.set_mode(*link.mode.lock().unwrap());
    engine.set_pos(link.shared.pos());
    engine.set_metronome(*link.metronome.lock().unwrap());
    engine.set_output_gain(*link.out_gain.lock().unwrap());
    let (tx, rx) = rtrb::RingBuffer::<Cmd>::new(512);
    let (ttx, trx) = rtrb::RingBuffer::<Trash>::new(256);
    // the old engine (and anything in it) is gone by now: start the trash afresh
    *link.trash.lock().unwrap() = Some(trx);
    let ch = cfg.channels as usize;
    let l = link.clone();
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&dev, &cfg, engine, rx, ttx, ch, l),
        cpal::SampleFormat::F64 => build::<f64>(&dev, &cfg, engine, rx, ttx, ch, l),
        cpal::SampleFormat::I24 => build::<cpal::I24>(&dev, &cfg, engine, rx, ttx, ch, l),
        cpal::SampleFormat::I16 => build::<i16>(&dev, &cfg, engine, rx, ttx, ch, l),
        cpal::SampleFormat::I32 => build::<i32>(&dev, &cfg, engine, rx, ttx, ch, l),
        cpal::SampleFormat::U16 => build::<u16>(&dev, &cfg, engine, rx, ttx, ch, l),
        f => return Err(format!("unsupported sample format {f}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    *link.info.lock().unwrap() = DeviceInfo {
        device: dev.description().map(|d| d.name().to_owned()).unwrap_or_default(),
        id: want.unwrap_or_else(|| dev.description().map(|d| d.name().to_owned()).unwrap_or_default()),
        driver: driver.into(),
        sr: cfg.sample_rate,
        channels: cfg.channels,
        format: format.to_string(),
        error: None,
    };
    *link.device.lock().unwrap() = Some(dev);
    *link.tx.lock().unwrap() = Some(tx);
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_input_choices_include_all_channels_and_never_pair_different_devices() {
        let channels = vec![
            InputChannel { index: 0, name: "C-MEDIA USB Audio Device".into(), group: 0 },
            InputChannel { index: 1, name: "Microphone Left".into(), group: 1 },
            InputChannel { index: 2, name: "Microphone Right".into(), group: 1 },
        ];
        let choices = input_choices(&channels);
        assert_eq!(choices.iter().map(|c| c.code).collect::<Vec<_>>(), [1, 2, 18, 1025]);
        assert_eq!(choices[0].name, "C-MEDIA USB Audio Device");
        assert!(choices[3].stereo);
        assert_eq!(loom_engine::project::input_route(choices[3].code), Some((1, 2, true)));
    }

    #[cfg(feature = "asio")]
    #[test]
    #[ignore = "requires installed ASIO4ALL; queries names without starting audio capture"]
    fn asio4all_reports_named_inputs() {
        unsafe { windows_sys::Win32::System::Com::CoInitializeEx(std::ptr::null(), windows_sys::Win32::System::Com::COINIT_APARTMENTTHREADED as u32); }
        let asio = asio_sys::Asio::new();
        let driver = asio.load_driver("ASIO4ALL v2").expect("load ASIO4ALL");
        let channels = asio_sys::input_channel_names().expect("query named inputs");
        assert!(!channels.is_empty());
        for (index, (name, group)) in channels.iter().enumerate() {
            assert!(!name.is_empty());
            eprintln!("ASIO input {}: {} (group {})", index + 1, name, group);
        }
        drop(driver);
        unsafe { windows_sys::Win32::System::Com::CoUninitialize(); }
    }

    #[cfg(feature = "asio")]
    #[test]
    #[ignore = "requires an installed ASIO4ALL driver and audio hardware"]
    fn asio4all_input_output_and_driver_switch() {
        assert!(asio_names().iter().any(|n| n == "ASIO4ALL v2"));
        let link = start(|| Box::new(loom_engine::SampleCache::default().build(&loom_engine::Project::default())), |_| {});
        link.restart(Some("asio:ASIO4ALL v2".into())).expect("open ASIO4ALL");
        let info = link.info.lock().unwrap().clone();
        eprintln!("ASIO device: {} · {} Hz · {} outputs · {}", info.device, info.sr, info.channels, info.format);
        assert_eq!(info.driver, "ASIO");
        link.send(Cmd::Mode(Mode::Song)); link.send(Cmd::Pos(384.0)); link.send(Cmd::Play);
        for _ in 0..100 {
            if link.shared.pos() > 384.0 { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(link.shared.pos() > 384.0, "ASIO output callback must render the transport (pos {}, playing {})", link.shared.pos(), link.shared.playing.load(Ordering::Relaxed));
        let input = crate::rec::Input::new();
        let feed = input.open(Some(info.id.clone()), info.sr, link.device.lock().unwrap().clone()).expect("open ASIO input");
        link.send(Cmd::Input(feed.map(|f| Box::new(f) as Box<dyn InputSource>)));
        let dir = std::env::temp_dir().join(format!("loom-asio-test-{}", std::process::id()));
        input.rec_start(vec![crate::rec::TakeSpec { path: dir.join("input1.wav"), track: 1, mode: 1 }, crate::rec::TakeSpec { path: dir.join("stereo.wav"), track: 2, mode: 3 }]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(250));
        let takes = input.rec_stop();
        assert_eq!(takes.len(), 2);
        for take in &takes { assert!(take.seconds > 0.1); assert!(take.start_us > 0); }
        assert_eq!(takes[0].channels, 1); assert_eq!(takes[1].channels, 2);
        eprintln!("ASIO recording: {} files, {:.3} s", takes.len(), takes[0].seconds);
        input.close(); link.send(Cmd::Input(None)); link.send(Cmd::Stop);
        link.restart(None).expect("return to WASAPI");
        assert_eq!(link.info.lock().unwrap().driver, "WASAPI");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn build<T: cpal::SizedSample + cpal::FromSample<f32>>(
    dev: &cpal::Device,
    cfg: &cpal::StreamConfig,
    mut eng: Engine,
    mut rx: rtrb::Consumer<Cmd>,
    mut trash: rtrb::Producer<Trash>,
    ch: usize,
    link: Arc<Link>,
) -> Result<cpal::Stream, String> {
    const CHUNK: usize = 4096;
    let (mut bl, mut br) = (vec![0f32; CHUNK], vec![0f32; CHUNK]);
    let sr = cfg.sample_rate as f64;
    let shared: Arc<Shared> = link.shared.clone();
    let cb = move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
        let t0 = std::time::Instant::now();
        let cb_us = now_us();
        let ts = info.timestamp();
        let lat = ts.playback.duration_since(ts.callback).as_micros() as u64;
        link.out_latency_us.store(lat, Ordering::Relaxed);
        let clock0 = eng.clock();
        while let Ok(c) = rx.pop() {
            // a full trash ring drops here; it holds 256, the UI empties it many times a second
            match c {
                Cmd::Song(s) => {
                    let _ = trash.push(Trash::Song(eng.set_song(s)));
                }
                Cmd::Play => eng.play(),
                Cmd::PlayCountIn(bars) => eng.play_count_in(bars),
                Cmd::Input(src) => {
                    if let Some(old) = eng.set_input(src) {
                        let _ = trash.push(Trash::Input(old));
                    }
                }
                Cmd::MonitorMaster(on) => eng.set_monitor_master(on),
                Cmd::Taps(t) => {
                    let old = eng.set_taps(t);
                    if !old.is_empty() {
                        let _ = trash.push(Trash::Taps(old));
                    }
                }
                Cmd::Stop => eng.stop(),
                Cmd::Pos(t) => eng.set_pos(t),
                Cmd::Mode(m) => eng.set_mode(m),
                Cmd::NoteOn(c, k, v) => eng.note_on(c, k, v),
                Cmd::NoteOff(c, k) => eng.note_off(c, k),
                Cmd::Panic => eng.panic(),
                Cmd::Metronome(on) => eng.set_metronome(on),
                Cmd::OutputGain(g) => eng.set_output_gain(g),
                Cmd::StopAtLoopEnd(on) => eng.set_stop_at_loop_end(on),
                Cmd::AddPlugin(id, p) => {
                    if let Some(old) = eng.add_plugin(id, p) {
                        let _ = trash.push(Trash::Plugin(old));
                    }
                }
                Cmd::RemovePlugin(id) => {
                    if let Some(old) = eng.remove_plugin(id) {
                        let _ = trash.push(Trash::Plugin(old));
                    }
                }
                Cmd::Preview(b) => {
                    if let Some(old) = eng.preview(b) {
                        let _ = trash.push(Trash::Sample(old));
                    }
                }
            }
        }
        let mut frames_total = 0;
        for frames in data.chunks_mut(CHUNK * ch) {
            let n = frames.len() / ch;
            frames_total += n;
            eng.process(&mut bl[..n], &mut br[..n]);
            // the engine's master is not limited (meters show past 0 dB); the device takes ±1
            for s in bl[..n].iter_mut().chain(br[..n].iter_mut()) {
                *s = s.clamp(-1.0, 1.0);
            }
            for (i, f) in frames.chunks_exact_mut(ch).enumerate() {
                if ch == 1 {
                    f[0] = T::from_sample((bl[i] + br[i]) * 0.5);
                } else {
                    f[0] = T::from_sample(bl[i]);
                    f[1] = T::from_sample(br[i]);
                    for s in f.iter_mut().skip(2) {
                        *s = T::from_sample(0.0);
                    }
                }
            }
        }
        // when the transport really started: this callback's sound comes out `lat` from now,
        // and the start sat that many frames into it
        if let Some(s) = eng.take_started() {
            let off = s.saturating_sub(clock0) as f64 / sr * 1e6;
            link.play_wall_us.store(cb_us + lat + off as u64, Ordering::Relaxed);
        }
        // how much of the block's time the engine used
        if frames_total > 0 {
            let budget = frames_total as f64 / sr;
            let load = (t0.elapsed().as_secs_f64() / budget * 1000.0) as u32;
            shared.load.store(load, std::sync::atomic::Ordering::Relaxed);
        }
    };
    dev.build_output_stream(cfg.clone(), cb, |e| eprintln!("audio: {e}"), None).map_err(|e| e.to_string())
}
