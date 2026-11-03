#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! loom: the window, the commands the UI calls, files and dialogs, and the plugin instances.
//!
//! Plugin instances live on the UI (main) thread in `PLUGINS`; commands reach them through
//! `on_main`. Their audio-side processors go to the engine; when the engine lets one go it
//! comes back through the trash and is freed on the main thread as well.

mod audio;
mod midi;
mod rec;
mod tap;
mod stems;

use audio::{Cmd, Link};
use loom_engine::engine::{MAX_BLOCK, MAX_CH, MAX_MIX};
use loom_engine::project::PluginDesc;
use loom_engine::{Mode, Project, SampleCache, Shared};
use loom_host::{Instance, PluginInfo, Processor, Setup};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct App {
    link: Arc<Link>,
    cache: Arc<Mutex<SampleCache>>,
    project: Arc<Mutex<Project>>,
    input: rec::Input,
    /// mixer tracks recording their own sound
    taps: tap::Taps,
    audio_gate: Mutex<()>,
    stems: stems::Jobs,
}

static HANDLE: OnceLock<AppHandle> = OnceLock::new();
static LINK: OnceLock<Arc<Link>> = OnceLock::new();

thread_local! {
    /// plugin instances by id; only ever touched on the main thread
    static PLUGINS: RefCell<HashMap<u32, Box<dyn Instance>>> = RefCell::new(HashMap::new());
    /// temporary instances used by an export in progress
    static EXPORTS: RefCell<HashMap<u64, Vec<Box<dyn Instance>>>> = RefCell::new(HashMap::new());
}

/// Runs `f` on the main thread and waits for its result. Only for async commands (they run
/// on worker threads): a sync command already runs on the main thread and would wait forever.
fn on_main<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    let app = HANDLE.get().ok_or("not started")?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "the main thread is gone".to_string())
}

/// Frees processors the engine gave back, on the main thread where their plugins live.
fn release(procs: Vec<Box<dyn Processor>>) {
    if procs.is_empty() {
        return;
    }
    if let Some(app) = HANDLE.get() {
        let _ = app.run_on_main_thread(move || drop(procs));
    }
}

fn setup(sr: f32) -> Setup {
    Setup { sr, max_block: MAX_BLOCK }
}

fn parse(json: &str) -> Result<Project, String> {
    serde_json::from_str(json).map_err(|e| format!("bad project: {e}"))
}

#[tauri::command]
fn set_project(app: State<App>, json: String) -> Result<(), String> {
    let p = parse(&json)?;
    let song = app.cache.lock().unwrap().build(&p);
    *app.project.lock().unwrap() = p;
    release(app.link.empty_trash());
    app.link.send(Cmd::Song(Box::new(song)));
    Ok(())
}

#[tauri::command]
fn transport(app: State<App>, action: String, value: Option<f64>) {
    match action.as_str() {
        // a value is the number of count-in bars
        "play" => app.link.send(match value {
            Some(b) if b >= 1.0 => Cmd::PlayCountIn(b as u32),
            _ => Cmd::Play,
        }),
        "stop" => app.link.send(Cmd::Stop),
        "pos" => app.link.send(Cmd::Pos(value.unwrap_or(0.0))),
        "panic" => app.link.send(Cmd::Panic),
        // recording over the playlist loop: stop at its end (1) or not (0)
        "stop_at_end" => app.link.send(Cmd::StopAtLoopEnd(value.unwrap_or(0.0) > 0.5)),
        _ => {}
    }
}

#[tauri::command]
fn set_mode(app: State<App>, song: bool, pattern: u32) {
    let m = if song { Mode::Song } else { Mode::Pattern(pattern) };
    *app.link.mode.lock().unwrap() = m;
    app.link.send(Cmd::Mode(m));
}

#[tauri::command]
fn note(app: State<App>, ch: u32, key: u8, vel: f32, on: bool) {
    app.link.send(if on { Cmd::NoteOn(ch, key, vel) } else { Cmd::NoteOff(ch, key) });
}

#[tauri::command]
fn set_metronome(app: State<App>, on: bool) {
    *app.link.metronome.lock().unwrap() = on;
    app.link.send(Cmd::Metronome(on));
}

/// The app's own volume (the knob at the top): the speakers, not the master track.
#[tauri::command]
fn set_output_gain(app: State<App>, gain: f32) {
    let g = if gain.is_finite() { gain.clamp(0.0, 1.5) } else { 1.0 };
    *app.link.out_gain.lock().unwrap() = g;
    app.link.send(Cmd::OutputGain(g));
}

#[tauri::command]
fn rec_inputs(app: State<App>) -> Vec<String> {
    let info = app.link.info.lock().unwrap().clone();
    if info.driver == "ASIO" { vec![info.device] } else { rec::input_devices() }
}

