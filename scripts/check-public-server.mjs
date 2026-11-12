// SERVER PÚBLICO: el build 'same-origin' (el de la imagen Docker) debe dejar
// el cliente apuntando al MISMO host que lo sirve, el server debe responder
// la sonda /healthz y un cliente real debe completar el handshake del lobby
// por esa URL por defecto. Compila a un directorio temporal: no toca dist/.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// El server sirve ../dist relativo a su ruta REAL: se monta un árbol temporal
// con copias de server/ y src/ (un enlace resolvería al dist del repo), un
// enlace a node_modules y un dist compilado en same-origin.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-public-'));
for (const dir of ['server', 'src']) {
  fs.cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true });
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'junction');
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  'build', '--outDir', path.join(stage, 'dist'), '--emptyOutDir', '--logLevel', 'error'], {
  cwd: root, env: { ...process.env, VITE_BREACH_SERVER: 'same-origin' }, encoding: 'utf8',
});
check('build same-origin compila', build.status === 0, (build.stderr || '').slice(0, 300));

const server = spawn(process.execPath, [path.join(stage, 'server', 'server.js')], {
  cwd: stage, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));

let browser;
try {
  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  check('/healthz responde 200 ok', health.status === 200 && (await health.text()) === 'ok');
  const post = await fetch(`http://127.0.0.1:${PORT}/healthz`, { method: 'POST' });
  check('/healthz no acepta otros métodos', post.status === 405);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let pageErrors = 0;
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  const url = await page.evaluate(() => document.getElementById('in-server').value);
  check('el cliente apunta por defecto a su propio host',
    url === `ws://127.0.0.1:${PORT}`, `in-server="${url}"`);

  // handshake real contra esa URL por defecto (mismo protocolo que el juego)
  const welcome = await page.evaluate((u) => new Promise((res) => {
    const ws = new WebSocket(u);
    const done = (v) => { try { ws.close(); } catch { /* ya cerrado */ } res(v); };
    ws.onerror = () => done({ error: 'socket' });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', action: 'create', name: 'PROBE', v: 0 }));
    ws.onmessage = (ev) => { try { done(JSON.parse(ev.data)); } catch { done({ error: 'json' }); } };
    setTimeout(() => done({ error: 'timeout' }), 4000);
  }), url);
  check('el WebSocket del mismo host crea el lobby', welcome.t === 'welcome' && !!welcome.lobby,
    JSON.stringify(welcome).slice(0, 160));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser?.close();
  server.kill();
  await clearClip();
  await new Promise((r) => setTimeout(r, 300));
  // el junction se quita como enlace ANTES de borrar: jamás se recorre el
  // node_modules real; si no se pudo quitar, el árbol temporal se deja estar
  const link = path.join(stage, 'node_modules');
  // Windows: el junction se quita como directorio; macOS/Linux: es un symlink
  try { fs.rmdirSync(link); } catch { try { fs.unlinkSync(link); } catch { /* se comprueba abajo */ } }
  if (!fs.existsSync(link)) fs.rmSync(stage, { recursive: true, force: true });
  else console.log(`AVISO: no se pudo quitar ${link}; se deja ${stage}`);
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nSERVER PÚBLICO: todo verde');
process.exit(fails.length ? 1 : 0);
