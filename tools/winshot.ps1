# Starts dist\loom.exe with flags, waits, then saves every visible window of the process
# (main window and plugin editors) through PrintWindow: only loom's own pixels, even when
# other windows cover it.
#   powershell -File tools\winshot.ps1 -OutDir <dir> -Wait 20 -Flags "--demo --plugtest"
param([string]$OutDir = '.', [int]$Wait = 20, [string]$Flags = '--demo')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class LW {
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static List<IntPtr> Of(uint target) { var o = new List<IntPtr>(); EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == target && IsWindowVisible(h)) o.Add(h); return true; }, IntPtr.Zero); return o; }
  public static string Text(IntPtr h) { var t = new StringBuilder(256); GetWindowText(h, t, 256); return t.ToString(); }
  public static string Cls(IntPtr h) { var t = new StringBuilder(256); GetClassName(h, t, 256); return t.ToString(); }
}
'@
[LW]::SetProcessDPIAware() | Out-Null
$exe = Join-Path $PSScriptRoot '..\dist\loom.exe'
$p = Start-Process $exe -ArgumentList $Flags -PassThru
try {
    Start-Sleep -Seconds $Wait
    $i = 0
    foreach ($h in [LW]::Of([uint32]$p.Id)) {
        $cls = [LW]::Cls($h)
        if ($cls -notin 'Tauri Window', 'loomPluginWindow') { continue }
        $r = New-Object LW+RECT
        [LW]::GetWindowRect($h, [ref]$r) | Out-Null
        $w = $r.R - $r.L; $hh = $r.B - $r.T
        $bmp = New-Object System.Drawing.Bitmap $w, $hh
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $dc = $g.GetHdc()
        [LW]::PrintWindow($h, $dc, 2) | Out-Null   # PW_RENDERFULLCONTENT
        $g.ReleaseHdc($dc)
        $file = Join-Path $OutDir ("win{0}.png" -f $i)
        $bmp.Save($file)
        Write-Output ("{0}  {1}  '{2}'  {3}x{4}" -f $file, $cls, [LW]::Text($h), $w, $hh)
        $i++
    }
}
finally {
    if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 800; if (-not $p.HasExited) { $p.Kill() } }
}
