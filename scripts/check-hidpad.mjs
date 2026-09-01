// PS DIRECT MODE (WebHID): valida el driver DualSense sin hardware real.
// Emite reportes HID falsos en los tres formatos (USB 0x01, BT extendido
// 0x31, BT simple de 9 bytes) y verifica que PadInput los consume por el
// pipeline normal: ejes correctos, botones estándar, prioridad sobre un
// pad de la Gamepad API con los sticks congelados (el caso Steam medido).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8792', '--strictPort'], { stdio: 'ignore', cwd: root });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
await page.goto('http://localhost:8792/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => {
  window.BREACH.mapChoice = 'fortaleza';
  document.getElementById('btn-practice').click();
});
await page.waitForTimeout(2200);

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// dispositivo HID falso conectado directo al driver
await page.evaluate(async () => {
  const I = window.BREACH_INPUT;
  window.__fake = {
    opened: true, vendorId: 0x054c, productName: 'Fake DualSense',
    open: async () => {}, close: () => {}, oninputreport: null,
  };
  await I.pad.hid._open(window.__fake);
  // emisor: construye un reporte según formato y lo entrega al driver
  window.__emit = (kind, opts = {}) => {
    const { lx = 128, ly = 128, rx = 128, ry = 128, b1 = 8, b2 = 0, b3 = 0,
      l2 = 0, r2 = 0 } = opts;
    let reportId, bytes;
    if (kind === 'bt31') {
      reportId = 0x31;
      bytes = [0, lx, ly, rx, ry, l2, r2, 0, b1, b2, b3, 0, 0];
    } else if (kind === 'usb01') {
      reportId = 0x01;
      bytes = [lx, ly, rx, ry, l2, r2, 0, b1, b2, b3, 0, 0];
    } else { // simple de 9 bytes
      reportId = 0x01;
      bytes = [lx, ly, rx, ry, b1, b2, b3, l2, r2];
    }
    const buf = new Uint8Array(bytes);
    window.__fake.oninputreport({ reportId, data: new DataView(buf.buffer) });
  };
});

const drive = async (kind, opts, ms = 700) => {
  await page.evaluate(([kind2, opts2, ms2]) => {
    clearInterval(window.__driveTimer);
    window.__driveTimer = setInterval(() => window.__emit(kind2, opts2), 60);
    setTimeout(() => clearInterval(window.__driveTimer), ms2);
  }, [kind, opts, ms]);
  await page.waitForTimeout(ms + 150);
};

// 1) BT extendido: stick izquierdo arriba → el jugador se mueve
const before = await page.evaluate(() => ({
  x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z,
}));
await drive('bt31', { ly: 0 }, 900);
const afterMove = await page.evaluate(() => {
  const P = window.BREACH.player, I = window.BREACH_INPUT;
  return { x: P.pos.x, z: P.pos.z, idx: I.pad._idx, id: I.pad.info?.id ?? '' };
});
const moved = Math.hypot(afterMove.x - before.x, afterMove.z - before.z);
check('BT extendido (0x31): el stick mueve al jugador', moved > 0.5,
  `moved=${moved.toFixed(2)}`);
check('el pad WebHID fue el elegido', afterMove.idx === 31 &&
  afterMove.id.includes('WebHID'), `idx=${afterMove.idx}`);

// 2) botones estándar: Cross (bit 0x20 de b1) produce flanco de botón 0
const crossEdge = await page.evaluate(async () => {
  const I = window.BREACH_INPUT;
  window.__edge = false;
  // el flanco vive UN poll: interceptar el Set garantiza la captura
  I.pad.justPressed = new (class extends Set {
    add(v) { if (v === 0) window.__edge = true; return super.add(v); }
  })(I.pad.justPressed);
  window.__emit('bt31', {});
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 6; i++) {
    window.__emit('bt31', { b1: 8 | 0x20 });
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  return window.__edge;
});
check('Cross llega como botón estándar 0 (flanco)', crossEdge === true);

// 3) R2 analógico → fireHeld
await drive('bt31', { r2: 255, b2: 0x08 }, 500);
const fire = await page.evaluate(() => window.BREACH_INPUT.pad.fireHeld);
check('R2 analógico dispara (fireHeld)', fire === true);
await drive('bt31', {}, 300);

// 4) BT simple (9 bytes): mismo resultado con el layout corto
const b2s = await page.evaluate(() => ({ z: window.BREACH.player.pos.z, x: window.BREACH.player.pos.x }));
await drive('simple', { ly: 255 }, 800);
const a2s = await page.evaluate(() => ({ z: window.BREACH.player.pos.z, x: window.BREACH.player.pos.x }));
check('BT simple (9B): el stick mueve al jugador',
  Math.hypot(a2s.x - b2s.x, a2s.z - b2s.z) > 0.5);

// 5) prioridad: un DualSense CONGELADO en la Gamepad API no le gana al HID
const prio = await page.evaluate(async () => {
  const I = window.BREACH_INPUT;
  const frozen = {
    id: 'DualSense Edge Wireless Controller (STANDARD GAMEPAD)', index: 2,
    mapping: 'standard', connected: true,
    axes: [0.02, 0.04, 0.02, 0.03],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 5, value: i === 5 ? 1 : 0 })),
  };
  navigator.getGamepads = () => [frozen];
  const t0 = performance.now();
  const timer = setInterval(() => window.__emit('bt31', { lx: 255 }), 50);
  await new Promise((r) => setTimeout(r, 700));
  clearInterval(timer);
  void t0;
  return { idx: I.pad._idx, id: I.pad.info?.id ?? '' };
});
check('con pad congelado presente, el HID directo conserva el control',
  prio.idx === 31 && prio.id.includes('WebHID'), JSON.stringify(prio));

// 6) el botón del menú existe y refleja estado conectado
const ui = await page.evaluate(() => {
  const b = document.getElementById('btn-hidpad');
  return { exists: !!b, label: b?.textContent ?? '' };
});
check('botón del menú presente y en estado ON', ui.exists && /ON/.test(ui.label), ui.label);

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
await browser.close();
server.kill();
await clearClip();
console.log(fails.length ? `FALLOS: ${fails.length}` : 'HIDPAD: todo verde');
process.exit(fails.length ? 1 : 0);
