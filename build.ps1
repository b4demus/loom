# Builds loom.exe (release) into dist\. The UI in ui\ is embedded into the exe at compile time.
#   .\build.ps1          release build + engine/recording tests
#   .\build.ps1 -Portable   also create the Windows x64 ZIP
#   .\build.ps1 -Asio       enable ASIO for local builds
#   .\build.ps1 -NoTest     skip the tests
param([switch]$NoTest, [switch]$Portable, [switch]$Asio)
$ErrorActionPreference = 'Stop'
if ($Portable -and $Asio) { throw 'The portable release uses WASAPI. Build with -Asio separately.' }
. (Join-Path $PSScriptRoot 'env.ps1')
& (Join-Path $PSScriptRoot 'tools/setup-onnxruntime.ps1')
$audioFeatures = @()
if ($Asio) { $audioFeatures = @('--features', 'loom/asio') }
Push-Location $PSScriptRoot
try {
    if (-not $NoTest) {
        cargo test -p loom-engine -p loom-host -p loom -p loom-stems --release --locked @audioFeatures
        if ($LASTEXITCODE -ne 0) { throw 'audio tests failed' }
        if (Get-Command node -ErrorAction SilentlyContinue) {
            node --test tools/recording.test.cjs tools/playlist.test.cjs tools/mixer.test.cjs tools/roll.test.cjs tools/stems.test.cjs tools/undo.test.cjs
            if ($LASTEXITCODE -ne 0) { throw 'recording UI tests failed' }
        }
    }
    cargo build --release --locked -p loom -p loom-stems @audioFeatures
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
    New-Item -ItemType Directory -Force dist | Out-Null
    $exe = 'dist\loom.exe'
    # a running loom.exe cannot be overwritten, but it can be renamed
    if (Test-Path $exe) {
        try { Remove-Item -LiteralPath $exe -Force } catch {
            $previousExe = Join-Path 'dist' ('loom.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.exe')
            Move-Item -LiteralPath $exe -Destination $previousExe
        }
    }
    Copy-Item target\release\loom.exe $exe
    $stemExe = 'dist\loom-stems.exe'
    if (Test-Path $stemExe) {
        try { Remove-Item -LiteralPath $stemExe -Force } catch {
            Move-Item -LiteralPath $stemExe -Destination (Join-Path 'dist' ('loom-stems.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.exe'))
        }
    }
    Copy-Item target\release\loom-stems.exe $stemExe
    foreach ($runtimeName in @('onnxruntime.dll', 'onnxruntime_providers_shared.dll')) {
        $runtimeDll = Join-Path 'target\release' $runtimeName
        $runtimeTarget = Join-Path 'dist' $runtimeName
        if (-not (Test-Path $runtimeTarget) -or (Get-FileHash $runtimeDll).Hash -ne (Get-FileHash $runtimeTarget).Hash) {
            Copy-Item -LiteralPath $runtimeDll -Destination $runtimeTarget -Force
        }
    }
    New-Item -ItemType Directory -Force dist\licenses | Out-Null
    Copy-Item licenses\* dist\licenses\ -Force
    Copy-Item ui\fonts\OFL.txt dist\licenses\JetBrains-Mono-OFL.txt -Force
    # windows-gnu links the WebView2 loader dynamically: it has to sit next to the exe.
    # A running loom keeps it locked, so copy it only when it changed.
    $dll = 'target\release\WebView2Loader.dll'
    if ((Test-Path $dll) -and (-not (Test-Path dist\WebView2Loader.dll) -or (Get-FileHash $dll).Hash -ne (Get-FileHash dist\WebView2Loader.dll).Hash)) {
        Copy-Item $dll dist\ -Force
    }
    if (-not (Test-Path dist\WebView2Loader.dll)) { throw 'WebView2Loader.dll missing (target\release)' }
    Write-Host "Done: $((Resolve-Path $exe).Path)"
    if ($Portable) {
        $version = (Get-Content app\tauri.conf.json -Raw | ConvertFrom-Json).version
        $zip = "dist\loom-$version-windows-x64-portable.zip"
        $files = @(
            $exe, $stemExe, 'dist\WebView2Loader.dll', 'dist\onnxruntime.dll',
            'dist\onnxruntime_providers_shared.dll', 'dist\licenses', 'tools\portable.txt'
        )
        Compress-Archive -LiteralPath $files -DestinationPath $zip -Force
        $checksum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        "$checksum  $(Split-Path -Leaf $zip)" | Set-Content -LiteralPath "$zip.sha256" -Encoding Ascii
        Write-Host "Portable ZIP: $((Resolve-Path $zip).Path)"
    }
}
finally {
    Pop-Location
}