#[tauri::command]
async fn mixer_inputs(app: State<'_, App>, device: Option<String>) -> Result<audio::InputCatalog, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let _gate = app.audio_gate.lock().unwrap();
    let info = app.link.info.lock().unwrap().clone();
    if info.driver == "ASIO" {
        let channels = app.link.input_channels()?;
        return Ok(audio::InputCatalog { device: info.device, driver: info.driver, choices: audio::input_choices(&channels) });
    }
    let host = cpal::default_host();
    let source = device.and_then(|name| host.input_devices().ok().and_then(|mut ds| ds.find(|d| d.description().ok().is_some_and(|d| d.name() == name)))).or_else(|| host.default_input_device());
    let Some(source) = source else { return Ok(audio::InputCatalog { device: String::new(), driver: "WASAPI".into(), choices: vec![] }) };
    let name = source.description().map(|d| d.name().to_owned()).unwrap_or_default();
    let count = source.default_input_config().map_err(|e| e.to_string())?.channels().min(64);
    let channels: Vec<_> = (0..count).map(|index| audio::InputChannel { index: index as u32, name: if count == 1 { name.clone() } else { format!("{name} · {}", index + 1) }, group: 0 }).collect();
    Ok(audio::InputCatalog { device: name, driver: "WASAPI".into(), choices: audio::input_choices(&channels) })
}

/// Opens the input (or keeps it open) and hands a fresh feed of it to the engine when it
/// (re)opened. Mixer tracks with an input set hear it from then on.
fn open_input(app: &App, device: Option<String>) -> Result<(), String> {
    let _gate = app.audio_gate.lock().unwrap();
    open_input_unlocked(app, device)
}

fn open_input_unlocked(app: &App, device: Option<String>) -> Result<(), String> {
    let info = app.link.info.lock().unwrap().clone();
    let (device, source) = if info.driver == "ASIO" {
        (Some(info.id), app.link.device.lock().unwrap().clone())
    } else { (device, None) };
    if let Some(feed) = app.input.open(device, app.link.sample_rate() as u32, source)? {
        app.link.send(Cmd::Input(Some(Box::new(feed))));
    }
    Ok(())
}

#[tauri::command]
async fn input_open(app: State<'_, App>, device: Option<String>) -> Result<(), String> {
    open_input(&app, device)
}

#[tauri::command]
async fn input_close(app: State<'_, App>) -> Result<(), String> {
    let _gate = app.audio_gate.lock().unwrap();
    if !app.input.recording() {
        app.link.send(Cmd::Input(None));
        app.input.close();
    }
    Ok(())
}

#[derive(Deserialize)]
struct RecTrack {
    track: u32,
    mode: u32,
}

/// Starts recording into `<folder>\<name>`: the project's own folder when it has been saved,
/// otherwise the default recordings folder. One file per armed mixer track (its input), or, with no
/// track, one file of the whole input (heard in the master with `monitor`). Returns the paths.
#[tauri::command]
async fn rec_start(handle: AppHandle, app: State<'_, App>, device: Option<String>, project: Option<String>, name: String, tracks: Vec<RecTrack>, monitor: bool) -> Result<Vec<String>, String> {
    let _gate = app.audio_gate.lock().unwrap();
    let dir = take_dir(&handle, project.as_deref(), "recordings")?;
    open_input_unlocked(&app, device)?;
    let stem = name.trim_end_matches(".wav").to_string();
    let specs: Vec<rec::TakeSpec> = if tracks.is_empty() {
        vec![rec::TakeSpec { path: dir.join(&name), track: 0, mode: 0 }]
    } else {
        tracks.iter().map(|t| rec::TakeSpec { path: dir.join(format!("{stem}_ins{}.wav", t.track)), track: t.track, mode: t.mode }).collect()
    };
    let paths = specs.iter().map(|s| s.path.to_string_lossy().into_owned()).collect();
    // the start time of this take's music is not known yet
    app.link.play_wall_us.store(0, std::sync::atomic::Ordering::Relaxed);
    app.input.rec_start(specs)?;
    app.link.send(Cmd::MonitorMaster(tracks.is_empty() && monitor));
    Ok(paths)
}

/// Use the project folder if saved, or the default output folder for this launch mode.
fn take_dir(handle: &AppHandle, project: Option<&str>, sub: &str) -> Result<PathBuf, String> {
    Ok(match project.and_then(|p| Path::new(p).parent()) {
        Some(d) => d.join(sub),
        None if handle.config().app.app_directories_override.is_some() => {
            handle.path().app_data_dir().map_err(|e| e.to_string())?.join(sub)
        }
        None => handle.path().document_dir().map_err(|e| e.to_string())?.join("loom").join(sub),
    })
}

/// Armed mixer tracks record their own sound (effects and fader included) while the transport
/// runs: one file per track, `<stem>_mix<track>.wav`. Returns the paths.
#[tauri::command]
async fn tap_start(handle: AppHandle, app: State<'_, App>, project: Option<String>, name: String, tracks: Vec<u32>) -> Result<Vec<String>, String> {
    let dir = take_dir(&handle, project.as_deref(), "recordings")?;
    let stem = name.trim_end_matches(".wav").to_string();
    let specs: Vec<(u32, PathBuf)> = tracks.iter().map(|&t| (t, dir.join(format!("{stem}_mix{t}.wav")))).collect();
    let paths = specs.iter().map(|s| s.1.to_string_lossy().into_owned()).collect();
    let sinks = app.taps.start(specs, app.link.sample_rate() as u32)?;
    app.link.send(Cmd::Taps(sinks));
    Ok(paths)
}

