// HUD en seis ventanas: escala de los paneles, retícula, textos y contraste.
// El cuerpo y la mano izquierda se proyectan por separado en cada cuadro.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import { freePort } from './lib-test.mjs';
import { PROFILES } from '../src/view/fp/profiles.js';
import { fitScale } from '../src/ui/hud-layout.js';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
// Toda clave de ajustes tiene sitio en una página y texto en los 7 idiomas
// (salvo las de solo lectura, que no se enseñan). Sin navegador.
{
  const { SETTING_DEFS } = await import('../src/core/settings.js');
  const { SETTINGS_PAGES } = await import('../src/ui/settings-ui.js');
  const { LANGUAGES, setLanguage, t } = await import('../src/core/i18n.js');
  const placed = new Set(Object.values(SETTINGS_PAGES).flat().flatMap((sec) => sec.keys));
  const missing = Object.entries(SETTING_DEFS).filter(([k, d]) => !d.readOnly && !placed.has(k)).map(([k]) => k);
  assert.deepEqual(missing, [], `ajustes sin página: ${missing}`);
  for (const { code } of LANGUAGES) {
    setLanguage(code);
    const raw = Object.values(SETTING_DEFS).map((d) => d.label).filter((l) => t(l) === l);
    assert.deepEqual(raw, [], `${code}: etiquetas sin traducir ${raw}`);
  }
  setLanguage('en');
}

const FREE_PORT = await freePort();

