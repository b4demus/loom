//! A below-normal-priority CPU worker, isolated from audio and the UI. Its Windows job
//! is killed on close, including when Loom exits unexpectedly.
use serde::Serialize;
use std::{fs, io::{BufRead, Read}, path::{Path, PathBuf}, process::{Child, Command, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use std::os::windows::{io::AsRawHandle, process::CommandExt};

const STEMS: [&str; 4] = ["vocals", "drums", "bass", "other"];

#[derive(Clone, Serialize)]
pub struct Output { pub stem: String, pub path: String, pub seconds: f64 }
#[derive(Clone, Serialize)]
pub struct Status {
    pub id: String, pub phase: String, pub progress: f64, pub running: bool,
    pub cancelled: bool, pub error: Option<String>, pub outputs: Vec<Output>,
}
struct Job { status: Mutex<Status>, cancel: AtomicBool }
#[derive(Default)]
pub struct Jobs { current: Mutex<Option<Arc<Job>>> }

fn selected(stems: Vec<String>) -> Result<Vec<String>, String> {
    if stems.is_empty() || stems.iter().any(|s| !STEMS.contains(&s.as_str())) {
        return Err("Select vocals, drums, bass or other instruments".into());
    }
    Ok(STEMS.iter().filter(|s| stems.iter().any(|x| x == **s)).map(|s| s.to_string()).collect())
}

fn safe_name(name: &str) -> String {
    let s: String = name.chars().take(48).map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if s.is_empty() { "audio".into() } else { s }
}

impl Jobs {
    pub fn start(&self, input: String, name: String, stems: Vec<String>, root: PathBuf, cache: PathBuf) -> Result<String, String> {
        let stems = selected(stems)?;
        let input = PathBuf::from(input).canonicalize().map_err(|e| format!("Audio file: {e}"))?;
        if !input.is_file() { return Err("The audio source is not a file".into()); }
        let worker = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("loom-stems.exe");
        if !worker.is_file() { return Err("loom-stems.exe is missing next to loom.exe. Reinstall the complete Loom build.".into()); }
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|j| j.status.lock().unwrap().running) { return Err("Stem separation is already running".into()); }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let id = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos().to_string();
        let folder = root.join(format!("stem-{}-{id}", safe_name(&name)));
        fs::create_dir(&folder).map_err(|e| e.to_string())?;
        let job = Arc::new(Job { status: Mutex::new(Status {
            id: id.clone(), phase: "read".into(), progress: 0.0, running: true,
            cancelled: false, error: None, outputs: vec![],
        }), cancel: AtomicBool::new(false) });
        let j = job.clone();
        let dir = folder.clone();
        let spawned = std::thread::Builder::new().name("loom-stems-job".into()).spawn(move || {
            let result = run(&j, &worker, &input, &dir, &cache, &stems);
            let cancelled = j.cancel.load(Ordering::Acquire);
            if result.is_err() || cancelled { cleanup(&dir, &stems); }
            else { let _ = fs::remove_file(dir.join("request.json")); }
            let mut status = j.status.lock().unwrap();
            status.running = false;
            status.cancelled = cancelled;
            if cancelled { status.phase = "cancelled".into(); }
            else { match result {
                Ok(outputs) => { status.outputs = outputs; status.phase = "done".into(); status.progress = 1.0; }
                Err(e) => { status.error = Some(e); status.phase = "error".into(); }
            } }
        });
        if let Err(e) = spawned { let _ = fs::remove_dir(&folder); return Err(e.to_string()); }
        *current = Some(job);
        Ok(id)
    }
    pub fn status(&self, id: &str) -> Result<Status, String> {
        let current = self.current.lock().unwrap();
        let job = current.as_ref().ok_or("No stem separation job")?;
        let status = job.status.lock().unwrap();
        if status.id != id { return Err("Unknown stem separation job".into()); }
        Ok(status.clone())
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let current = self.current.lock().unwrap();
        let job = current.as_ref().ok_or("No stem separation job")?;
        let mut status = job.status.lock().unwrap();
        if status.id != id { return Err("Unknown stem separation job".into()); }
        if status.running { job.cancel.store(true, Ordering::Release); status.phase = "cancelling".into(); }
        Ok(())
    }
}
impl Drop for Jobs {
    fn drop(&mut self) { if let Some(job) = self.current.get_mut().unwrap().as_ref() { job.cancel.store(true, Ordering::Release); } }
}

struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
            let job = Self(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as _, std::mem::size_of_val(&info) as u32) == 0
                || AssignProcessToJobObject(h, child.as_raw_handle() as _) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(job)
        }
    }
}
impl Drop for ProcessJob {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

fn cleanup(folder: &Path, stems: &[String]) {
    for name in stems { let _ = fs::remove_file(folder.join(format!("{name}.wav"))); }
    for name in ["request.json", "model.partial"] { let _ = fs::remove_file(folder.join(name)); }
    let _ = fs::remove_dir(folder); // succeeds only for our now-empty job directory
}

fn run(job: &Arc<Job>, worker: &Path, input: &Path, folder: &Path, cache: &Path, stems: &[String]) -> Result<Vec<Output>, String> {
    if job.cancel.load(Ordering::Acquire) { return Err("Cancelled".into()); }
    let request = folder.join("request.json");
    fs::write(&request, serde_json::to_vec(&serde_json::json!({ "input": input, "output": folder, "cache": cache, "stems": stems })).unwrap()).map_err(|e| e.to_string())?;
    // Leave CPU capacity for the audio thread and the rest of the desktop.
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(2).clamp(1, 4);
    let mut child = Command::new(worker).arg(&request).env("LOOM_STEMS_THREADS", threads.to_string())
        .creation_flags(0x08000000 | 0x00004000) // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let _process_job = match ProcessJob::attach(&child) { Ok(j) => j, Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e); } };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let j = job.clone();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if j.cancel.load(Ordering::Acquire) { continue; }
                let mut status = j.status.lock().unwrap();
                if let Some(phase) = v["phase"].as_str().filter(|s| ["read", "model", "download", "optimize", "separate", "write", "done"].contains(s)) {
                    status.phase = phase.into();
                    status.progress = v["progress"].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0);
                }
            }
        }
    });
    let errors = std::thread::spawn(move || {
        let mut stderr = stderr; let mut out = Vec::new(); let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) { if n == 0 { break; } let keep = n.min(8192usize.saturating_sub(out.len())); out.extend_from_slice(&buf[..keep]); }
        String::from_utf8_lossy(&out).into_owned()
    });
    let exit = loop {
        if job.cancel.load(Ordering::Acquire) { let _ = child.kill(); break child.wait(); }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); break Err(e); }
        }
    };
    let _ = reader.join();
    let error = errors.join().unwrap_or_default();
    let _ = fs::remove_file(cache.join(format!("htdemucs-{}.partial", child.id())));
    let _ = fs::remove_file(cache.join(format!("htdemucs-{}.ort", child.id())));
    if job.cancel.load(Ordering::Acquire) { return Err("Cancelled".into()); }
    let exit = exit.map_err(|e| e.to_string())?;
    if !exit.success() { return Err(if error.trim().is_empty() { format!("CPU separator exited ({exit}); try a shorter audio file") } else { error }); }
    let mut outputs = vec![];
    let mut shape = None;
    for stem in stems {
        let path = folder.join(format!("{stem}.wav"));
        let wav = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = wav.spec(); let frames = wav.duration();
        if spec.channels != 2 || spec.sample_rate == 0 || frames == 0 || shape.is_some_and(|s| s != (frames, spec.sample_rate)) {
            return Err("The separator returned mismatched or empty stems".into());
        }
        shape = Some((frames, spec.sample_rate));
        outputs.push(Output { stem: stem.clone(), path: path.to_string_lossy().into_owned(), seconds: frames as f64 / spec.sample_rate as f64 });
    }
    Ok(outputs)
}

