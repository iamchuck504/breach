// La mira identifica al enemigo visible. Tras LOW, ni apuntar a su cabeza ni
// apuntar al nombre que asomaría por encima de la cobertura debe delatarlo.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1&gfx=medium', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('breach.map', 'fortaleza');
    window.BREACH.mapChoice = 'fortaleza';
    document.getElementById('btn-enter').click();
  });
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.locator('#btn-lobby-start:enabled').evaluate((button) => button.click());
  await page.waitForFunction(() => {
    if (window.BREACH.botMatch?.phase !== 'playing') return false;
    // Pausa local en el primer cuadro jugable. Detiene IA, física, daño y
    // proyectiles, pero el juego sigue actualizando cámara y etiquetas por RAF.
    document.getElementById('btn-pause').click();
    return true;
  }, null, { timeout: 120000 });

  const counts = await page.evaluate(async () => {
    const G = window.BREACH, fp = window.BREACH_FP, W = window.BREACH_WORLD;
    const V = window.THREE, smoke = window.BREACH_SMOKE, p = G.player;
    const frame = () => new Promise(requestAnimationFrame);
    const clock = G.simClock;
    const enemy = G.botMatch.bots.find((b) => b.team !== G.team);
    const allies = G.botMatch.bots.filter((b) => b.team === G.team);
    if (!enemy?.rig.nameTag || !allies.length) throw Error('Falta el enemigo con etiqueta o un compañero del observador');
    if (!(enemy.protT > 0)) throw Error('El blanco debe empezar con protección de aparición');
    enemy.rig.setProtected(true);

    // El bloque LOW de la torre está en (-2.5, -2.5). Los demás bots quedan
    // en sus spawns. Solo se recoloca al blanco entre los dos escenarios.
    const x = -2.5, observerZ = 3.5;
    Object.assign(p.pos, { x, z: observerZ });
    p.y = 0;
    p.yaw = p.cam.yaw = p.cam.pitch = 0;
    await frame();

    async function sample(covered) {
      const z = covered ? -3.5 : 0;
      Object.assign(enemy.pos, { x, z });
      enemy.y = 0;
      enemy.rigYaw = enemy.yaw = Math.PI;
      enemy.netAnim = covered ? 'crouch' : 'idle';
      enemy.ce = covered ? 0 : 1;
      enemy.aim = false;
      enemy.coverLean = 0;
      enemy.rig.setTransform(x, z, enemy.yaw, 0);
      // Asentar la postura dibujada antes de medir el punto real del nombre.
      const pose = { state: enemy.netAnim, speed: 0, aim: false, coverAimExposure: enemy.ce };
      for (let i = 0; i < 60; i++) enemy.rig.update(1 / 60, pose);

      const headSphere = () => {
        const t = G.botMatch.targets().find((target) => target.id === enemy.id);
        if (!t) throw Error('El blanco ya no figura entre los enemigos vivos');
        const center = t.hit ? new V.Vector3(t.hit.hx, t.hit.hy, t.hit.hz) : new V.Vector3(t.x, t.y + t.hitVol.h[2], t.z);
        return new V.Sphere(center, t.hit?.hr ?? t.hitVol.hr);
      };
      let shown = 0;
      for (let i = 1; i <= 99; i++) {
        if (!covered && i === 50) {
          enemy.protT = 0;
          enemy.rig.setProtected(false);
        }
        const aimAtTag = covered && i % 2 === 0;
        const aim = aimAtTag ? enemy.rig.nameTag.getWorldPosition(new V.Vector3()) : headSphere().center;
        const d = aim.clone().sub(fp.eye);
        p.cam.yaw = Math.atan2(-d.x, -d.z);
        p.cam.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        await frame();

        const requireFrame = (ok, reason) => {
          if (!ok) throw Error(`Precondición (${covered ? 'tapado' : 'visible'}, cuadro ${i}/99): ${reason}`);
        };
        requireFrame(G.simClock === clock, 'la simulación avanzó durante la pausa');
        requireFrame(G.selfAlive && !p.dead && fp.live && !G.spectator.active, 'observador fuera de su vista en primera persona');
        requireFrame(enemy.alive, 'blanco muerto');
        requireFrame(p.pos.x === x && p.y === 0 && p.pos.z === observerZ, 'observador desplazado');
        requireFrame(enemy.pos.x === x && enemy.y === 0 && enemy.pos.z === z, 'blanco desplazado');

        const { origin, dir } = fp.aimRay();
        const { center: head, radius } = headSphere();
        const point = aimAtTag ? enemy.rig.nameTag.getWorldPosition(new V.Vector3()) : head;
        requireFrame(new V.Ray(origin, dir).distanceToPoint(point) < 0.01, 'el rayo central perdió el punto apuntado');
        const toHead = head.clone().sub(origin);
        const blocked = W.raycast(origin, toHead.clone().normalize(), toHead.length() - radius) !== null;
        requireFrame(blocked === covered, covered ? 'cabeza expuesta' : 'mapa entre el ojo y la cabeza');
        requireFrame(!smoke.blocksSegment(origin.x, origin.y, origin.z, head.x, head.y, head.z), 'humo entre el ojo y la cabeza');
        requireFrame(G.botMatch.bots.every((b) => b === enemy || Math.hypot(b.pos.x - x, b.pos.z - observerZ) > toHead.length() + 2), 'otro bot dentro de la escena');
        if (aimAtTag) requireFrame(W.raycast(origin, dir, origin.distanceTo(point)) === null, 'la cobertura también tapa el punto del nombre');
        if (enemy.rig.nameTag.visible) shown++;
        if (!allies.every((b) => b.alive && b.rig.nameTag?.visible)) throw Error(`Compañero sin etiqueta en el cuadro ${i}`);
      }
      return shown;
    }

    const visible = await sample(false);
    return { visible, covered: await sample(true) };
  });
  assert.deepEqual(errors, [], 'errores del juego durante la prueba');
  assert.equal(counts.visible, 99, `enemigo a la vista y apuntado: etiqueta visible (${counts.visible}/99)`);
  assert.equal(counts.covered, 0, `enemigo tapado: etiqueta visible (${counts.covered}/99)`);
  console.log('FPS NAMETAGS OK · visible 99/99 · tapado 0/99 · compañeros visibles');
} finally {
  await browser.close();
}
