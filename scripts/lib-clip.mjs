// Limpieza del ClipCursor de Windows tras una corrida headless. MEDIDO
// (diag-headless.mjs): un Chromium headless con el juego cargado pone un
// ClipCursor REAL de sistema aunque el pointer lock ni se conceda — sin esta
// limpieza (y sin ?nolock=1 en el juego) las suites confinan el mouse físico.
import { execSync } from 'node:child_process';

export function clearClip() {
  if (process.platform !== 'win32') return;
  try {
    const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")]public static extern bool ClipCursor(IntPtr r);'; [W.U]::ClipCursor([IntPtr]::Zero) | Out-Null`;
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -EncodedCommand ${enc}`, { stdio: 'ignore' });
  } catch { /* mejor esfuerzo */ }
}
