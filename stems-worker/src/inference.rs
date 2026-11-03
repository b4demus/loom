//! Same standard HTDemucs network, executed by ONNX Runtime's optimized CPU kernels.
use crate::{progress, resample::resample_channel};
use loom_engine::sampler::SampleBuf;
use ort::{session::{Session, builder::GraphOptimizationLevel}, value::TensorRef};
use std::{borrow::Cow, fs, path::Path};

const SEGMENT: usize = 343_980;
const STRIDE: usize = SEGMENT * 3 / 4;
const RATE: u32 = 44100;
const ORDER: [&str; 4] = ["drums", "bass", "other", "vocals"];
pub struct Stem { pub name: String, pub left: Vec<f32>, pub right: Vec<f32> }

fn starts(frames: usize) -> impl Iterator<Item = usize> {
    let chunks = frames.saturating_sub(SEGMENT).div_ceil(STRIDE) + 1;
    (0..chunks).map(|i| i * STRIDE)
}

fn blend(i: usize, len: usize) -> f32 {
    if len <= 1 { 1.0 } else { (1.0 - (2.0 * i as f32 / (len - 1) as f32 - 1.0).abs()).max(1e-5) }
}

fn session(model: &Path, cache: &Path, threads: usize) -> Result<Session, String> {
    let dll = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("onnxruntime.dll");
    ort::init_from(&dll).map_err(|e| format!("CPU runtime: {e}. Keep onnxruntime.dll next to loom-stems.exe."))?
        .with_name("loom-stems-cpu").with_telemetry(false).commit();
    let builder = || Session::builder().map_err(|e| e.to_string())?
        .with_intra_threads(threads).map_err(|e| e.to_string())?
        .with_inter_threads(1).map_err(|e| e.to_string())?
        .with_parallel_execution(false).map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string());
    // Optimization is done once per machine, not once per clip. Never publish a
    // partially-written graph if the user cancels during the initial preparation.
    let cpu = if std::is_x86_feature_detected!("avx512f") { "avx512" } else if std::is_x86_feature_detected!("avx2") { "avx2" } else { "sse2" };
    let optimized = cache.join(format!("htdemucs-68d0bf16-ort124-{cpu}.ort"));
    if optimized.is_file() {
        if let Ok(session) = builder()?.commit_from_file(&optimized) { return Ok(session); }
        let _ = fs::remove_file(&optimized);
    }
    progress("optimize", 0.0);
    let partial = cache.join(format!("htdemucs-{}.ort", std::process::id()));
    let result = builder()?.with_optimized_model_path(&partial).map_err(|e| e.to_string())?
        .commit_from_file(model).map_err(|e| e.to_string())?;
    if partial.is_file() { let _ = fs::rename(&partial, &optimized); }
    Ok(result)
}

pub fn separate(audio: &SampleBuf, selected: &[String], model: &Path, cache: &Path) -> Result<Vec<Stem>, String> {
    let channels: [Cow<'_, [f32]>; 2] = if audio.sr as u32 == RATE {
        [Cow::Borrowed(&audio.l), Cow::Borrowed(&audio.r)]
    } else {
        [Cow::Owned(resample_channel(&audio.l, audio.sr as u32, RATE)?), Cow::Owned(resample_channel(&audio.r, audio.sr as u32, RATE)?)]
    };
    let len = channels[0].len();
    if len == 0 { return Err("No audio samples".into()); }
    let threads = std::env::var("LOOM_STEMS_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or_else(||
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(2).clamp(1, 4)).clamp(1, 8);
    let mut session = session(model, cache, threads)?;
    let indices: Vec<_> = ORDER.iter().enumerate().filter(|(_, s)| selected.iter().any(|n| n == **s)).collect();
    let mut stems: Vec<Stem> = indices.iter().map(|(_, name)| Stem { name: name.to_string(), left: vec![0.0; len], right: vec![0.0; len] }).collect();
    let positions: Vec<_> = starts(len).collect();
    let mut weight = vec![0.0f32; len];
    let mut input = vec![0.0f32; 2 * SEGMENT];
    progress("separate", 0.0);
    for (chunk, &start) in positions.iter().enumerate() {
        let count = (len - start).min(SEGMENT);
        input.fill(0.0);
        for c in 0..2 { input[c * SEGMENT..c * SEGMENT + count].copy_from_slice(&channels[c][start..start + count]); }
        let tensor = TensorRef::from_array_view(([1usize, 2, SEGMENT], input.as_slice())).map_err(|e| e.to_string())?;
        let output = session.run(ort::inputs!["mix" => tensor]).map_err(|e| e.to_string())?;
        let (shape, data) = output["stems"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if shape.as_ref() != [1, 4, 2, SEGMENT as i64] { return Err("Unexpected CPU model output shape".into()); }
        for i in 0..count {
            let w = if positions.len() == 1 { 1.0 } else { blend(i, count) };
            weight[start + i] += w;
            for (out, (s, _)) in stems.iter_mut().zip(&indices) {
                out.left[start + i] += data[s * 2 * SEGMENT + i] * w;
                out.right[start + i] += data[(s * 2 + 1) * SEGMENT + i] * w;
            }
        }
        progress("separate", (chunk + 1) as f64 / positions.len() as f64);
    }
    for stem in &mut stems {
        for i in 0..len { stem.left[i] /= weight[i]; stem.right[i] /= weight[i]; }
        if audio.sr as u32 != RATE {
            stem.left = resample_channel(&stem.left, RATE, audio.sr as u32)?;
            stem.right = resample_channel(&stem.right, RATE, audio.sr as u32)?;
        }
        stem.left.resize(audio.len(), 0.0); stem.right.resize(audio.len(), 0.0);
    }
    Ok(stems)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_chunks_cover_the_signal_and_keep_first_and_last_samples() {
        for len in [1, SEGMENT, SEGMENT + 1, 2 * SEGMENT, 44100 * 30] {
            let mut weights = vec![0.0f32; len];
            let mut sum = vec![0.0f32; len];
            for start in starts(len) {
                let count = (len - start).min(SEGMENT);
                for i in 0..count { let w = blend(i, count); weights[start + i] += w; sum[start + i] += 0.75 * w; }
            }
            assert!(weights.iter().all(|w| *w > 0.0));
            assert!(sum.iter().zip(weights).all(|(v, w)| (v / w - 0.75).abs() < 1e-6));
        }
        assert_eq!(starts(SEGMENT).count(), 1, "do not process a needless trailing chunk");
    }
}
