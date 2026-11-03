# Dot-source to get the portable windows-gnu Rust toolchain in this shell:  . .\env.ps1
$tools = if ($env:LOOM_TOOLCHAIN) { $env:LOOM_TOOLCHAIN } else { Join-Path $PSScriptRoot '..\.tools\rust-daw' }
if (Test-Path "$tools\cargo\bin\cargo.exe") {
    $env:CARGO_HOME = (Resolve-Path "$tools\cargo").Path
    $env:RUSTUP_HOME = (Resolve-Path "$tools\rustup").Path
    $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
    if (Test-Path "$tools\gcc\w64devkit\bin") {
        $env:PATH = (Resolve-Path "$tools\gcc\w64devkit\bin").Path + ";$env:PATH"
        $env:LIBRARY_PATH = (Resolve-Path "$PSScriptRoot\.cargo\libstub").Path
    }
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found: install Rust from https://rustup.rs or set LOOM_TOOLCHAIN"
}
# ASIO bindings are generated at build time; the packaged exe needs neither SDK nor LLVM.
if (-not $env:CPAL_ASIO_DIR -and (Test-Path "$PSScriptRoot\..\.tools\asio-sdk\ASIOSDK\common\asio.h")) {
    $env:CPAL_ASIO_DIR = (Resolve-Path "$PSScriptRoot\..\.tools\asio-sdk\ASIOSDK").Path
}
if (-not $env:LIBCLANG_PATH -and (Test-Path "$PSScriptRoot\..\.tools\libclang\clang\native\libclang.dll")) {
    $env:LIBCLANG_PATH = (Resolve-Path "$PSScriptRoot\..\.tools\libclang\clang\native").Path
}
if (-not $env:BINDGEN_EXTRA_CLANG_ARGS -and (Test-Path "$tools\gcc\w64devkit\include\windows.h")) {
    $clangHeaders = (Resolve-Path "$tools\gcc\w64devkit\include").Path.Replace('\', '/')
    $env:BINDGEN_EXTRA_CLANG_ARGS = "--target=x86_64-w64-windows-gnu -I$clangHeaders"
    $clangResource = Get-Item "$PSScriptRoot\..\.tools\libclang\headers\x86intrin.h" -ErrorAction SilentlyContinue
    if ($clangResource) { $env:BINDGEN_EXTRA_CLANG_ARGS += ' -I' + $clangResource.Directory.FullName.Replace('\', '/') }
}