const PORT = FREE_PORT;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 600; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* arrancando */ }
  await new Promise((r) => setTimeout(r, 100));
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: process.env.SWIFT ? ['--use-angle=swiftshader', '--disable-gpu'] : [] });
// Los cuadros se cuentan con el rAF REAL aunque el juego esté congelado.
const framesIn = (n) => new Promise((r) => { const raf = window.__realRaf || requestAnimationFrame; let k = 0; const f = () => (++k >= n ? r() : raf(f)); raf(f); });
const ASPECTS = [['4:3', 1024, 768], ['16:10', 1280, 800], ['16:9', 1280, 720], ['21:9', 1720, 720], ['21:9 grande', 2560, 1080], ['800x600', 800, 600]];
const SCALES = Array.from({ length: 16 }, (_, i) => (75 + 5 * i) / 100);
const weapons = Object.keys(PROFILES);
assert.equal(weapons.length, 8);
const failures = [];
let checked = 0, sleeveBehindPanel = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const frames = (n) => page.evaluate(`(${framesIn})(${n})`);
  // Pausa determinista: el bucle del juego deja de correr (su rAF queda
  // retenido) y lo que se mide es exactamente lo que quedó pintado + lo que
  // la prueba añade; main.js no puede sobrescribirlo a mitad de la medida.
  const pause = () => page.evaluate(`new Promise((r) => { window.__realRaf ??= window.requestAnimationFrame.bind(window);
    window.__held = []; window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0; };
    window.__realRaf(() => window.__realRaf(r)); })`);
  const resume = () => page.evaluate(() => { if (!window.__realRaf) return; window.requestAnimationFrame = window.__realRaf;
    const h = window.__held || []; window.__held = []; for (const cb of h) window.__realRaf(cb); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&fp=1`, { timeout: 300000 });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice' && window.BREACH_HUD, null, { polling: 50 });
  await frames(6);
  await page.waitForFunction(() => document.body.classList.contains('fp'), null, { polling: 50 });

  await page.waitForFunction(() => window.BREACH_VM?.fp2?.active);
  const measure = (mode, pose = 'real') => page.evaluate(async ({ mode, pose }) => {
    const { rectHitsCircle, rectsOverlap, reticleZoneRadius, zoneInPixels } = await import('/src/ui/hud-layout.js');
    const hud = window.BREACH_HUD, W = innerWidth, H = innerHeight;
    if (mode === 'fp' && pose !== 'real') {
      hud.hideWeaponWheel(true);
      hud.clearFeed();
      hud.kill('AXEL', 'blue', 'ROJO 3', 'red', { weapon: 'shotgun' });
      hud.kill('ROJO 2', 'red', 'KITE', 'blue', { weapon: 'sniper', head: true });
      hud.roundPips(1, 0);
      hud.pickupPrompt('Press [F] to replace SMOKE with SNIPER RIFLE');
      hud.killConfirm('ROJO 3', 'smg', true);
      hud.hint('SNIPER RIFLE PICKED UP', 60000);
      hud.center('ROUND 2', 'FIGHT', 60000);
      hud.reticle({ weapon: 'shotgun', spreadDeg: 6.4, aim: 0, fovDeg: 72 });
      hud.health(0.2);
      hud.stance({ crouch: +(pose === 'crouch'), lean: 0, dodgeCd: 0.8 });
    }
    const radius = reticleZoneRadius(H);
    for (const a of document.getAnimations()) { try { if (a.effect?.getTiming?.().iterations !== Infinity) a.finish(); } catch { /* infinita */ } }
    const shown = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.hidden) return false;
      if (['kill-confirm', 'context-hint', 'center-msg', 'spectator'].includes(el.id) && !el.classList.contains('on')) return false;
      if (cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const ids = ['vitals', 'weapon', 'spectator', 'score', 'round-pips', 'kill-confirm', 'pickup-prompt', 'context-hint', 'center-msg', 'btn-pause', 'btn-fs'];
    const blocks = ids.map(id => [id, document.getElementById(id)])
      .concat([...document.querySelectorAll('#feed .row')].map((el, i) => [`feed#${i}`, el]))
      .filter(([, el]) => shown(el));
    const issues = new Set(), contacts = new Set(), painted = new Set();
    // El HUD normalmente ignora el ratón. Habilitar la tarjeta durante
    // el hit-test permite comprobar su orden de pintura respecto al canvas.
    const checkLayer = (id, el, r) => {
      if (painted.has(id)) return;
      painted.add(id);
      const saved = el.style.pointerEvents;
      el.style.pointerEvents = 'auto';
      const stack = document.elementsFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      el.style.pointerEvents = saved;
      if (stack.indexOf(el) < 0 || stack.indexOf(el) >= stack.indexOf(document.getElementById('game'))) {
        issues.add(`${id} no está encima del juego`);
      }
    };
    let sleeveBehind = false;
    // Cada muestra lee el DOM después de colocar los avisos con esa postura.
    const sample = zone => {
      const body = zoneInPixels(zone?.body, W, H), sleeve = zoneInPixels(zone?.sleeve, W, H);
      const rects = blocks.map(([id, el]) => [id, el.getBoundingClientRect()]);
      for (const [i, [id, r]] of rects.entries()) {
        if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) issues.add(`${id} se sale de la ventana`);
        if (rectHitsCircle(r, W / 2, H / 2, radius)) issues.add(`${id} pisa la retícula`);
        for (const [other, b] of rects.slice(i + 1)) {
          if (rectsOverlap(r, b)) issues.add(`${id} pisa ${other}`);
        }
        if (body && rectsOverlap(r, body)) {
          contacts.add(id);
          checkLayer(id, blocks[i][1], r);
        }
        if ((id === 'weapon' || id === 'vitals') && sleeve && rectsOverlap(r, sleeve)) {
          sleeveBehind = true;
          checkLayer(id, blocks[i][1], r);
        }
      }
    };
    if (mode === 'fp') {
      const vm = window.BREACH_VM.fp2.vm, key = window.BREACH.weapons.cur;
      if (vm.key !== key || hud.el.weapon.dataset.weapon !== key) issues.add('arma desincronizada');
      if (pose === 'real') {
        const zone = vm.hudZones();
        for (const part of ['body', 'sleeve']) {
          const current = zone?.[part], received = hud.weaponZone?.[part];
          if (!!current !== !!received || (current && Object.keys(current).some(k => Math.abs(current[k] - received[k]) > 1e-6))) {
            issues.add(`zona del HUD desfasada: ${part}`);
          }
        }
        sample(hud.weaponZone);
      } else {
        const { sampleHudPose } = await import('/scripts/lib-hud-poses.mjs');
        for (const expected of ['vitals', 'weapon', 'center-msg', 'kill-confirm', 'pickup-prompt', 'context-hint']) {
          if (!blocks.some(([id]) => id === expected)) issues.add(`falta ${expected} en el HUD lleno`);
        }
        let sawBody = false;
        sampleHudPose(vm, pose, zone => {
          hud.setWeaponZone(zone);
          sawBody ||= !!zone?.body;
          sample(hud.weaponZone);
        });
        if (!sawBody) issues.add('falta la proyección del cuerpo');
      }
    } else sample(null);
    // retícula: lo dibujado cabe en su zona
    const ret = shown(document.getElementById('reticle')) && document.querySelector('#reticle.on svg');
    let reticleR = 0;
    if (ret) {
      for (const g of ret.querySelectorAll('g, circle.dot')) {
        if (getComputedStyle(g).display === 'none') continue;
        const b = g.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        reticleR = Math.max(reticleR, Math.hypot(Math.max(Math.abs(b.left - W / 2), Math.abs(b.right - W / 2)), Math.max(Math.abs(b.top - H / 2), Math.abs(b.bottom - H / 2))));
      }
      if (reticleR > radius * Math.SQRT2 + 1) issues.add(`retícula fuera de su zona (${reticleR.toFixed(1)} > ${radius})`);
    }
    // tercera persona (muerte/espectador): ni bloque de estado ni retícula
    if (mode === 'tp') {
      if (blocks.some(([id]) => id === 'vitals' || id === 'weapon')) issues.add('bloque de estado visible en tercera persona');
      if (ret) issues.add('retícula visible en tercera persona');
    }
    const labels = [...document.querySelectorAll('#status-dock .vt-label, #hp-val, #dodge-cooldown, #wep-name, #wep-mag, #wep-res, #wep-msg, #wep-slots span')]
      .filter(el => shown(el) && (el.textContent || el.tagName === 'PROGRESS'));
    for (const [i, el] of labels.entries()) {
      const a = el.getBoundingClientRect();
      const panel = el.closest('.hud-panel').getBoundingClientRect();
      if (a.left < panel.left || a.right > panel.right) issues.add(`${el.textContent} desborda la tarjeta`);
      for (const other of labels.slice(i + 1)) {
        if (rectsOverlap(a, other.getBoundingClientRect())) issues.add(`${el.textContent} pisa ${other.textContent || other.id}`);
      }
    }
    const viewportZoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const dims = ['status-dock', 'score'].map(id => {
      const el = document.getElementById(id);
      const zoom = Number(getComputedStyle(el).zoom);
      if (Math.abs(zoom - hud._k * viewportZoom) > 1e-5) issues.add(`${id}: zoom efectivo ${zoom}`);
      return [zoom, el.getBoundingClientRect().width];
    });
    return { issues: [...issues], contacts: [...contacts], ids: blocks.map(([id]) => id), dims, k: hud._k, sleeveBehind };
  }, { mode, pose });

  // Color más desfavorable: manga blanca bajo la tarjeta translúcida.
  // Componer los fondos de cada etiqueta incluye también la ranura activa.
  const contrast = () => page.evaluate(() => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => bg[i] + (v - bg[i]) * (fg[3] ?? 1));
    const light = rgb => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratios = [];
    const dock = document.getElementById('status-dock');
    const labels = [...dock.querySelectorAll('.vt-label,#hp-val,#wep-name,#wep-mag,#wep-res,#wep-msg,.slot span')];
    if (document.querySelector('#hud.model-behind')) labels.push(...document.querySelectorAll(
      '#center-msg.on, #center-msg.on .sub, #context-hint.on, #pickup-prompt, #kill-confirm.on span:not(.kc-wep)'));
    for (const el of labels) {
      if (!el.textContent || !el.getBoundingClientRect().width) continue;
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        layers.unshift(getComputedStyle(node));
        if (node === dock || node.id === 'hud') break;
      }
      const sample = (ink, at = 0, behind = [255, 255, 255]) => {
        const cs = layers[at], bg = blend(rgba(cs.backgroundColor), behind);
        const painted = at + 1 < layers.length ? sample(ink, at + 1, bg) : ink ? blend(rgba(cs.color), bg) : bg;
        return blend([...painted, Number(cs.opacity)], behind);
      };
      const bg = light(sample(false)), ink = light(sample(true));
      ratios.push([el.textContent, (ink + 0.05) / (bg + 0.05)]);
    }
    return ratios;
  });

  for (const [tag, w, h] of ASPECTS) {
    await page.setViewportSize({ width: w, height: h });
    for (const scale of SCALES) {
      // el juego corre unos cuadros: aplica el aspecto (zona del arma real),
      // arranca la recarga y pinta su retícula con la dispersión real
      await resume();
      await page.evaluate(async (scale) => {
        const { setSetting } = await import('/src/core/settings.js');
        setSetting('hudScale', scale, { save: false });
        const G = window.BREACH;
        G.weapons.reset(); G.weapons.st.mag = 3; G.weapons.startReload();
      }, scale);
      await frames(6);
      await pause();
      const real = await measure('fp');
      checked++;
      if (real.issues.length) failures.push(`${tag} ×${scale} (estado real): ${real.issues.join('; ')}`);
      if (!real.ids.includes('weapon')) failures.push(`${tag} ×${scale}: falta el bloque de estado`);
      // La política se afirma independientemente de la decisión de colocación del HUD.
      const narrow = tag === '4:3' || tag === '800x600';
      const strict = !narrow && scale <= 1.15;
      const contactRows = [];
      const record = (label, contacts) => {
        if (!contacts.length) return;
        const row = `${label} (${contacts.join(', ')})`;
        contactRows.push(row);
        const blocked = strict ? contacts : contacts.filter(id => narrow && (id === 'context-hint' || id === 'pickup-prompt'));
        if (blocked.length) failures.push(`${tag} ×${scale}: cuerpo detrás de ${label} (${blocked.join(', ')})`);
      };
      record('estado real', real.contacts);
      let baseline, sliderBaseline;
      for (const key of weapons) {
        await resume();
        await page.evaluate(key => {
          const w = window.BREACH.weapons;
          w.reset();
          if (!w.hasWeapon(key)) w.replaceSlot(key === 'frag' ? 3 : 0, key);
          w.cur = key;
        }, key);
        await frames(3);
        await pause();
        if (scale === 1) {
          // Todos los pasos del deslizador, además de la matriz visual por postura.
          const sizes = await page.evaluate(async () => {
            const { SETTING_DEFS, setSetting } = await import('/src/core/settings.js');
            const { min, max, step } = SETTING_DEFS.hudScale;
            const rows = [];
            for (let i = 0; i <= Math.round((max - min) / step); i++) {
              const value = Number((min + i * step).toFixed(2));
              setSetting('hudScale', value, { save: false });
              rows.push([value, window.BREACH_HUD._k, ...['status-dock', 'score'].map(id => document.getElementById(id).getBoundingClientRect().width)]);
            }
            setSetting('hudScale', 1, { save: false });
            return rows;
          });
          for (const [value, k] of sizes) assert.ok(Math.abs(k - value * fitScale(w, h)) < 1e-12);
          sliderBaseline ??= sizes;
          assert.deepEqual(sizes, sliderBaseline, `${tag} ${key}: escala del deslizador`);
        }
        const poses = ['hip', 'crouch', 'sprint', 'ads', 'swap'];
        if (!PROFILES[key].thrown) poses.push('reload');
        for (const pose of poses) {
          const full = await measure('fp', pose);
          const label = `${tag} ×${scale} ${key}/${pose}`;
          checked++;
          sleeveBehindPanel ||= full.sleeveBehind;
          record(`${key}/${pose}`, full.contacts);
          assert.ok(full.dims.every(([, width]) => width > 0), label);
          assert.equal(full.k, scale * fitScale(w, h), label);
          baseline ??= full.dims;
          assert.deepEqual(full.dims, baseline, `${label}: cambió el tamaño de los paneles`);
          if (full.issues.length) failures.push(`${label}: ${full.issues.join('; ')}`);
        }
        const ratios = await contrast();
        await page.evaluate(() => {
          const w = window.BREACH.weapons;
          w.st.mag = 0;
          w.st.reserve = 0;
          window.BREACH_HUD.ammo(w);
          for (const a of document.getElementById('weapon').getAnimations({ subtree: true })) {
            if (a.effect?.getTiming().iterations !== Infinity) a.finish();
          }
        });
        ratios.push(...await contrast());
        assert.ok(ratios.length >= 5, 'faltan textos de estado');
        for (const [label, ratio] of ratios) if (ratio < 4.5) failures.push(`${key}: contraste de ${label} = ${ratio.toFixed(2)}:1`);
      }
      console.log(`${tag} ×${scale} — contactos del cuerpo: ${contactRows.join('; ') || 'ninguno'}`);
    }
    // cámara de muerte y espectador (tercera persona): la tarjeta ocupa el
    // sitio del bloque de estado; ni arma ni retícula
    await page.evaluate(() => { const h = window.BREACH_HUD; h.pickupPrompt(''); h.markers(null); });
    const death = await measure('tp');
    checked++;
    if (death.issues.length) failures.push(`${tag} cámara de muerte: ${death.issues.join('; ')}`);
    await page.evaluate(() => window.BREACH_HUD.spectator({ name: 'AXEL', controls: 'X/R · RB SWITCH', respawn: 'NEXT RESPAWN WAVE · 7s', ready: false }));
    const s = await measure('tp');
    checked++;
    if (s.issues.length) failures.push(`${tag} espectador: ${s.issues.join('; ')}`);
    if (!s.ids.includes('spectator')) failures.push(`${tag} espectador: no se ve la tarjeta`);
    await page.evaluate(() => { const h = window.BREACH_HUD; h.spectator(null); h.centerOff(); h.health(1); });
  }
  await resume();

  // Sniper con el ojo en la lente: ningún rectángulo VISIBLE del HUD cae
  // dentro del círculo de la lente (radio 46 % del lado corto).
  for (const [tag, w, h] of ASPECTS.filter(([t]) => ['4:3', '16:10', '16:9', '21:9'].includes(t))) {
    await page.setViewportSize({ width: w, height: h });
    for (const scale of SCALES) {
      await resume();
      await page.evaluate(async (scale) => {
        const { setSetting } = await import('/src/core/settings.js');
        setSetting('hudScale', scale, { save: false });
      }, scale);
      await frames(4);
      await pause();
      const lens = await page.evaluate(async () => {
        const { rectHitsCircle } = await import('/src/ui/hud-layout.js');
        const hud = window.BREACH_HUD;
        hud.markers([], window.BREACH_CAM); // vista de los ojos
        hud.kill('AXEL', 'blue', 'ROJO 3', 'red', { weapon: 'sniper' });
        hud.pickupPrompt('Press [F] to replace SMOKE with SNIPER RIFLE');
        hud.hint('SNIPER RIFLE PICKED UP', 60000);
        hud.center('ROUND 2', 'FIGHT', 60000);
        hud.sniperScope(true, { in01: 1 });
        for (const a of document.getAnimations()) { try { if (a.effect?.getTiming?.().iterations !== Infinity) a.finish(); } catch { /* infinita */ } }
        const W = innerWidth, H = innerHeight, r = 0.46 * Math.min(W, H);
        const seen = (el) => {
          let k = 1;
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
            k *= Number(cs.opacity);
            const f = /opacity\(([\d.]+)\)/.exec(cs.filter);
            if (f) k *= Number(f[1]);
          }
          return k;
        };
        const ids = ['status-dock', 'score', 'round-pips', 'kill-confirm', 'pickup-prompt', 'context-hint', 'center-msg', 'btn-pause', 'btn-fs'];
        const els = ids.map((id) => [id, document.getElementById(id)]).concat([...document.querySelectorAll('#feed .row')].map((e, i) => [`feed#${i}`, e]));
        const hits = [];
        for (const [id, el] of els) {
          if (!el || el.hidden) continue;
          if (['kill-confirm', 'context-hint', 'center-msg'].includes(id) && !el.classList.contains('on')) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || seen(el) < 0.02) continue;
          if (rectHitsCircle(b, W / 2, H / 2, r)) hits.push(id);
        }
        hud.sniperScope(false); hud.centerOff(); hud.pickupPrompt('');
        return hits;
      });
      checked++;
      if (lens.length) failures.push(`${tag} ×${scale} con scope: dentro de la lente ${lens.join(', ')}`);
    }
  }
  await resume();

  // La retícula dibuja la dispersión que recibe: el hueco crece con ella.
  await page.setViewportSize({ width: 1280, height: 720 });
  await frames(4);
  await pause();
  const gaps = await page.evaluate(async (fr) => {
    const hud = window.BREACH_HUD, out = [];
    for (const s of [0.5, 2, 4]) {
      hud.reticle({ weapon: 'smg', spreadDeg: s, aim: 0, fovDeg: 72 });
      await (0, eval)(fr)(1);
      const line = document.querySelector('#reticle .rk-auto line');
      out.push(Math.abs(Number(line.getAttribute('x1'))));
    }
    return out;
  }, `(${framesIn})`);
  const expect = (deg) => Math.tan(deg * Math.PI / 180) / Math.tan(36 * Math.PI / 180) * 360;
  assert.ok(gaps[0] < gaps[1] && gaps[1] < gaps[2], `la separación no crece con la dispersión: ${gaps}`);
  assert.ok(Math.abs(gaps[2] - expect(4)) <= 1, `separación ${gaps[2]} ≠ ${expect(4).toFixed(1)} px para 4°`);
  // ADS: las marcas se retiran (las miras del arma hacen el trabajo)
  const ads = await page.evaluate(async (fr) => {
    document.querySelector('#reticle .rk-auto').style.transition = 'none'; // el fundido es de tiempo, no de cuadros
    window.BREACH_HUD.reticle({ weapon: 'smg', spreadDeg: 0.9, aim: 1 });
    await (0, eval)(fr)(2);
    return getComputedStyle(document.querySelector('#reticle .rk-auto')).opacity;
  }, `(${framesIn})`);
  assert.equal(ads, '0', 'en ADS la retícula de la SMG debería retirarse');

  // Marcadores con un oclusor REAL del mapa: se busca una pared delante de la
  // cámara y se colocan personajes detrás y a la vista. La oclusión sale del
  // mismo raycast del mundo que usa main.js. Compañero tapado: chevrón hueco;
  // enemigo tapado (aunque venga "apuntado"): nada; enemigo a la vista sin
  // identificar: nada; enemigo identificado a la vista: su marca.
  const mk = await page.evaluate(() => {
    const hud = window.BREACH_HUD, cam = window.BREACH_CAM, W = window.BREACH_WORLD, T = window.THREE;
    let wall = null;
    for (let a = 0; a < 64 && !wall; a++) {
      const yaw = a / 64 * Math.PI * 2, dir = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const d = W.raycast(cam.position, dir, 12, 0);
      if (d !== null && d > 2) wall = { dir, d };
    }
    if (!wall) return { error: 'sin pared cerca' };
    // mirar a la pared (la pausa mantiene esta orientación)
    cam.lookAt(cam.position.clone().add(wall.dir)); cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const side = new T.Vector3(wall.dir.z, 0, -wall.dir.x);
    const feet = (dist, off) => { const p = cam.position.clone().addScaledVector(wall.dir, dist).addScaledVector(side, off); return { x: p.x, y: p.y - 1.5, z: p.z }; };
    const occluded = (q) => { const v = new T.Vector3(q.x, q.y + 1.5, q.z).sub(cam.position); const d = v.length();
      return W.raycast(cam.position, v.normalize(), d - 0.3, 0) !== null; };
    const behind = feet(wall.d + 2, 0), open = feet(Math.min(1.6, wall.d - 0.6), 0.6);
    const set = [
      { ...behind, team: 'red', ally: true, name: 'A' },
      { ...behind, team: 'blue', ally: false, aimed: true, name: 'B' },
      { ...open, team: 'blue', ally: false, aimed: false, name: 'C' },
      { ...open, team: 'blue', ally: false, aimed: true, name: 'D' },
    ].map((m) => ({ ...m, occluded: occluded(m) }));
    hud.markers(set, cam);
    const on = [...document.querySelectorAll('#markers .mk.on')];
    return { occ: set.map((m) => m.occluded), allies: on.filter((e) => e.classList.contains('ally')).length,
      hollow: on.filter((e) => e.classList.contains('occ')).length, foes: on.filter((e) => e.classList.contains('foe')).length,
      text: document.getElementById('markers').textContent.trim() };
  });
  assert.ok(!mk.error, mk.error);
  assert.deepEqual(mk.occ, [true, true, false, false], `el oclusor no tapa lo esperado: ${JSON.stringify(mk)}`);
  assert.deepEqual({ allies: mk.allies, hollow: mk.hollow, foes: mk.foes, text: mk.text }, { allies: 1, hollow: 1, foes: 1, text: '' },
    `marcadores: ${JSON.stringify(mk)}`);

  // Cono completo: el radio dibujado nunca es menor que el real, a cualquier
  // FOV y resolución. Si no cabe en la zona central, cambia de forma (círculo
  // fino al radio real) en vez de toparse.
  const cones = [];
  for (const [w, h] of [[800, 600], [1280, 720], [2560, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    cones.push(...await page.evaluate(() => {
      const hud = window.BREACH_HUD, out = [], R = Math.max(52, Math.round(innerHeight * 0.09));
      for (const fov of [60, 72, 100]) for (const deg of [0.4, 1, 3, 6.4, 10, 16.6]) {
        hud.reticle({ weapon: 'shotgun', spreadDeg: deg, aim: 0, fovDeg: fov });
        const root = document.getElementById('reticle'), wide = root.classList.contains('wide');
        const r = Number(root.querySelector(wide ? '.wide-ring' : '.rk-pattern .ring').getAttribute('r'));
        const truth = Math.tan(deg * Math.PI / 180) / Math.tan(fov * Math.PI / 360) * innerHeight / 2;
        out.push({ h: innerHeight, fov, deg, r, truth, wide, R });
      }
      return out;
    }));
  }
  const bad = cones.filter((c) => c.r < c.truth - 0.5 || (c.wide && Math.abs(c.r - c.truth) > 0.5) || (!c.wide && c.r > c.R));
  assert.deepEqual(bad, [], `cono mal representado: ${JSON.stringify(bad)}`);
  assert.ok(cones.some((c) => c.wide) && cones.some((c) => !c.wide), 'la prueba no cubrió los dos regímenes');
  await page.setViewportSize({ width: 1280, height: 720 });
  await resume();

  assert.ok(sleeveBehindPanel, 'ninguna composición probó el estado encima de la manga izquierda');
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.deepEqual(errors, []);
  console.log(`FPS HUD OK: ${checked} composiciones (6 ventanas × ${SCALES.length} escalas, estado real y HUD lleno, + muerte y espectador) con retícula y cuerpo comprobados; dispersión ${gaps.map((g) => g.toFixed(1)).join('/')} px.`);
} finally { await browser.close(); server.kill(); }
