# Draws app\icons\icon.ico: a 4x4 step grid on graphite, the lit steps in clay.
# ICO entries are PNGs (Vista+), sizes 256/64/48/32/16.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\app\icons\icon.ico'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

$bg = [System.Drawing.Color]::FromArgb(20, 20, 20)
$off = [System.Drawing.Color]::FromArgb(58, 56, 53)
$on = [System.Drawing.Color]::FromArgb(187, 116, 99)
# which steps are lit, row by row
$lit = @(
    @(1, 0, 0, 0),
    @(0, 0, 1, 0),
    @(1, 0, 1, 1),
    @(1, 1, 0, 1)
)

function Draw([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'None'
    $g.Clear($bg)
    $pad = [math]::Round($size * 0.14)
    $gap = [math]::Max(1, [math]::Round($size * 0.05))
    $cell = ($size - 2 * $pad - 3 * $gap) / 4
    for ($r = 0; $r -lt 4; $r++) {
        for ($c = 0; $c -lt 4; $c++) {
            $brush = New-Object System.Drawing.SolidBrush ($(if ($lit[$r][$c]) { $on } else { $off }))
            $x = $pad + $c * ($cell + $gap); $y = $pad + $r * ($cell + $gap)
            $g.FillRectangle($brush, [single]$x, [single]$y, [single]$cell, [single]$cell)
            $brush.Dispose()
        }
    }
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = 256, 64, 48, 32, 16
$pngs = $sizes | ForEach-Object { , (Draw $_) }
$fs = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Close()
# a PNG copy for the UI logo and docs
[System.IO.File]::WriteAllBytes((Join-Path (Split-Path $out) 'icon.png'), $pngs[0])
Write-Host "icon: $out"