/// Ends the mixer-track takes; each says where on the timeline it starts.
#[tauri::command]
async fn tap_stop(app: State<'_, App>) -> Result<Vec<tap::TapTake>, String> {
    if !app.taps.recording() {
        return Ok(vec![]);
    }
    app.link.send(Cmd::Taps(vec![]));
    let link = app.link.clone();
    Ok(app.taps.stop(move || {
        // the engine hands the sinks back through its trash; dropping them ends the files
        release(link.empty_trash());
        std::thread::sleep(std::time::Duration::from_millis(10));
        true
    }))
}
#[derive(Serialize)]
struct LiveTake {
    /// "in:<track>" for an input take, "mix:<track>" for a mixer track's own sound
    key: String,
    track: u32,
    /// where a mixer track's take starts on the timeline, once its first block came
    tick: Option<f64>,
    /// new min/max pairs, one per 10 ms
    peaks: Vec<f32>,
}

/// What the takes being recorded got since the last call, to draw them as they grow.
#[tauri::command]
fn rec_live(app: State<App>) -> Vec<LiveTake> {
    let mut out: Vec<LiveTake> = app.input.live.lock().unwrap().iter()
        .map(|(track, p)| LiveTake { key: format!("in:{track}"), track: *track, tick: None, peaks: rec::drain(p) })
        .collect();
    out.extend(app.taps.live().into_iter().map(|(track, tick, peaks)| LiveTake { key: format!("mix:{track}"), track, tick, peaks }));
    out
}

/// Stops recording. Each take says how far its first sample sits from where the music started/// sounding (`offset_ms`, negative: it began earlier, e.g. during the count-in).
#[tauri::command]
async fn rec_stop(app: State<'_, App>) -> Result<Vec<rec::Take>, String> {
    app.link.send(Cmd::MonitorMaster(false));
    let mut takes = app.input.rec_stop();
    let play = app.link.play_wall_us.load(std::sync::atomic::Ordering::Relaxed);
    for t in takes.iter_mut() {
        if play > 0 && t.start_us > 0 {
            t.offset_ms = Some((t.start_us as f64 - play as f64) / 1000.0);
        }
    }
    Ok(takes)
}

#[derive(Serialize)]
struct Status {
    pos: f64,
    playing: bool,
    /// input peak while the input is open
    input: Option<f32>,
    recording: bool,
    /// how late the output sounds after the engine renders it
    out_latency_ms: f32,
    master: [f32; 2],
    chans: Vec<f32>,
    /// mixer tracks, left and right interleaved
    mix: Vec<f32>,
    voices: u32,
    /// share of the audio block the engine used, 0..1
    load: f32,
    sr: u32,
    error: Option<String>,
    /// plugin parameters the user grabbed in a plugin window: (plugin id, parameter)
    touched: Vec<(u32, u32)>,
    edits: Vec<(u32, loom_host::ParamEdit)>,
}

/// Polled by the UI. `follow`: automated plugin values (plugin id, parameter, 0..1) whose
/// plugin window should show them. Sync command: this runs on the main thread, with the plugins.
#[tauri::command]
fn status(app: State<App>, chans: usize, mix: usize, follow: Option<Vec<(u32, u32, f32)>>) -> Status {
    let s = &app.link.shared;
    let info = app.link.info.lock().unwrap().clone();
    release(app.link.empty_trash());
    let touched = PLUGINS.with(|m| {
        let mut m = m.borrow_mut();
        let touched = m.iter_mut().flat_map(|(pid, inst)| inst.touched().into_iter().map(move |p| (*pid, p))).collect::<Vec<_>>();
        for (pid, id, v) in follow.unwrap_or_default() {
            if touched.contains(&(pid, id)) { continue; }
            if let Some(inst) = m.get_mut(&pid) {
                inst.follow_param(id, v);
            }
        }
        touched
    });
    let edits = take_plugin_edits();
    use std::sync::atomic::Ordering::Relaxed;
    Status {
        pos: s.pos(),
        playing: s.playing.load(Relaxed),
        input: app.input.is_open().then(|| Shared::take_peak(&app.input.level)),
        recording: app.input.recording(),
        out_latency_ms: app.link.out_latency_us.load(Relaxed) as f32 / 1000.0,
        master: [Shared::take_peak(&s.master[0]), Shared::take_peak(&s.master[1])],
        chans: s.peaks.iter().take(chans.min(MAX_CH)).map(Shared::take_peak).collect(),
        mix: s.mix_peaks.iter().take(mix.min(MAX_MIX) * 2).map(Shared::take_peak).collect(),
        voices: s.voices.load(Relaxed),
        load: s.load.load(Relaxed) as f32 / 1000.0,
        sr: info.sr,
        error: info.error,
        touched,
        edits,
    }
}

/// The automatable parameters of a loaded plugin.
#[tauri::command]
async fn plugin_params(id: u32) -> Result<Vec<loom_host::ParamInfo>, String> {
    on_main(move || PLUGINS.with(|m| m.borrow_mut().get_mut(&id).map(|i| i.params())))?.ok_or_else(|| "the plugin is not loaded".into())
}

fn take_plugin_edits() -> Vec<(u32, loom_host::ParamEdit)> {
    PLUGINS.with(|m| m.borrow_mut().iter_mut().flat_map(|(pid, i)| i.take_edits().into_iter().map(move |edit| (*pid, edit))).collect())
}

