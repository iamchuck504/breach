// Verifica que una corrida headless del juego NO toque el ClipCursor de
// Windows. HALLAZGO ORIGINAL (2026-08-18): sin ?nolock=1, un Chromium
// headless con el juego cargado ponía un clip real (~23,102-1293,812) aunque
// el pointer lock ni se concediera — confinaba el mouse físico de Chuck en
// cada corrida de las suites. Con ?nolock=1 el clip debe quedar intacto.
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const readClip = (label) => {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")]public static extern bool GetClipCursor(out RECT r);public struct RECT{public int L,T,R,B;}'; $r=New-Object W.U+RECT; [W.U]::GetClipCursor([ref]$r) | Out-Null; Write-Output "$($r.L),$($r.T),$($r.R),$($r.B)"`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const out = execSync(`powershell -NoProfile -EncodedCommand ${enc}`, { encoding: 'utf8' }).trim();
  console.log(label + ':', out);
  return out;
};

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8798' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const before = readClip('1. clip antes');

let browser;
let ok = false;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://localhost:8798/?nolock=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(800);
  await page.mouse.click(640, 360); // gesto que ANTES disparaba el clip
  await page.waitForTimeout(2500);  // ventana del keeper incluida (1.6s)
  const during = readClip('2. clip con el juego corriendo (nolock)');
  ok = during === before;
} finally {
  await browser?.close();
  server.kill();
  clearClip();
}
readClip('3. clip al final');
console.log(ok ? 'DIAG-HEADLESS OK: el clip no se tocó' : 'FALLO: la corrida headless movió el clip');
process.exit(ok ? 0 : 1);
