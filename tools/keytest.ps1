# Checks that keys typed into a plugin window play notes: starts loom with a plugin instrument
# window open (--plugtest --keys), posts key-down/key-up messages for Q (C5) and Z (C4) straight to
# that window — no real key presses on the desktop — and prints what loom logged.
param([string]$Inst = 'Serum 2')
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class KT {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, P f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static IntPtr Plugin(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (p == pid && c.ToString() == "loomPluginWindow") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  // the deepest first child: where a plugin's own view usually sits
  public static IntPtr Child(IntPtr top) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (h, l) => { found = h; return true; }, IntPtr.Zero);
    return found == IntPtr.Zero ? top : found;
  }
}
'@
$log = "$env:TEMP\loom-dev.log"
Remove-Item $log -ErrorAction SilentlyContinue
$exe = Join-Path $PSScriptRoot '..\dist\loom.exe'
$p = Start-Process $exe -ArgumentList "--plugtest --keys `"--inst=$Inst`"" -PassThru
try {
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 120 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; $h = [KT]::Plugin([uint32]$p.Id) }
    if ($h -eq [IntPtr]::Zero) { throw 'no plugin window' }
    Start-Sleep -Seconds 2
    $target = [KT]::Child($h)
    "plugin window $h, posting to $target"
    # WM_KEYDOWN 0x100 / WM_KEYUP 0x101; lParam: repeat 1, scan code in bits 16-23, bits 30-31 set on key-up
    foreach ($k in @(@(0x51, 0x10), @(0x5A, 0x2C))) {
        $vk = $k[0]; $scan = $k[1]
        [KT]::PostMessage($target, 0x100, [IntPtr]$vk, [IntPtr](1 -bor ($scan -shl 16))) | Out-Null
        Start-Sleep -Milliseconds 900
        [KT]::PostMessage($target, 0x101, [IntPtr]$vk, [IntPtr]([long](1 -bor ($scan -shl 16) -bor 0xC0000000))) | Out-Null
        Start-Sleep -Milliseconds 600
    }
    Start-Sleep -Seconds 2
}
finally {
    if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 800; if (-not $p.HasExited) { $p.Kill() } }
}
Get-Content $log | Where-Object { $_ -match '^(kbd|voices)' }
