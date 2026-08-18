# Guardian del mouse: libera automaticamente el cursor cuando queda confinado
# por el bug de ClipCursor de Chromium/Windows (escala 125%).
# Regla: si el cursor esta VISIBLE pero confinado a una region (estado
# imposible: un pointer lock legitimo siempre oculta el cursor) durante mas
# de ~1.2s, y la app en foco es un navegador/app de escritorio, lo libera.
# No toca juegos nativos (no estan en la lista) ni el juego mientras esta
# capturado (cursor oculto).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)]
public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public int x; public int y; }
public static class MG {
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$safeApps = @('brave', 'chrome', 'msedge', 'firefox', 'explorer', 'electron', 'synapshell', 'discord')
$stale = 0
while ($true) {
  Start-Sleep -Milliseconds 400
  try {
    $r = New-Object RECT
    [MG]::GetClipCursor([ref]$r) | Out-Null
    $x0 = [MG]::GetSystemMetrics(76); $y0 = [MG]::GetSystemMetrics(77)
    $w = [MG]::GetSystemMetrics(78);  $h = [MG]::GetSystemMetrics(79)
    $full = ($r.L -le $x0) -and ($r.T -le $y0) -and ($r.R -ge ($x0 + $w)) -and ($r.B -ge ($y0 + $h))
    if ($full) { $stale = 0; continue }

    $ci = New-Object CURSORINFO
    $ci.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CURSORINFO])
    [MG]::GetCursorInfo([ref]$ci) | Out-Null
    $visible = (($ci.flags -band 1) -ne 0)
    if (-not $visible) { $stale = 0; continue } # pointer lock legitimo: no tocar

    $pid2 = [uint32]0
    [MG]::GetWindowThreadProcessId([MG]::GetForegroundWindow(), [ref]$pid2) | Out-Null
    $pname = ''
    try { $pname = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName.ToLower() } catch {}
    $isSafe = $false
    foreach ($a in $safeApps) { if ($pname -like "*$a*") { $isSafe = $true; break } }
    if (-not $isSafe) { $stale = 0; continue } # posible juego nativo con clip legitimo

    $stale++
    if ($stale -ge 3) {
      [MG]::ClipCursor([IntPtr]::Zero) | Out-Null
      $stale = 0
    }
  } catch { $stale = 0 }
}