/// Headless developer check: exercises the same worker lifecycle as the UI.
pub fn self_test(input: String, root: PathBuf, cache: PathBuf, cancel: bool) -> Result<Status, String> {
    let jobs = Jobs::default();
    let id = jobs.start(input, "check".into(), STEMS.iter().map(|s| s.to_string()).collect(), root, cache)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(1200);
    let mut last = String::new();
    let mut requested = false;
    loop {
        let status = jobs.status(&id)?;
        if status.phase != last { println!("{}", serde_json::to_string(&status).unwrap()); last = status.phase.clone(); }
        if !status.running {
            if let Some(error) = status.error.as_ref() { return Err(error.clone()); }
            if cancel && !status.cancelled { return Err("Cancellation did not stop the worker".into()); }
            if !cancel && status.outputs.len() != 4 { return Err("Expected four stems".into()); }
            return Ok(status);
        }
        if cancel && !requested && status.phase == "separate" { jobs.cancel(&id)?; requested = true; }
        if std::time::Instant::now() > deadline { jobs.cancel(&id)?; return Err("Stem check timed out".into()); }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_is_validated_and_ordered_and_output_names_are_safe() {
        assert!(selected(vec![]).is_err());
        assert!(selected(vec!["../vocals".into()]).is_err());
        assert_eq!(selected(vec!["bass".into(), "vocals".into(), "bass".into()]).unwrap(), ["vocals", "bass"]);
        assert_eq!(safe_name("../x:<a>"), "___x__a_");
    }
    #[test]
    fn dropping_the_job_terminates_its_child_process() {
        let mut child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let job = ProcessJob::attach(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        let terminated = child.try_wait().unwrap().is_some();
        if !terminated { let _ = child.kill(); let _ = child.wait(); }
        assert!(terminated, "a separator must not survive its owning Loom process");
    }
}