#[tauri::command]
async fn plugin_edits() -> Result<Vec<(u32, loom_host::ParamEdit)>, String> {
    on_main(take_plugin_edits)
}

#[tauri::command]
async fn plugin_set_params(id: u32, values: Vec<(u32, f32)>) -> Result<(), String> {
    on_main(move || PLUGINS.with(|m| {
        let mut m = m.borrow_mut();
        let inst = m.get_mut(&id).ok_or_else(|| "the plugin is not loaded".to_string())?;
        for (param, value) in values { if value.is_finite() { inst.set_param(param, value); } }
        // Some plugins report host-driven values back as edits. They are not user gestures.
        inst.take_edits();
        inst.touched();
        Ok(())
    }))?
}

#[derive(Serialize)]
struct Devices {
    list: Vec<audio::DeviceChoice>,
    info: audio::DeviceInfo,
}

#[tauri::command]
fn audio_devices(app: State<App>) -> Devices {
    Devices { list: audio::output_devices(), info: app.link.info.lock().unwrap().clone() }
}

#[tauri::command]
async fn set_device(app: State<'_, App>, device: Option<String>) -> Result<(), String> {
    let _gate = app.audio_gate.lock().unwrap();
    if app.input.recording() {
        return Err("Stop recording before changing the audio device".into());
    }
    let listening = app.input.is_open();
    let previous = app.link.info.lock().unwrap().id.clone();
    let input_device = app.input.selected_device().filter(|s| !s.starts_with("asio:"));
    app.link.send(Cmd::Input(None));
    app.input.close();
    if let Err(error) = app.link.restart(device) {
        // the host thread is still stuck in the driver: a fallback would only wait as long again
        if error == audio::DRIVER_TIMEOUT { return Err(error); }
        // A driver that cannot open must not leave a working project without audio.
        let _ = app.link.restart(if previous.is_empty() { None } else { Some(previous) });
        if listening { let _ = open_input_unlocked(&app, input_device); }
        return Err(error);
    }
    if listening { open_input_unlocked(&app, input_device)?; }
    Ok(())
}

#[tauri::command]
fn audio_panel(app: State<App>) -> Result<(), String> {
    if app.input.recording() { return Err("Stop recording before opening the ASIO panel".into()); }
    app.link.panel();
    Ok(())
}

// ---------- samples and the browser ----------

