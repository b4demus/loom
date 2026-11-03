//! CPU-only, disposable inference process. stdout is newline-delimited progress JSON.
mod inference;
#[path = "../../vendor/demucs-core/src/dsp/resample.rs"]
mod resample;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, time::Duration};

const MODEL_URL: &str = "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs.onnx";
const MODEL_SHA: &str = "68d0bf16428ef66e692cdff8a9ccf28f1ef3f69440d57e58605a4cc55fcc5e74";
const MODEL_BYTES: usize = 316_446_953;
const STEMS: [&str; 4] = ["vocals", "drums", "bass", "other"];

#[derive(Deserialize)]
struct Request { input: PathBuf, output: PathBuf, cache: PathBuf, stems: Vec<String> }

fn progress(phase: &str, fraction: f64) {
    println!("{}", serde_json::json!({ "phase": phase, "progress": fraction.clamp(0.0, 1.0) }));
    let _ = std::io::stdout().flush();
}

fn valid_model(data: &[u8]) -> bool {
    data.len() == MODEL_BYTES && format!("{:x}", Sha256::digest(data)) == MODEL_SHA
}

fn weights(cache: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let path = cache.join("htdemucs-fp32.onnx");
    progress("model", 0.0);
    if let Ok(data) = fs::read(&path) { if valid_model(&data) { return Ok(path); } }
    progress("download", 0.0);
    let tls = ureq::native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let agent = ureq::AgentBuilder::new().tls_connector(std::sync::Arc::new(tls))
        .timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(30)).build();
    let response = agent.get(MODEL_URL).call().map_err(|e| format!("Model download: {e}"))?;
    let mut reader = response.into_reader();
    let mut data = Vec::with_capacity(MODEL_BYTES);
    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        if data.len() + n > MODEL_BYTES { return Err("Model download is larger than expected".into()); }
        data.extend_from_slice(&buf[..n]);
        progress("download", data.len() as f64 / MODEL_BYTES as f64);
    }
    if !valid_model(&data) { return Err("Model checksum mismatch; please retry the download".into()); }
    // Atomic rename must stay on the cache's volume (projects may be on another drive).
    // The parent removes this process-specific partial after cancellation or a crash.
    let partial = cache.join(format!("htdemucs-{}.partial", std::process::id()));
    fs::write(&partial, &data).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn write_stem(path: &Path, left: &[f32], right: &[f32], frames: usize, sr: u32) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    let mut wav = hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| e.to_string())?;
    // Resampling may round by a sample: preserve the source's exact duration for clip offsets.
    for i in 0..frames {
        for channel in [left, right] {
            let v = channel.get(i).copied().unwrap_or(0.0);
            if !v.is_finite() { return Err("The separator produced invalid audio".into()); }
            wav.write_sample(v).map_err(|e| e.to_string())?;
        }
    }
    wav.finalize().map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    let request = std::env::args_os().nth(1).ok_or("Expected a request JSON file")?;
    let req: Request = serde_json::from_slice(&fs::read(request).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if req.stems.is_empty() || req.stems.iter().any(|s| !STEMS.contains(&s.as_str())) { return Err("Invalid stem selection".into()); }
    if !req.output.is_dir() { return Err("Output directory does not exist".into()); }
    progress("read", 0.0);
    let audio = loom_engine::decode::load(&req.input)?;
    let path = weights(&req.cache)?;
    progress("model", 0.0);
    let stems = inference::separate(&audio, &req.stems, &path, &req.cache)?;
    progress("write", 0.0);
    for stem in stems {
        let name = stem.name.as_str();
        if req.stems.iter().any(|s| s == name) {
            write_stem(&req.output.join(format!("{name}.wav")), &stem.left, &stem.right, audio.len(), audio.sr as u32)?;
        }
    }
    progress("done", 1.0);
    Ok(())
}

fn main() {
    let result = std::thread::Builder::new().name("loom-stems-cpu".into()).stack_size(8 * 1024 * 1024)
        .spawn(run).expect("could not start separator").join();
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => { eprintln!("{e}"); std::process::exit(1); }
        Err(_) => { eprintln!("The CPU separator failed"); std::process::exit(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn floats_preserve_levels_and_duration_without_clipping() {
        let dir = std::env::temp_dir().join(format!("loom-stem-wav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vocals.wav");
        let _ = fs::remove_file(&path);
        write_stem(&path, &[1.25, -0.5], &[0.75, -1.5], 3, 48000).unwrap();
        let mut wav = hound::WavReader::open(&path).unwrap();
        assert_eq!(wav.duration(), 3);
        assert_eq!(wav.samples::<f32>().map(Result::unwrap).collect::<Vec<_>>(), [1.25, 0.75, -0.5, -1.5, 0.0, 0.0]);
        drop(wav); fs::remove_file(path).unwrap(); fs::remove_dir(dir).unwrap();
    }
}
