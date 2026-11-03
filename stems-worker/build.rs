use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=LOOM_ORT_DIR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") { return; }
    let root = env::var_os("LOOM_ORT_DIR").map(PathBuf::from).unwrap_or_else(||
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../.tools/onnxruntime-1.24.2/onnxruntime-win-x64-1.24.2"));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let profile = out.ancestors().nth(3).unwrap();
    for name in ["onnxruntime.dll", "onnxruntime_providers_shared.dll"] {
      let dll = root.join("lib").join(name);
      println!("cargo:rerun-if-changed={}", dll.display());
      let data = fs::read(dll).expect("ONNX Runtime is missing: run tools/setup-onnxruntime.ps1 or set LOOM_ORT_DIR");
      for target in [profile.join(name), profile.join("deps").join(name)] {
        if fs::read(&target).ok().as_deref() != Some(data.as_slice()) {
            fs::write(target, &data).expect("could not copy ONNX Runtime");
        }
      }
    }
}
