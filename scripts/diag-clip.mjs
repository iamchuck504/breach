// Diagnóstico del bug de ClipCursor: abre un navegador REAL (headed), hace
// ciclos de pointer lock (salida por Esc y programática) y lee el estado del
// ClipCursor de Windows tras cada fase. Al final SIEMPRE libera el cursor.
// Uso: node scripts/diag-clip.mjs [ruta-al-navegador]
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BROWSER = process.argv[2] ||
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const PS_TYPE = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public static class ClipUtil {
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
`;

function readClip(label) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', PS_TYPE + `
$r = New-Object RECT
[ClipUtil]::GetClipCursor([ref]$r) | Out-Null
$w = [ClipUtil]::GetSystemMetrics(0); $h = [ClipUtil]::GetSystemMetrics(1)
Write-Output "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)|$w,$h"
`], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  const [rect, screen] = out.split('|');
  const [L, T, R, B] = rect.split(',').map(Number);
  const [W, H] = (screen || '0,0').split(',').map(Number);
  const full = L === 0 && T === 0 && R === W && B === H;
  console.log(`${label}: clip=(${L},${T})-(${R},${B}) pantalla=${W}x${H} ${full ? 'LIBRE' : '*** CONFINADO ***'}`);
  return { L, T, R, B, W, H, full };
}

function clearClip() {
  spawnSync('powershell', ['-NoProfile', '-Command', PS_TYPE +
    '[ClipUtil]::ClipCursor([IntPtr]::Zero) | Out-Null; Write-Output ok'], { encoding: 'utf8' });
}

// pointer lock requiere contexto seguro → servir desde localhost
import http from 'node:http';
const HTML = `<!DOCTYPE html>
<html><body style="margin:0"><canvas id="c" width="600" height="400"
style="width:100vw;height:100vh;background:#333"></canvas>
<script>
const c = document.getElementById('c');
window.err = '';
c.addEventListener('mousedown', () => {
  try {
    const p = c.requestPointerLock();
    if (p && p.catch) p.catch(e => window.err = e.name + ': ' + e.message);
  } catch (e) { window.err = 'sync ' + e.name + ': ' + e.message; }
});
document.addEventListener('pointerlockerror', () => window.err += ' [pointerlockerror]');
window.st = () => (document.pointerLockElement ? 'locked' : 'free') +
  ' focus=' + document.hasFocus() + (window.err ? ' err=' + window.err : '');
</script></body></html>`;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});
await new Promise((r) => srv.listen(8799, r));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdiag-'));
let browser;
try {
  console.log('Navegador:', BROWSER);
  readClip('0. antes de abrir  ');
  browser = await chromium.launchPersistentContext(userDir, {
    executablePath: BROWSER,
    headless: false,
    viewport: null,
    args: ['--window-size=1200,800', '--window-position=80,80'],
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto('http://localhost:8799/');
  await page.bringToFront();
  await page.waitForTimeout(800);

  // ciclo 1: lock por click → salida por ESC (el camino del navegador)
  await page.mouse.click(400, 300);
  await page.waitForTimeout(700);
  console.log('   lock:', await page.evaluate('st()'));
  readClip('1. con lock activo ');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  console.log('   lock:', await page.evaluate('st()'));
  const afterEsc = readClip('2. tras salir (Esc)');

  // ciclo 2: lock → salida programática (exitPointerLock)
  await page.mouse.click(400, 300);
  await page.waitForTimeout(700);
  readClip('3. con lock activo ');
  await page.evaluate('document.exitPointerLock()');
  await page.waitForTimeout(700);
  const afterExit = readClip('4. tras exitPointerLock');

  // ciclo 3: lock → cerrar la pestaña con el lock puesto
  await page.mouse.click(400, 300);
  await page.waitForTimeout(700);
  console.log('   lock:', await page.evaluate('st()'));
  await page.close();
  await new Promise((r) => setTimeout(r, 900));
  const afterClose = readClip('5. tras cerrar tab con lock');

  console.log('---');
  const leak = !afterEsc.full || !afterExit.full || !afterClose.full;
  console.log(leak ? 'RESULTADO: FUGA DE CLIPCURSOR REPRODUCIDA' : 'RESULTADO: sin fuga en este navegador');
} catch (e) {
  console.log('ERROR:', e.message);
} finally {
  await browser?.close().catch(() => {});
  clearClip();
  readClip('final (tras limpiar)');
  fs.rmSync(userDir, { recursive: true, force: true });
  srv.close();
}
