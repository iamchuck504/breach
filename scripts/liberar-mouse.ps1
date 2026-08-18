# Libera el cursor si quedo confinado a una region de la pantalla
# (bug de ClipCursor de Chromium/Windows al soltar el pointer lock).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public static class ClipUtil {
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr rect);
}
"@
$r = New-Object RECT
[ClipUtil]::GetClipCursor([ref]$r) | Out-Null
Write-Host "Clip actual: L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"
[ClipUtil]::ClipCursor([IntPtr]::Zero) | Out-Null
Write-Host "Cursor liberado."
