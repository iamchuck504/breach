// CADENA DE IMAGEN: con calidad alta la escena pasa por el buffer HDR y llega
// a pantalla con imagen (no en negro) y sin errores; 'off' sigue siendo el
// render directo; el tope de píxeles baja la resolución interna; y el nivel
// elegido en Opciones → Video se guarda. Sirve dist/: `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8824;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(query, width = 1280, height = 720) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /cadena de imagen desactivada|WebGL.*(INVALID|incomplete)/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1${query}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.waitForTimeout(1200);
  return page;
}
// brillo medio y dispersión del lienzo del juego, leídos de una captura
const stats = async (page) => {
  const png = await page.locator('#game').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data;
    let sum = 0, sq = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
    const mean = sum / n;
    return { mean, dev: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  }, png.toString('base64'));
};

try {
  // cielo, entorno, oclusión y filtro de sombras del nivel en uso
  const look = (page) => page.evaluate(() => {
    const scene = window.BREACH_WORLD.scene, p = window.BREACH_PIPELINE;
    return {
      dome: !!scene.getObjectByName('sky-dome'), background: !!scene.background, env: !!scene.environment,
      ao: !!p.aoRT, depth: !!p.sceneRT?.depthTexture,
      soft: window.BREACH_RENDERER.shadowMap.type === THREE.PCFSoftShadowMap,
      autoShadow: window.BREACH_RENDERER.shadowMap.autoUpdate,
    };
  });
  const off = await open('&gfx=off');
  const sOff = await stats(off);
  check('off: render directo', await off.evaluate(() => window.BREACH_PIPELINE.active === false));
  const lOff = await look(off);
  check('off: cielo y sombras clásicos, sin entorno ni oclusión',
    !lOff.dome && lOff.background && !lOff.env && !lOff.ao && !lOff.soft && lOff.autoShadow, JSON.stringify(lOff));
  await off.close();

  const high = await open('&gfx=high');
  const info = await high.evaluate(() => ({
    active: window.BREACH_PIPELINE.active, failed: window.BREACH_PIPELINE.failed,
    name: window.BREACH_PIPELINE.qualityName, bloom: window.BREACH_PIPELINE.down.length,
    calls: window.BREACH_RENDERER.info.render.calls,
  }));
  if (info.failed) {
    // GPU sin buffers flotantes (p. ej. render por software): el respaldo es
    // el render directo y eso es lo que hay que comprobar.
    const s = await stats(high);
    check('sin soporte: cae a render directo con imagen', !info.active && s.dev > 4, JSON.stringify(s));
  } else {
    const sHigh = await stats(high);
    check('high: cadena activa con bloom', info.active && info.name === 'high' && info.bloom === 5, JSON.stringify(info));
    check('high: hay imagen (no negro ni plano)', sHigh.mean > 6 && sHigh.dev > 4, JSON.stringify(sHigh));
    check('high: brillo cercano al render directo', Math.abs(sHigh.mean - sOff.mean) < Math.max(12, sOff.mean * 0.35),
      `off ${sOff.mean.toFixed(1)} · high ${sHigh.mean.toFixed(1)}`);
    // un blanco muy por encima de 1 (faros, sol) tiene que salir blanco
    for (const grade of ['calle', 'fortaleza', 'azoteas']) {
      const px = await high.evaluate((grade) => {
        const s = new THREE.Scene(); s.background = new THREE.Color(6, 6, 6);
        window.BREACH_PIPELINE.render(s, window.BREACH_CAM, grade);
        const gl = window.BREACH_RENDERER.getContext(), out = new Uint8Array(4);
        gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [...out];
      }, grade);
      check(`blanco saturado sigue blanco (${grade})`, Math.min(px[0], px[1], px[2]) > 200, px.join(','));
    }
    const lHigh = await look(high);
    check('high: cúpula de cielo, entorno, oclusión y sombra suave',
      lHigh.dome && !lHigh.background && lHigh.env && lHigh.ao && lHigh.depth && lHigh.soft && lHigh.autoShadow, JSON.stringify(lHigh));
    // la oclusión oscurece poco y nunca aclara: su textura vive entre 0 y 1
    const ao = await high.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); // cuadros del juego, no el de la prueba anterior
      const p = window.BREACH_PIPELINE, r = window.BREACH_RENDERER, rt = p.aoBlurRT;
      const buf = new Uint16Array(rt.width * rt.height * 4);
      r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
      let sum = 0, min = 9, max = -9, bad = 0; const n = buf.length / 4;
      for (let i = 0; i < buf.length; i += 4) { const v = THREE.DataUtils.fromHalfFloat(buf[i]); if (!(v >= 0 && v <= 1.001)) bad++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
      return { mean: sum / n, min, max, bad };
    });
    check('oclusión: valores válidos, con contraste y sin ennegrecer', ao.bad === 0 && ao.mean > 0.8 && ao.min < 0.9 && ao.max > 0.98, JSON.stringify(ao));
    // haces de luz: activos con el sol proyectando sombra, valores entre 0 y
    // 1, y apagados si el jugador desactiva las sombras
    const beams = await high.evaluate(async () => {
      const p = window.BREACH_PIPELINE, r = window.BREACH_RENDERER, rt = p.aoBlurRT;
      const frames = async (n) => { for (let i = 0; i < n; i++) await new Promise((res) => requestAnimationFrame(res)); };
      await frames(3);
      const buf = new Uint16Array(rt.width * rt.height * 4);
      r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
      let max = 0, bad = 0;
      for (let i = 2; i < buf.length; i += 4) { const v = THREE.DataUtils.fromHalfFloat(buf[i]); if (!(v >= 0 && v <= 1.001)) bad++; max = Math.max(max, v); }
      const on = p.mAO.uniforms.uShafts.value;
      const chk = document.getElementById('chk-shadows');
      chk.checked = false; chk.dispatchEvent(new Event('change')); await frames(3);
      const offNoShadow = p.mAO.uniforms.uShafts.value;
      chk.checked = true; chk.dispatchEvent(new Event('change')); await frames(2);
      localStorage.removeItem('breach.video.shadows');
      return { on, offNoShadow, max, bad };
    });
    check('haces de luz: activos, en rango, y apagados sin sombras',
      beams.on === 1 && beams.offNoShadow === 0 && beams.bad === 0 && beams.max > 0.01, JSON.stringify(beams));
    const wet = await high.evaluate(() => {
      let found = null;
      window.BREACH_WORLD.mapGroup.traverse((o) => { if (!found && o.geometry?.type === 'PlaneGeometry' && o.material?.userData?.breachMacro) found = o.material.customProgramCacheKey(); });
      return found;
    });
    check('suelo de Azoteas con desgaste y charcos', /breach-macro-nn0\.55/.test(wet ?? ''), String(wet));
    check('estadísticas de dibujo cuentan el cuadro entero', info.calls > 20, `calls ${info.calls}`);
  }
  // tope de píxeles: en una ventana grande, 'low' dibuja menos que 'ultra'
  const size = (q) => high.evaluate((q) => {
    const sel = document.getElementById('sel-quality'); sel.value = q; sel.dispatchEvent(new Event('change'));
    const c = document.getElementById('game'); return c.width * c.height;
  }, q);
  await high.setViewportSize({ width: 1920, height: 1080 });
  await high.waitForTimeout(200);
  const pxUltra = await size('ultra'), pxLow = await size('low');
  await high.waitForTimeout(250);
  const lLow = await look(high);
  check('low: cielo sí; sin oclusión, sombra dura y a medio ritmo',
    lLow.dome && lLow.env && !lLow.ao && !lLow.soft && !lLow.autoShadow, JSON.stringify(lLow));
  check('tope de píxeles por nivel', pxLow <= 1.0e6 * 1.02 && pxUltra >= 1920 * 1080 * 0.99, `low ${pxLow} · ultra ${pxUltra}`);
  check('el nivel elegido se guarda', await high.evaluate(() => localStorage.getItem('breach.video.quality') === 'low'));
  await high.waitForTimeout(300);
  await high.close();
  check('sin errores de página ni de WebGL', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close(); server.kill(); await clearClip();
}
if (fails.length) { console.error(`\n✗ IMAGE PIPELINE: ${fails.length} fallo(s)`); process.exit(1); }
console.log('\n✓ IMAGE PIPELINE OK');
