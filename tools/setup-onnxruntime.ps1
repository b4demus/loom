# Official CPU-only ONNX Runtime. No Python or GPU driver is needed.
$ErrorActionPreference = 'Stop'
if ($env:LOOM_ORT_DIR) {
    if (-not (Test-Path "$env:LOOM_ORT_DIR\lib\onnxruntime.dll")) { throw 'LOOM_ORT_DIR must contain lib\onnxruntime.dll' }
    return
}
$ortBase = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tools/onnxruntime-1.24.2'))
$ortRoot = Join-Path $ortBase 'onnxruntime-win-x64-1.24.2'
$expectedDll = '114947D633E6844CE3C4B51EF6678F776628571D08A5763859C61642C8DCCA9C'
if (-not (Test-Path "$ortRoot\lib\onnxruntime.dll") -or -not (Test-Path "$ortRoot\lib\onnxruntime_providers_shared.dll") -or (Get-FileHash "$ortRoot\lib\onnxruntime.dll").Hash -ne $expectedDll) {
    $ortArchive = Join-Path (Split-Path $ortBase) 'onnxruntime-win-x64-1.24.2.zip'
    New-Item -ItemType Directory -Force (Split-Path $ortBase) | Out-Null
    if (-not (Test-Path $ortArchive)) {
        Invoke-WebRequest 'https://github.com/microsoft/onnxruntime/releases/download/v1.24.2/onnxruntime-win-x64-1.24.2.zip' -OutFile $ortArchive
    }
    if ((Get-FileHash $ortArchive).Hash -ne '8E3E9C826375352E29CB2614FE44F3D7A4B0FF7B8028AD7A456AF9D949A7E8B0') { throw 'ONNX Runtime archive checksum mismatch' }
    Expand-Archive -LiteralPath $ortArchive -DestinationPath $ortBase -Force
    if ((Get-FileHash "$ortRoot\lib\onnxruntime.dll").Hash -ne $expectedDll) { throw 'ONNX Runtime checksum mismatch' }
}
$env:LOOM_ORT_DIR = $ortRoot
