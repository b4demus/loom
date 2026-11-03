//! Checks plugins without the app:
//!   cargo run -p loom-host --example probe -- <plugin file> [--run]
//! Lists the classes; with --run loads the first one, plays a note (instrument) or noise
//! (effect) through it for a second, and reports the level and the size of its state.

use loom_engine::plugin::{MidiEv, TimeInfo};
use loom_host::{load, probe, Setup};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = std::path::PathBuf::from(&args[0]);
    let run = args.iter().any(|a| a == "--run");
    let infos = match probe(&path) {
        Ok(v) => v,
        Err(e) => {
            println!("probe error: {e}");
            std::process::exit(1);
        }
    };
    for i in &infos {
        println!("{} | {} | {} | {} | instrument={}", i.format, i.name, i.vendor, i.cid, i.instrument);
    }
    // Headless integration check for the manual parameter restore used by undo.
    if args.iter().any(|a| a == "--undo") && !infos.is_empty() {
        let mut inst = load(&infos[0], Setup { sr: 48000.0, max_block: 512 }).expect("load");
        let ps = inst.params();
        let param = ps.iter().find(|p| p.name.to_lowercase().contains("gain")).or_else(|| ps.first()).expect("parameter");
        let (id, initial) = (param.id, param.value);
        let target = if initial > 0.5 { 0.2 } else { 0.8 };
        let mut proc_ = inst.processor();
        let input = vec![0.1; 512]; let (mut l, mut r) = (vec![0.0; 512], vec![0.0; 512]);
        let time = TimeInfo { playing: false, bpm: 120.0, ppq: 0.0, frames: 0, sr: 48000.0 };
        let before = inst.get_state();
        for value in [target, initial, target, initial] {
            inst.set_param(id, value);
            for _ in 0..8 { proc_.process([&input, &input], [&mut l, &mut r], &[], &time); }
            let shown = inst.params().into_iter().find(|p| p.id == id).unwrap().value;
            assert!((shown - value).abs() < 1e-5, "editor did not restore {value}: {shown}");
            let state = inst.get_state();
            assert_eq!(state == before, value == initial, "processor state did not follow restored parameter");
            assert!(inst.take_edits().is_empty(), "host restore must not create a new user edit");
        }
        println!("undo/redo passed: {} #{} {}", infos[0].name, id, param.name);
        drop(proc_);
        return;
    }
    // --params: the automatable parameters, then the first one moved the way automation moves it
    // (through the processor, on the audio side); the plugin's state must change with it
    if args.iter().any(|a| a == "--params") && !infos.is_empty() {
        let mut inst = load(&infos[0], Setup { sr: 48000.0, max_block: 512 }).expect("load");
        let ps = inst.params();
        println!("{} automatable parameters", ps.len());
        for p in ps.iter().take(8) {
            println!("  #{} {} (default {:.3})", p.id, p.name, p.default);
        }
        let Some(first) = ps.first() else { return };
        let mut proc_ = inst.processor();
        let (il, ir) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        let (mut ol, mut or) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        let time = TimeInfo { playing: true, bpm: 120.0, ppq: 0.0, frames: 0, sr: 48000.0 };
        let before = inst.get_state();
        let target = if first.default > 0.5 { 0.0 } else { 1.0 };
        proc_.set_param(first.id, target);
        for _ in 0..4 {
            proc_.process([&il, &ir], [&mut ol, &mut or], &[], &time);
        }
        let after = inst.get_state();
        println!("set #{} {} to {target}: state {}", first.id, first.name, if before != after { "changed" } else { "UNCHANGED" });
        inst.follow_param(first.id, target);
        drop(proc_);
        return;
    }
    if !run || infos.is_empty() {
        return;
    }
    let setup = Setup { sr: 48000.0, max_block: 512 };
    let mut inst = load(&infos[0], setup).expect("load");
    let mut p = inst.processor();
    let n = 512;
    let mut rng = 1u32;
    let (mut il, mut ir) = (vec![0.0f32; n], vec![0.0f32; n]);
    let (mut ol, mut or) = (vec![0.0f32; n], vec![0.0f32; n]);
    let (mut sum, mut count, mut peak) = (0f64, 0usize, 0f32);
    for b in 0..94 {
        for j in 0..n {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            il[j] = (rng as f32 / u32::MAX as f32 - 0.5) * 0.5;
            ir[j] = il[j];
        }
        let evs: Vec<MidiEv> = if infos[0].instrument {
            match b {
                0 => vec![MidiEv { frame: 10, key: 60, vel: 0.9, on: true }, MidiEv { frame: 10, key: 64, vel: 0.9, on: true }],
                60 => vec![MidiEv { frame: 0, key: 60, vel: 0.0, on: false }, MidiEv { frame: 0, key: 64, vel: 0.0, on: false }],
                _ => vec![],
            }
        } else {
            vec![]
        };
        let t = TimeInfo { playing: true, bpm: 120.0, ppq: b as f64 * n as f64 / 24000.0, frames: (b * n) as i64, sr: 48000.0 };
        p.process([&il, &ir], [&mut ol, &mut or], &evs, &t);
        for j in 0..n {
            sum += (ol[j] * ol[j]) as f64;
            peak = peak.max(ol[j].abs()).max(or[j].abs());
        }
        count += n;
    }
    println!("rms {:.4} peak {:.4} editor={}", (sum / count as f64).sqrt(), peak, inst.has_editor());
    let st = inst.get_state();
    println!("state {} bytes", st.len());
    inst.set_state(&st).expect("set_state");
    drop(p);
    drop(inst);
    println!("unloaded");
}
