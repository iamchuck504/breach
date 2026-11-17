// La calidad automática EN EL JUEGO: con ?gfx=auto arranca en el nivel del
// equipo, baja sola cuando los cuadros se sostienen bajos (aquí se fuerza un
// cuadro lento), aplica el nivel al render y el menú refleja AUTO; elegir un
// nivel a mano la apaga.
//   node scripts/check-auto-gfx-live.mjs   (requiere dist/: npm run build)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8842;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let fail = 0;
const ok = (c, name, data) => { console.log(c ? 'OK  ' : 'FAIL', name, '—', JSON.stringify(data)); if (!c) fail++; };
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=auto`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; document.getElementById('btn-practice').click(); });
  await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
  const state = () => page.evaluate(() => { const g = window.BREACH_GFX(); return { auto: g.auto, quality: g.quality, scale: g.scale, step: g.controller.step, gpu: g.gpu, fps: Math.round(g.fps), select: document.getElementById('sel-quality').value, buffer: document.getElementById('game').width }; });
  const start = await state();
  ok(start.auto && start.select === 'auto', 'arranca en AUTO y el menú lo refleja', start);
  // cuadros lentos sostenidos: 45 ms de trabajo extra por cuadro (~20 c/s)
  await page.evaluate(() => { const burn = () => { const t = performance.now(); while (performance.now() - t < 45); window.__burn = requestAnimationFrame(burn); }; burn(); });
  await page.waitForFunction((s) => window.BREACH_GFX().controller.step > s, start.step, { timeout: 40000 }).catch(() => {});
  const lowered = await state();
  ok(lowered.step > start.step, 'baja un escalón con los cuadros bajos', lowered);
  await page.waitForFunction((s) => window.BREACH_GFX().controller.step > s, lowered.step, { timeout: 40000 }).catch(() => {});
  const again = await state();
  ok(again.step > lowered.step, 'sigue bajando mientras no se recupere', again);
  ok(again.buffer <= start.buffer, 'la resolución interna no sube al bajar', { antes: start.buffer, ahora: again.buffer });
  // recuperado: se queda donde está
  await page.evaluate(() => cancelAnimationFrame(window.__burn));
  const held = again.step;
  await page.waitForTimeout(9000);
  const steady = await state();
  ok(steady.step === held || steady.fps < 42, 'con cuadros normales no baja más', steady);
  // elegir un nivel a mano apaga el modo automático y se guarda
  const manual = await page.evaluate(() => { const s = document.getElementById('sel-quality'); s.value = 'medium'; s.dispatchEvent(new Event('change')); const g = window.BREACH_GFX(); return { auto: g.auto, quality: g.quality, saved: localStorage.getItem('breach.video.quality') }; });
  ok(!manual.auto && manual.quality === 'medium' && manual.saved === 'medium', 'un nivel manual apaga AUTO', manual);
  // volver a AUTO reinicia lo aprendido
  const back = await page.evaluate(() => { const s = document.getElementById('sel-quality'); s.value = 'auto'; s.dispatchEvent(new Event('change')); const g = window.BREACH_GFX(); return { auto: g.auto, step: g.controller.step, saved: localStorage.getItem('breach.video.quality'), learned: localStorage.getItem('breach.video.auto') }; });
  ok(back.auto && back.step === start.step && back.saved === null && back.learned === null, 'volver a AUTO reinicia', back);
  ok(errors.length === 0, 'sin errores de página', errors.slice(0, 3));
} finally {
  await browser.close(); server.kill();
}
console.log(fail ? `\nCALIDAD AUTOMÁTICA EN JUEGO: ${fail} fallo(s)` : '\nCALIDAD AUTOMÁTICA EN JUEGO: todo verde');
process.exit(fail ? 1 : 0);