#[derive(Serialize)]
struct Sample {
    path: String,
    name: String,
    seconds: f32,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

const AUDIO_EXT: &[&str] = &["wav", "aif", "aiff", "flac", "mp3", "ogg"];

#[tauri::command]
async fn pick_sample(handle: AppHandle, app: State<'_, App>) -> Result<Option<Sample>, String> {
    let Some(fp) = handle.dialog().file().add_filter("audio", AUDIO_EXT).blocking_pick_file() else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    load_sample(app, path.to_string_lossy().into_owned()).await.map(Some)
}

/// also used for files dropped on the window; async so decoding a long file does not stall the window
#[tauri::command]
async fn load_sample(app: State<'_, App>, path: String) -> Result<Sample, String> {
    let buf = app.cache.lock().unwrap().load(&path)?;
    Ok(Sample { name: file_name(Path::new(&path)), path, seconds: buf.seconds() })
}

/// min/max pairs over `n` columns, for drawing a sample in the channel window
#[tauri::command]
fn sample_peaks(app: State<App>, sample: String, path: Option<String>, n: usize) -> Vec<f32> {
    let sp = loom_engine::project::SamplerParams { sample, path, ..Default::default() };
    let Some(buf) = app.cache.lock().unwrap().get(&sp) else { return vec![] };
    let n = n.clamp(1, 2048);
    let per = (buf.len() / n).max(1);
    let mut out = Vec::with_capacity(n * 2);
    for c in buf.l.chunks(per).take(n) {
        let (lo, hi) = c.iter().fold((0f32, 0f32), |(lo, hi), x| (lo.min(*x), hi.max(*x)));
        out.push(lo);
        out.push(hi);
    }
    out
}

#[derive(Serialize)]
struct Wave {
    seconds: f32,
    /// min/max pairs, evenly over the whole sound
    peaks: Vec<f32>,
}

/// A sound's length and its waveform for the playlist: about 400 columns a second
/// (at most 16384), both channels folded in.
#[tauri::command]
async fn sample_wave(app: State<'_, App>, sample: String, path: Option<String>) -> Result<Wave, String> {
    let sp = loom_engine::project::SamplerParams { sample, path: path.clone(), ..Default::default() };
    let buf = app.cache.lock().unwrap().get(&sp).ok_or_else(|| format!("cannot read {}", path.unwrap_or_default()))?;
    let n = ((buf.seconds() * 400.0) as usize).clamp(16, 16384);
    let per = buf.len().div_ceil(n).max(1);
    let mut peaks = Vec::with_capacity(n * 2);
    for (l, r) in buf.l.chunks(per).zip(buf.r.chunks(per)) {
        let (mut lo, mut hi) = (0f32, 0f32);
        for (a, b) in l.iter().zip(r) {
            lo = lo.min(*a).min(*b);
            hi = hi.max(*a).max(*b);
        }
        peaks.push(lo);
        peaks.push(hi);
    }
    Ok(Wave { seconds: buf.seconds(), peaks })
}

/// Plays a file or a kit sound once in the master; neither stops the current preview.
/// Returns the sound's length in seconds, so the UI knows how long it plays.
#[tauri::command]
async fn preview(app: State<'_, App>, path: Option<String>, sample: Option<String>) -> Result<Option<f32>, String> {
    let buf = match (path, sample) {
        (Some(p), _) => Some(app.cache.lock().unwrap().load(&p)?),
        (None, Some(s)) => {
            let sp = loom_engine::project::SamplerParams { sample: s, path: None, ..Default::default() };
            app.cache.lock().unwrap().get(&sp)
        }
        _ => None,
    };
    let secs = buf.as_ref().map(|b| b.seconds());
    app.link.send(Cmd::Preview(buf));
    Ok(secs)
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
    /// "audio" | "project" | "midi" | ""
    kind: &'static str,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = file_name(&p);
            if name.starts_with('.') || name.starts_with('$') {
                return None;
            }
            let dir = p.is_dir();
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            let kind = if AUDIO_EXT.contains(&ext.as_str()) { "audio" } else if ext == "loom" { "project" } else if ext == "mid" || ext == "midi" { "midi" } else { "" };
            (dir || !kind.is_empty()).then(|| Entry { name, path: p.to_string_lossy().into_owned(), dir, kind })
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
async fn pick_folder(handle: AppHandle) -> Result<Option<String>, String> {
    match handle.dialog().file().blocking_pick_folder() {
        Some(fp) => Ok(Some(fp.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

// ---------- plugins ----------

#[tauri::command]
fn plugin_default_folders() -> Vec<String> {
    loom_host::default_folders().iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct CacheEntry {
    stamp: u64,
    plugins: Vec<PluginInfo>,
    error: Option<String>,
}

#[derive(Serialize)]
struct ScanResult {
    plugins: Vec<PluginInfo>,
    /// files that could not be read: (path, why)
    failed: Vec<(String, String)>,
}

fn stamp(path: &Path) -> u64 {
    let bin = if path.is_dir() { path.join("Contents").join("x86_64-win").join(path.file_name().unwrap_or_default()) } else { path.to_path_buf() };
    std::fs::metadata(&bin)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
        .unwrap_or(0)
}

/// Probes one file in a child process (`loom --scan`), so a plugin that crashes or hangs
/// while loading only takes the child down.
fn scan_one(path: &Path) -> CacheEntry {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let st = stamp(path);
    let fail = |e: String| CacheEntry { stamp: st, plugins: vec![], error: Some(e) };
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => return fail(e.to_string()),
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = match Command::new(exe).arg("--scan").arg(path).stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn() {
        Ok(c) => c,
        Err(e) => return fail(e.to_string()),
    };
    let mut out = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = std::time::Instant::now();
    // shells with hundreds of plugins (Waves) need a while
    let limit = std::time::Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return fail("timed out".into());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(30)),
            Err(e) => return fail(e.to_string()),
        }
    }
    let text = reader.join().unwrap_or_default();
    for line in text.lines() {
        if let Some(j) = line.strip_prefix("LOOMSCAN:") {
            return match serde_json::from_str::<Vec<PluginInfo>>(j) {
                Ok(plugins) => CacheEntry { stamp: st, plugins, error: None },
                Err(e) => fail(e.to_string()),
            };
        }
        if let Some(e) = line.strip_prefix("LOOMSCAN-ERR:") {
            return fail(e.to_string());
        }
    }
    fail("the plugin crashed while loading".into())
}

#[tauri::command]
async fn plugin_scan(handle: AppHandle, folders: Vec<String>, rescan: bool) -> Result<ScanResult, String> {
    let dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let cache_path = dir.join("plugins.json");
    let mut cache: HashMap<String, CacheEntry> = if rescan {
        HashMap::new()
    } else {
        std::fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    };
    let folders: Vec<PathBuf> = folders.iter().map(PathBuf::from).collect();
    let files = loom_host::find_files(&folders);
    let todo: Vec<PathBuf> = files
        .iter()
        .filter(|f| cache.get(&f.to_string_lossy().into_owned()).is_none_or(|c| c.stamp != stamp(f)))
        .cloned()
        .collect();
    // a few children at a time
    let todo = Arc::new(Mutex::new(todo));
    let done = Arc::new(Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let (todo, done) = (todo.clone(), done.clone());
            std::thread::spawn(move || loop {
                let Some(f) = todo.lock().unwrap().pop() else { break };
                let e = scan_one(&f);
                done.lock().unwrap().push((f.to_string_lossy().into_owned(), e));
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    for (k, v) in done.lock().unwrap().drain(..) {
        cache.insert(k, v);
    }
    let _ = std::fs::write(&cache_path, serde_json::to_string(&cache).unwrap_or_default());
    let mut plugins = vec![];
    let mut failed = vec![];
    for f in &files {
        if let Some(c) = cache.get(&f.to_string_lossy().into_owned()) {
            plugins.extend(c.plugins.iter().cloned());
            if let Some(e) = &c.error {
                failed.push((f.to_string_lossy().into_owned(), e.clone()));
            }
        }
    }
    plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(ScanResult { plugins, failed })
}

#[derive(Serialize)]
struct Loaded {
    id: u32,
    name: String,
    instrument: bool,
    editor: bool,
    params: std::collections::BTreeMap<u32, f32>,
}

fn info_of(d: &PluginDesc) -> PluginInfo {
    PluginInfo { format: d.format.clone(), path: d.path.clone(), cid: d.cid.clone(), name: d.name.clone(), vendor: d.vendor.clone(), instrument: d.instrument }
}

/// Creates (or re-creates) instance `desc.id`, restores its state and hands its processor to the engine.
#[tauri::command]
async fn plugin_load(app: State<'_, App>, desc: PluginDesc) -> Result<Loaded, String> {
    let link = app.link.clone();
    on_main(move || {
        let mut inst = loom_host::load(&info_of(&desc), setup(link.sample_rate()))?;
        if !desc.state.is_empty() {
            if let Ok(bytes) = loom_host::b64_decode(&desc.state) {
                let _ = inst.set_state(&bytes);
            }
        }
        let current = inst.param_values();
        for (id, value) in &desc.params {
            if value.is_finite() && current.get(id) != Some(value) { inst.set_param(*id, *value); }
        }
        let params = inst.param_values();
        inst.take_edits(); inst.touched();
        link.send(Cmd::AddPlugin(desc.id, inst.processor()));
        let out = Loaded { id: desc.id, name: inst.info().name.clone(), instrument: inst.info().instrument, editor: inst.has_editor(), params };
        PLUGINS.with(|m| m.borrow_mut().insert(desc.id, inst));
        Ok(out)
    })?
}

#[tauri::command]
async fn plugin_unload(app: State<'_, App>, ids: Vec<u32>) -> Result<(), String> {
    let link = app.link.clone();
    on_main(move || {
        for id in ids {
            link.send(Cmd::RemovePlugin(id));
            // the processor may still be in the engine: the core lives on until it comes back
            PLUGINS.with(|m| m.borrow_mut().remove(&id));
        }
    })
}

#[tauri::command]
async fn plugin_loaded() -> Result<Vec<u32>, String> {
    on_main(|| PLUGINS.with(|m| m.borrow().keys().copied().collect()))
}

#[tauri::command]
async fn plugin_editor(id: u32, title: String) -> Result<(), String> {
    on_main(move || {
        let owner = HANDLE.get().and_then(|h| h.get_webview_window("main")).and_then(|w| w.hwnd().ok()).map_or(0, |h| h.0 as isize);
        PLUGINS.with(|m| match m.borrow_mut().get_mut(&id) {
            Some(inst) => inst.open_editor(owner, &title),
            None => Err("the plugin is not loaded".into()),
        })
    })?
}

#[derive(Serialize)]
struct PluginSnapshot {
    state: String,
    params: std::collections::BTreeMap<u32, f32>,
}

/// Capture state and editor values together on the UI thread for saving/copying.
#[tauri::command]
async fn plugin_states() -> Result<HashMap<u32, PluginSnapshot>, String> {
    on_main(|| PLUGINS.with(|m| m.borrow_mut().iter_mut().map(|(id, i)| (*id, PluginSnapshot {
        state: loom_host::b64_encode(&i.get_state()), params: i.param_values(),
    })).collect()))
}

// ---------- project files ----------

#[derive(Serialize)]
struct Opened {
    path: String,
    name: String,
    json: String,
}

#[tauri::command]
async fn open_project(handle: AppHandle, path: Option<String>) -> Result<Option<Opened>, String> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match handle.dialog().file().add_filter("loom", &["loom"]).blocking_pick_file() {
            Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    parse(&json)?;
    Ok(Some(Opened { name: file_name(&path), path: path.to_string_lossy().into_owned(), json }))
}

/// Saves to `path`, or asks where when there is none yet. Returns where it went.
#[tauri::command]
async fn save_project(handle: AppHandle, json: String, path: Option<String>) -> Result<Option<String>, String> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match handle.dialog().file().add_filter("loom", &["loom"]).set_file_name("untitled.loom").blocking_save_file() {
            Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let path = if path.extension().is_none() { path.with_extension("loom") } else { path };
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Renders offline. Plugins play through temporary copies made from their current state.
#[tauri::command]
async fn export_wav(handle: AppHandle, app: State<'_, App>, json: String, song: bool, pattern: u32, name: String) -> Result<Option<String>, String> {
    let p = parse(&json)?;
    let Some(fp) = handle.dialog().file().add_filter("wav", &["wav"]).set_file_name(format!("{name}.wav")).blocking_save_file() else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let mode = if song { Mode::Song } else { Mode::Pattern(pattern) };
    let out = render_offline(&app, &p, mode, 8.0)?;
    loom_engine::render::write_wav(&path, &out)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
struct Consolidated {
    path: String,
    seconds: f32,
}

#[tauri::command]
fn stems_start(handle: AppHandle, app: State<App>, input: String, project: Option<String>, name: String, stems: Vec<String>) -> Result<String, String> {
    let root = take_dir(&handle, project.as_deref(), "stems")?;
    let cache = handle.path().app_cache_dir().map_err(|e| e.to_string())?.join("models");
    app.stems.start(input, name, stems, root, cache)
}
#[tauri::command]
fn stems_status(app: State<App>, id: String) -> Result<stems::Status, String> { app.stems.status(&id) }
#[tauri::command]
fn stems_cancel(app: State<App>, id: String) -> Result<(), String> { app.stems.cancel(&id) }

/// Pre-render (FL's consolidate): the UI cuts the project down to the clips (shifted to start at
/// 0, effects on or off as asked) and this renders it to `<folder>\rendered\<name>.wav`. `len` is
/// what to keep in ticks; with `tail` whatever rings on past it (reverb, delay) stays too.
#[tauri::command]
async fn render_clips(handle: AppHandle, app: State<'_, App>, json: String, project: Option<String>, name: String, len: f64, tail: bool) -> Result<Consolidated, String> {
    let p = parse(&json)?;
    let mut out = render_offline(&app, &p, Mode::Song, if tail { 20.0 } else { 0.0 })?;
    let keep = ((len.max(1.0) * 60.0 / (p.bpm.clamp(10.0, 999.0) * loom_engine::project::PPQ as f64)) * out.sr as f64).round() as usize;
    let end = if tail {
        // past the clips, up to where the tail has died away
        let last = out.l.iter().zip(&out.r).rposition(|(a, b)| a.abs().max(b.abs()) > 1e-4).map_or(0, |i| i + 1);
        last.max(keep)
    } else { keep };
    out.l.resize(end, 0.0);
    out.r.resize(end, 0.0);
    let dir = take_dir(&handle, project.as_deref(), "rendered")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // never over an earlier render
    let mut path = dir.join(format!("{name}.wav"));
    let mut k = 2;
    while path.exists() {
        path = dir.join(format!("{name} {k}.wav"));
        k += 1;
    }
    loom_engine::render::write_wav(&path, &out)?;
    Ok(Consolidated { path: path.to_string_lossy().into_owned(), seconds: end as f32 / out.sr })
}

/// Renders a project offline at 48 kHz. Plugins play through temporary copies made from their
/// current state, so the live ones keep running.
fn render_offline(app: &App, p: &Project, mode: Mode, tail_sec: f32) -> Result<loom_engine::render::Rendered, String> {
    let built = app.cache.lock().unwrap().build(p);
    const SR: f32 = 48000.0;
    let token = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let descs = p.plugins.clone();
    let procs = on_main(move || {
        let mut temp = vec![];
        let mut procs: Vec<(u32, Box<dyn Processor>)> = vec![];
        for d in descs {
            let live = PLUGINS.with(|m| m.borrow_mut().get_mut(&d.id).map(|i| i.get_state()));
            let state = live.or_else(|| loom_host::b64_decode(&d.state).ok());
            if let Ok(mut inst) = loom_host::load(&info_of(&d), setup(SR)) {
                if let Some(s) = state.filter(|s| !s.is_empty()) {
                    let _ = inst.set_state(&s);
                }
                procs.push((d.id, inst.processor()));
                temp.push(inst);
            }
        }
        EXPORTS.with(|e| e.borrow_mut().insert(token, temp));
        procs
    })?;
    let (out, back) = loom_engine::render::render_with(Box::new(built), mode, SR, tail_sec, procs);
    let _ = on_main(move || {
        drop(back);
        EXPORTS.with(|e| e.borrow_mut().remove(&token));
    });
    Ok(out)
}

#[derive(Serialize)]
struct MidiImport {
    path: String,
    /// the file's name without its extension
    name: String,
    file: midi::MidiFile,
}

/// Reads a MIDI file (asks for one when no path is given).
#[tauri::command]
async fn midi_import(handle: AppHandle, path: Option<String>) -> Result<Option<MidiImport>, String> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match handle.dialog().file().add_filter("MIDI", &["mid", "midi"]).blocking_pick_file() {
            Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let file = midi::read(&bytes)?;
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(MidiImport { path: path.to_string_lossy().into_owned(), name, file }))
}

#[derive(Deserialize)]
struct MidiOutTrack {
    name: String,
    notes: Vec<midi::MidiNote>,
}

/// Writes notes as a MIDI file where the user says; returns the path.
#[tauri::command]
async fn midi_export(handle: AppHandle, bpm: f64, name: String, tracks: Vec<MidiOutTrack>) -> Result<Option<String>, String> {
    let Some(fp) = handle.dialog().file().add_filter("MIDI", &["mid"]).set_file_name(format!("{name}.mid")).blocking_save_file() else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let path = if path.extension().is_none() { path.with_extension("mid") } else { path };
    let tracks: Vec<(String, Vec<midi::MidiNote>)> = tracks.into_iter().map(|t| (t.name, t.notes)).collect();
    std::fs::write(&path, midi::write(bpm, &tracks)).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// a .loom passed on the command line (double-click in Explorer)
#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| a.to_lowercase().ends_with(".loom"))
}

/// `--demo` starts from the demo song, `--play` presses play (checks, screenshots)
#[tauri::command]
fn launch_flags() -> Vec<String> {
    std::env::args().skip(1).filter(|a| a.starts_with("--")).collect()
}

/// `--log`: the UI appends what it wants to %TEMP%\loom-dev.log (no console in release builds)
#[tauri::command]
fn dev_log(text: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("loom-dev.log")) {
        let _ = writeln!(f, "{text}");
    }
}

#[derive(Serialize, Clone)]
struct KeyEvent {
    code: &'static str,
    down: bool,
    repeat: bool,
}

/// After the audio device (re)starts: plugins follow the new sample rate and go into the new engine.
fn device_started(sr: f32) {
    let Some(app) = HANDLE.get() else { return };
    let _ = app.run_on_main_thread(move || {
        let Some(link) = LINK.get() else { return };
        PLUGINS.with(|m| {
            for (id, inst) in m.borrow_mut().iter_mut() {
                inst.reconfigure(setup(sr));
                link.send(Cmd::AddPlugin(*id, inst.processor()));
            }
        });
    });
}

/// An Alt key press puts a window with no menu bar into Windows' keyboard-menu mode: the next key
/// goes to that invisible menu instead of the page, so Alt+R (record) only worked every other
/// press. The main window swallows the keyboard-menu command; the page still gets every Alt key.
fn no_alt_menu(hwnd: isize) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};
    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_SYSCOMMAND && (wp & 0xFFF0) as u32 == SC_KEYMENU {
            return 0;
        }
        unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
    }
    unsafe { SetWindowSubclass(hwnd as HWND, Some(proc_), 1, 0) };
}

fn main() {    // child-process mode for the plugin scan: print what the file holds and leave
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--stemtest") {
        let result = (|| {
            let input = args.get(2).ok_or("Usage: --stemtest INPUT OUTPUT_FOLDER MODEL_CACHE [--cancel]")?.clone();
            let root = PathBuf::from(args.get(3).ok_or("Missing output folder")?);
            let cache = PathBuf::from(args.get(4).ok_or("Missing model cache")?);
            stems::self_test(input, root, cache, args.iter().any(|a| a == "--cancel"))
        })();
        let code = match result {
            Ok(status) => { println!("{}", serde_json::to_string(&status).unwrap()); 0 }
            Err(error) => { eprintln!("{error}"); 1 }
        };
        use std::io::Write;
        let _ = std::io::stdout().flush();
        std::process::exit(code);
    }
    if args.get(1).map(String::as_str) == Some("--scan") {
        let path = PathBuf::from(args.get(2).cloned().unwrap_or_default());
        match loom_host::probe(&path) {
            Ok(v) => println!("LOOMSCAN:{}", serde_json::to_string(&v).unwrap_or_default()),
            Err(e) => println!("LOOMSCAN-ERR:{e}"),
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
        // skip plugin teardown: some plugins misbehave on unload, and the answer is already out
        std::process::exit(0);
    }

    let mut context = tauri::generate_context!();
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        if dir.join("portable.txt").is_file() {
            context.config_mut().app.app_directories_override =
                Some(AppDirectoriesOverride::Root(dir.join("data")));
        }
    }

    let cache = Arc::new(Mutex::new(SampleCache::default()));
    let project = Arc::new(Mutex::new(Project::default()));
    let (c2, p2) = (cache.clone(), project.clone());
    let link = audio::start(
        move || {
            let p = p2.lock().unwrap().clone();
            let song = c2.lock().unwrap().build(&p);
            Box::new(song)
        },
        device_started,
    );
    let _ = LINK.set(link.clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(App { link, cache, project, input: rec::Input::new(), taps: tap::Taps::default(), audio_gate: Mutex::new(()), stems: stems::Jobs::default() })
        .setup(|app| {
            let _ = HANDLE.set(app.handle().clone());
            if let Some(h) = app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
                no_alt_menu(h.0 as isize);
                loom_host::window::set_main_window(h.0 as isize);
            }
            // keys typed into a plugin's window (Serum open, playing from the computer keyboard)
            // reach the page as "kbd" events; setup runs on the UI thread, where the hook belongs
            let h = app.handle().clone();
            loom_host::window::hook_keys(move |code, down, repeat| {
                use tauri::Emitter;
                let _ = h.emit("kbd", KeyEvent { code, down, repeat });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_project, transport, set_mode, note, status, audio_devices, set_device, audio_panel,
            set_metronome, set_output_gain, plugin_params, rec_inputs, mixer_inputs, rec_start, rec_stop, input_open, input_close,
            pick_sample, load_sample, sample_peaks, sample_wave, preview, list_dir, pick_folder,
            plugin_default_folders, plugin_scan, plugin_load, plugin_unload, plugin_loaded, plugin_editor, plugin_states, plugin_edits, plugin_set_params,
            open_project, save_project, export_wav, render_clips, stems_start, stems_status, stems_cancel, tap_start, tap_stop, rec_live, midi_import, midi_export, launch_file, launch_flags, dev_log
        ])
        .build(context)
        .expect("error while running loom")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                shut_down(&handle.state::<App>());
            }
        });
}

/// Runs on the main thread before the process goes. Tauri ends with `exit`, which runs no
/// destructors: without this, plugins never get terminate/effClose and their DLLs stay loaded
/// while ExitProcess kills their worker threads mid-request, and the process can stay stuck in
/// the kernel for good (one thread, unkillable), holding whatever it had open.
fn shut_down(app: &App) {
    // the audio first: the engine's processors go with the stream, while the instances here
    // still hold every plugin core, so no core is torn down on the audio host thread
    app.input.close();
    app.link.shutdown();
    drop(app.link.empty_trash());
    // now each plugin's last reference goes, on its own thread: editor closed, terminated, unloaded
    PLUGINS.with(|m| m.borrow_mut().clear());
    EXPORTS.with(|m| m.borrow_mut().clear());
}
