// Juego limpio FPS (corrida 6): el servidor valida el ORIGEN del disparo de
// un cliente FPS (a ≤0.4 m del centro de su cabeza, sin muro de por medio),
// acota el ritmo de la postura y admite solo clientes FPS. Y la matriz de
// versiones cliente/servidor.
//   node scripts/check-fps-origin.mjs
// 1. Node puro: originToHead con movimiento honesto (correr, sprint→disparo,
//    deslizar a 8 m/s, salto, agacharse, asomo, inclinación), jitter de
//    llegada y RTT; orígenes desplazados rechazados.
// 2. Servidor real (puerto propio): cliente sin `fps` rechazado con
//    lobbyError 'reload-page'; welcome con fps:1; disparo desde el ojo
//    aceptado, desde la altura antigua (1.1) o la cámara de hombro rechazado,
//    origen tras un muro rechazado; `crouch` difundido con su `ce`; cabeza
//    que sube de golpe recortada; estados retirados traducidos; tope de
//    movimiento FPS.
// 3. Matriz con el NetClient real: servidor nuevo → `crouch`; servidor sin
//    `fps` (anterior) → rechazo y cierre; cliente viejo → rechazado.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { eyeWorld, eyeFromPose as eyeFromPoseNew, headWorld, hitPose, shotPose, FPS_EYE_TOL, placeHitPose } from '../src/combat/hit-pose.js';
import { acceptPosture, acceptMovement, resetMovementGuard } from '../server/guards.js';
import { TUNING } from '../src/config/tuning.js';
import { localPose } from '../src/net/client.js';
import { spreadFor as spreadForW } from '../src/combat/weapons.js';
import { withSamples, nextN } from './lib-fps-sample.mjs';
const srvWrap = (a) => { a = a % (Math.PI * 2); return a > Math.PI ? a - Math.PI * 2 : a <= -Math.PI ? a + Math.PI * 2 : a; };
import { mapLineBlocked } from '../server/map-geometry.js';
import { freePort, waitHttp } from './lib-test.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const note = (s) => console.log(s);
let rnd = 777;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const r2 = (v) => +v.toFixed(2);

// ---------- 1. Node puro: la tubería real cliente → servidor ----------
// Cliente: controlador simulado a 120 Hz (subpasos) y 60 Hz de cuadro; el
// tiro sale en un SUBPASO con su muestra (localPose de ese subpaso) y su ojo
// (eyeWorld); los estados los empaqueta el NetClient real (20 Hz + los dos
// del cambio de postura). Servidor: los mensajes en el orden de envío con
// llegada = envío + rtt/2 + jitter (TCP conserva el orden), cada estado y
// cada `fs` por las guardas reales (acceptMovement FPS por postura,
// acceptPosture) y el ojo reconstruido con shotPose + eyeWorld, como
// server.js fpsOriginLegal. Nada se inserta a mano.
{
  globalThis.WebSocket ??= class {};
  const { NetClient } = await import('../src/net/client.js');
  const F = TUNING.fp;
  const approach = (v, t, step) => v + Math.max(-step, Math.min(step, t - v));
  // perfiles: estado pedido, velocidad, giro y postura por tiempo
  const profiles = {
    'trote + lean': (t) => ({ st: 'run', v: 4.6, turn: 1.5, aim: t > 0.5, lean: Math.sin(t * 3) }),
    'sprint ↔ trote (mezcla 0.2 s)': (t) => ({ st: Math.floor(t / 0.7) % 2 ? 'roadie' : 'run', v: Math.floor(t / 0.7) % 2 ? 6.9 : 4.6, turn: 0.3 }),
    'slide desde sprint': (t) => ({ st: t % 1.4 < 0.6 ? 'roadie' : t % 1.4 < 1.1 ? 'slide' : 'crouch', v: t % 1.4 < 0.6 ? 6.9 : t % 1.4 < 1.1 ? 7.8 - 8 * ((t % 1.4) - 0.6) : 2.2, turn: 0 }),
    'agacharse/levantarse + asomo': (t) => ({ st: Math.floor(t / 0.55) % 2 ? 'crouch' : 'idle', v: 0, aim: Math.floor(t / 0.37) % 2 === 1, turn: 0 }),
    'girar sin parar (50 rad)': (t) => ({ st: 'idle', v: 0, turn: 25, aim: true }),
    'salto con sprint': (t) => ({ st: t % 0.9 < 0.6 ? 'jump' : 'roadie', v: 6.9, turn: 0.5 }),
  };
  let shots = 0, worst = 0, worstName = '', rejected = 0, guardsClipped = 0;
  // 60 y 30 FPS (ronda 2, R1: a 30 FPS con ±30 ms se medían 8.7 cm)
  for (const [name, f] of Object.entries(profiles)) for (const fpsRate of [60, 30]) for (const jitter of [0, 0.03]) for (const rtt of [0.02, 0.12, 0.25]) {
    const net = new NetClient(); net.connected = true; net.fps = true;
    const out = []; let clock = 0;
    net.send = (m) => out.push({ m: JSON.parse(JSON.stringify(m)), sentAt: clock });
    const player = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, aim: false, cam: { pitch: 0 }, lean: 0, stanceLow: 0, speed: 0, _st: 'idle',
      animState() { return this._st; }, animParams() { return { mantlePhase: 0 }; }, cameraYawError: () => 0 };
    const wep = { cur: 'smg', st: { mag: 30, reserve: 90 }, reloading: false, def: { reloadTime: 2 } };
    let vy = 0;
    for (let k = 0; k <= 2 * 120; k++) {
      const t = k / 120; clock = t;
      const c = f(t), dt = 1 / 120;
      // controlador: postura con sus rampas, posición, giro
      player._st = c.st === 'jump' ? 'jump' : c.st; player.aim = !!c.aim;
      player.stanceLow = approach(player.stanceLow, c.st === 'crouch' || c.st === 'slide' ? 1 : 0, dt / F.crouchTime);
      player.lean = approach(player.lean, c.lean ?? 0, dt / F.leanTime);
      player.yaw += (c.turn || 0) * dt;
      player.pos.x += -Math.sin(player.yaw) * c.v * dt; player.pos.z += -Math.cos(player.yaw) * c.v * dt;
      player.speed = c.v;
      if (c.st === 'jump') { vy -= 15 * dt; player.y = Math.max(0, player.y + vy * dt); if (player.y === 0) vy = 6.2; } else { player.y = 0; vy = 6.2; }
      const fstep = 120 / fpsRate;
      if (k % fstep === 0) net.tickState(1 / fpsRate, player, wep, t); // cuadro
      // tiro en un subpaso (no en sprint ni trepando: puerta del cliente)
      if (rand() < 0.25 && c.st !== 'roadie') {
        const pose = localPose(player, 'smg', t);
        const origin = eyeWorld({ ...pose, ae: 0 }, player.pos.x, player.y, player.pos.z, player.yaw);
        net.fire({ x: origin[0], y: origin[1], z: origin[2] }, { x: 0, y: 1, z: -30 }, 'smg', [], player,
          { pose, x: player.pos.x, y: player.y, z: player.pos.z, yaw: player.yaw, ae: 0, t });
      }
    }
    // servidor
    const ent = { fps: true, x: 0, y: 0, z: 0 }; resetMovementGuard(ent, 0); let last = 0;
    const self = [];
    const accept = (m, at) => {
      const st = m.st;
      if (!acceptMovement(ent, { x: m.x, y: m.y, z: m.z, st, ct: m.ct }, at)) return false;
      ent.x = m.x; ent.y = m.y; ent.z = m.z;
      const want = Number.isFinite(m.ce) ? m.ce : 1;
      const acc = acceptPosture(ent, { st, aim: !!m.aim, ce: want, cl: m.cl }, at, m.ct);
      if (Math.abs(acc.ce - (st === 'crouch' ? want : acc.ce)) > 1e-6) guardsClipped++;
      self.push({ at, ct: m.ct, x: m.x, y: m.y, z: m.z, yaw: srvWrap(m.yaw), st: acc.st, aim: m.aim ? 1 : 0, ce: acc.ce, cl: acc.cl, p: m.p, ae: m.ae, sp: m.sp ?? 0, w: 'smg' });
      while (self.length > 2 && self[0].at < at - 0.5) self.shift();
      return true;
    };
    for (const { m, sentAt } of out) {
      const at = (last = Math.max(last, sentAt + rtt / 2 + (rand() - 0.5) * 2 * jitter));
      if (m.t === 's') accept(m, at);
      else if (m.t === 'fire') {
        shots++;
        if (!accept(m.fs, at)) { rejected++; if (process.env.DEBUG) console.log('MOV', name, sentAt.toFixed(3), m.fs.st); continue; }
        const cur = self[self.length - 1], pose = shotPose(self, m.fs.ts);
        const e = eyeWorld(pose, cur.x, cur.y, cur.z, cur.yaw), d = Math.hypot(...e.map((v, i) => v - m.o[i]));
        if (d > worst) { worst = d; worstName = `${name} ${fpsRate} FPS jitter ${jitter} rtt ${rtt}`; }
        if (d > FPS_EYE_TOL) { rejected++; if (process.env.DEBUG) console.log('EYE', name, jitter, rtt, sentAt.toFixed(3), d.toFixed(3), JSON.stringify(m.fs), JSON.stringify({ ...pose, from: pose.from?.st, fromTo: undefined })); }
      }
    }
  }
  assert.equal(rejected, 0, `${rejected} de ${shots} tiros honestos rechazados (peor ${worst.toFixed(4)} m en ${worstName})`);
  // 1e agacharse con jitter (auditoría): dos estados honestos que llegan
  // juntos tras 100 ms; con el presupuesto por llegada se recortaba `ce`, con
  // el del reloj de simulación (ct) no
  {
    const run = (useCt) => {
      const e = { fps: true }; acceptPosture(e, { st: 'idle', ce: 1, cl: 0 }, 0, useCt ? 0 : undefined);
      // 0.18 s de agacharse a 60 Hz enviado a 20 Hz; los estados de 50 y 100 ms llegan juntos a 100 ms
      const sends = [[0.05, 1 - 0.05 / 0.18], [0.10, 1 - 0.10 / 0.18], [0.15, 1 - 0.15 / 0.18]];
      let worstD = 0;
      for (const [ct, ce] of sends) {
        const arrive = ct <= 0.10 ? 0.10 : ct;
        const acc = acceptPosture(e, { st: 'crouch', ce, cl: 0 }, arrive, useCt ? ct : undefined);
        const eyeC = eyeWorld({ st: 'crouch', ce }, 0, 0, 0, 0), eyeS = eyeWorld({ st: 'crouch', ce: acc.ce }, 0, 0, 0, 0);
        worstD = Math.max(worstD, Math.hypot(...eyeC.map((v, i) => v - eyeS[i])));
      }
      return worstD;
    };
    const before = run(false), after = run(true);
    assert.ok(after <= FPS_EYE_TOL && before > FPS_EYE_TOL, `agacharse con jitter: antes ${before}, ahora ${after}`);
    note(`1e agacharse con 100 ms de jitter (dos estados juntos): ojo del servidor a ${(before * 100).toFixed(1)} cm del cliente con el presupuesto por llegada → ${(after * 1000).toFixed(1)} mm con el reloj de simulación acotado (ct ≤ mejor desfase + 0.15 s)`);
    // ct inflado no da crédito: 10 s de ct en 0.05 s reales
    const e2 = { fps: true };
    for (let i = 0; i <= 10; i++) acceptPosture(e2, { st: 'crouch', ce: 0, cl: 0 }, i * 0.05, i * 0.05);
    const cheat = acceptPosture(e2, { st: 'idle', ce: 1, cl: 0 }, 0.55, 10);
    assert.ok(cheat.ce <= 0.5 + 1e-9 && cheat.st === 'crouch', `ct inflado subió la cabeza a ${cheat.ce}`);
  }
  // 1f slide/placaje: reentrar sin sprint no renueva el presupuesto rápido
  {
    const F2 = TUNING.fp;
    const seq = (states, speed) => {
      const e = { x: 0, y: 0, z: 0, fps: true }; resetMovementGuard(e, 0); let t = 0, ok = true;
      for (const [st, dur, v] of states) for (let k = 0; k < Math.round(dur / 0.05); k++) {
        t += 0.05; const n = { x: e.x + (v ?? speed) * 0.05, y: 0, z: 0, st };
        if (acceptMovement(e, n, t)) e.x = n.x; else ok = false;
      }
      return ok;
    };
    assert.ok(seq([['roadie', 0.6, F2.sprintSpeed], ['slide', 0.5, F2.slideMaxSpeed]]), 'slide legal desde sprint rechazado');
    assert.ok(!seq([['roadie', 0.6, F2.sprintSpeed], ['slide', 0.5, F2.slideMaxSpeed], ['crouch', 0.1, 2], ['slide', 0.5, F2.slideMaxSpeed], ['crouch', 0.1, 2], ['slide', 0.5, F2.slideMaxSpeed]]),
      'slides encadenados sin sprint a 8 m/s aceptados');
    assert.ok(!seq([['run', 0.6, 4.6], ['melee', 0.45, F2.tackleTopSpeed], ['run', 0.1, 4.6], ['melee', 0.45, F2.tackleTopSpeed], ['run', 0.1, 4.6], ['melee', 0.45, F2.tackleTopSpeed]]), 'placajes sin sprint a 11 m/s aceptados');
    note('1f slide sólo desde sprint y pasado el enfriamiento; placaje sólo desde sprint/slide: reentradas sin entrada legal vuelven a su velocidad lenta');
  }
  // 1g cadena de mezclas acotada: alternar carrera/sprint cada 150 ms 15 s
  {
    const { trackTransition } = await import('../src/net/client.js');
    const actor = {}; let maxDepth = 0;
    const depth = (p) => (p?.from ? 1 + (p.from.vol ? 0 : depth(p.from)) : 0);
    const t0 = performance.now();
    for (let t = 0; t <= 15; t += 1 / 60) {
      const pose = trackTransition(actor, { st: Math.floor(t / 0.15) % 2 ? 'roadie' : 'run', sp: 0.6 }, t);
      maxDepth = Math.max(maxDepth, depth(pose)); hitPose(pose);
    }
    const ms = performance.now() - t0;
    assert.ok(maxDepth <= 1, `cadena de mezclas de ${maxDepth} eslabones`);
    note(`1g alternar carrera/sprint cada 150 ms durante 15 s: cadena ≤ ${maxDepth} eslabón (antes 100 poses), 900 evaluaciones en ${ms.toFixed(0)} ms`);
  }
  // ---------- ronda 2: casos puros ----------
  {
    const { acceptPosture: AP, POSTURE_CREDIT: PC } = await import('../server/guards.js');
    // R1: una llegada no gasta más tiempo que el de servidor acumulado
    const e = { fps: true };
    for (let i = 0; i <= 20; i++) AP(e, { st: 'crouch', ce: 0, cl: 0 }, i * 0.05, i * 0.05);
    const a1 = AP(e, { st: 'idle', ce: 1, cl: 0 }, 1.01, 1.15); // ct +0.15 adelantado, 10 ms de servidor
    assert.ok(a1.ce <= PC + 8 * 0.02 + 1e-9, `R1: una llegada gastó ${a1.ce}`);
    // R1: primera muestra de la vida = disparo, y ct que retrocede (ms→s): no se congela
    const f = { fps: true }; AP(f, { st: 'idle', ce: 1, cl: 0 }, 0, 5000);
    let ok = false; for (let i = 1; i <= 10; i++) ok = AP(f, { st: 'crouch', ce: 0, cl: 0 }, i * 0.05, i * 0.05).ce === 0 || ok;
    assert.ok(ok, 'R1: el crédito quedó congelado tras un ct en otra unidad');
    note('R1 una llegada con ct +0.15 s y 10 ms de servidor no gasta más de lo que el banco de tiempo de servidor permite; primera muestra con ct en otra unidad → la referencia se reinicia, no se congela');
    // R5 / ronda 1 ítem 4: exposición entre snapshots, impactable por la muestra evaluada
    const { claimPose: CP } = await import('../src/combat/hit-pose.js');
    const snap = (at, ce) => ({ at, x: 0, y: 0, z: 0, yaw: 0, st: 'crouch', aim: 1, ce, cl: 0, p: 0, w: 'smg', sp: 0 });
    const histBase = [snap(0, 0), snap(0.05, 0), snap(0.10, 0), snap(0.15, 0)];
    const expo = { ...snap(0.07, 0.5), vol: hitPose({ st: 'crouch', aim: true, ce: 0.5, wep: 'smg' }) };
    const {shapeAt} = await import('../src/combat/hit-pose.js');
    const withSample = [...histBase.slice(0,2),expo,...histBase.slice(2)];
    for (const t of [0.069,0.071]) assert.deepEqual(shapeAt(withSample,t).vol,shapeAt(histBase,t).vol);
    assert.deepEqual(shapeAt(withSample,expo.at).vol,expo.vol);
    const head = [expo.vol.h[1], expo.vol.h[2], -expo.vol.h[0]];
    const shotAt = 0.07 + 0.12 + 0.05; // el rival ve con interpDelay + rtt
    const without = CP(histBase, shotAt, head, { rtt: 0.05 });
    const withIt = CP([...histBase.slice(0, 2), expo, ...histBase.slice(2)], shotAt, head, { rtt: 0.05 });
    assert.ok(!without?.head && withIt?.head, `R5: exposición entre snapshots ${withIt?.head ? 'impactable' : 'NO impactable'} (sin la muestra: ${without?.head ? 'sí' : 'no'})`);
    note('R5: el rebobinado acredita la cabeza en la muestra de exposición de 20 ms. Esta prueba solo evalúa el historial del servidor.');
    // R13: cadena memorizada = cadena exacta sin truncar (carrera/sprint cada 100 ms)
    const { shapeAt: SA, freezePose: FZ, hitPose: HP2 } = await import('../src/combat/hit-pose.js');
    const h = []; for (let t = 0; t <= 2; t += 0.05) h.push({ at: +t.toFixed(3), x: 0, y: 0, z: 0, yaw: 0, st: Math.floor(t / 0.1) % 2 ? 'roadie' : 'run', aim: 0, ce: 1, cl: 0, p: 0, w: 'smg', sp: 0.6 });
    // referencia: recursión completa sin caché
    const key = (q) => (['idle', 'run', 'jump', 'crouch'].includes(q.st) ? 'u' : q.st);
    const inp = (q) => ({ st: q.st, aim: false, ce: q.ce, cl: q.cl, pitch: 0, wep: 'smg', sp: q.sp });
    const exactAt = (i, t) => {
      let j = i; while (j > 0 && key(h[j - 1]) === key(h[i])) j--;
      if (j === 0) return inp(h[i]);
      const entry = (h[j - 1].at + h[j].at) / 2;
      return { ...inp(h[i]), from: { vol: HP2(exactAt(j - 1, entry)) }, fromTo: inp(h[j]), since: Math.max(0, t - entry) };
    };
    let worst13 = 0;
    for (let t = 0.3; t <= 1.9; t += 0.01) {
      let i = h.length - 1; while (i > 0 && h[i - 1].at > t) i--;
      const a = SA(h, t).vol.h, b = HP2(exactAt(i, t)).h;
      worst13 = Math.max(worst13, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    assert.ok(worst13 <= 0.01, `R13: cadena memorizada a ${worst13} m de la exacta`);
    note(`R13 carrera/sprint cada 100 ms: cadena congelada incremental (por snapshot) a ${(worst13 * 1000).toFixed(1)} mm de la exacta sin truncar (antes hasta 71 mm)`);
    // R6: golpe compartido (desde el ojo) y convergencia del cohete
    const { meleeTargetPoint, meleeReachOk } = await import('../src/combat/melee-reach.js');
    const eyeM = eyeWorld({ st: 'idle' }, 0, 0, 0, 0);
    const lowRival = placeHitPose(hitPose({ st: 'crouch', ce: 0 }), 0, 0, -1.2, Math.PI);
    const tp = meleeTargetPoint(eyeM, lowRival);
    assert.ok(meleeReachOk(eyeM, 0, tp.point), `R6: rival agachado a 1.2 m fuera del golpe (${tp.dist.toFixed(2)} m)`);
    const { launchWorld: LW, rocketConvergeMaxDeg: RC, rocketAimDir: RAD } = await import('../src/combat/hit-pose.js');
    const lw = LW({ st: 'idle', aim: true, wep: 'bazooka' }, 0, 0, 0, 0), conv = RC(lw.launch, lw.eye, lw.fwd);
    const d3 = RAD(lw.launch, lw.eye, lw.fwd, 3), a3 = Math.acos(d3[0] * lw.fwd[0] + d3[1] * lw.fwd[1] + d3[2] * lw.fwd[2]) * 180 / Math.PI;
    assert.ok(a3 <= conv + 1e-9, `R6: cohete a 3 m converge ${a3}° > admitido ${conv}°`);
    note(`R6 golpe compartido: agachado a 1.2 m, punto a ${tp.dist.toFixed(2)} m del ojo, dentro; cohete a 3 m converge ${a3.toFixed(2)}° ≤ ${conv.toFixed(2)}° admitidos (+ dispersión + 2°; antes 2.75°)`);
    // R7: slide no renueva antes de su ciclo; placaje exige slide LEGAL
    const F3 = TUNING.fp;
    const seq = (parts) => {
      const e2 = { x: 0, y: 0, z: 0, fps: true }; resetMovementGuard(e2, 0); let t = 0, good = true;
      for (const [stt, dur, v] of parts) for (let k = 0; k < Math.round(dur / 0.05); k++) {
        t += 0.05; const n = { x: e2.x + v * 0.05, y: 0, z: 0, st: stt }; if (acceptMovement(e2, n, t)) e2.x = n.x; else good = false;
      }
      return good;
    };
    assert.ok(!seq([['roadie', 0.6, F3.sprintSpeed], ['slide', 0.5, 8], ['roadie', 0.3, F3.sprintSpeed], ['slide', 0.5, 8]]), 'R7: slide renovado antes de 1.1 s');
    assert.ok(seq([['roadie', 0.6, F3.sprintSpeed], ['slide', 0.5, 8], ['roadie', 0.7, F3.sprintSpeed], ['slide', 0.5, 8]]), 'R7: slide honesto tras su ciclo rechazado');
    assert.ok(!seq([['run', 0.6, 4.6], ['slide', 0.4, 2.3], ['melee', 0.45, 11]]), 'R7: placaje tras un slide no legal');
    // Cadencia sobre el reloj de simulación acotado (matriz honesta): SMG
    // honesta a su RPM con llegadas en ráfagas de jitter 0–60 ms → 0
    // rechazos; con `ct` inflado, nunca más tiros que el horario de servidor
    // + el crédito de atasco de HEAD (0.3 s)
    {
      const { advanceCadenceClock: ACC, fireCadenceAllows: FCA, commitFireCadence: CFC, noteMessageArrival: NMA } = await import('../server/guards.js');
      const iv = 60 / TUNING.weapons.smg.rpm;
      const run = (jit, inflate) => {
        const e = { fps: true, w: 'smg' }; let last = 0, rej = 0, acc = 0, srv = 0; let r = 7;
        const rnd2 = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
        for (let k = 0; k < 120; k++) {
          const ct = k * iv * (inflate ? 0.5 : 1);
          srv = Math.max(last, k * iv + rnd2() * jit); last = srv;
          ACC(e, ct, srv); NMA(e, srv);
          const now = e.cclk;
          if (FCA(e, 'smg', iv, now, {})) { CFC(e, 'smg', iv, now, {}); acc++; } else rej++;
        }
        return { rej, acc, span: last };
      };
      const honest = run(0.06, false), cheat = run(0, true);
      assert.equal(honest.rej, 0, `cadencia honesta con jitter 0–60 ms: ${honest.rej} rechazos`);
      const capCheat = Math.floor(cheat.span / (iv * 0.82)) + 1 + Math.ceil(0.3 / iv);
      assert.ok(cheat.acc <= capCheat, `ct inflado: ${cheat.acc} tiros (tope ${capCheat})`);
      note(`cadencia FPS sobre el reloj de simulación acotado: SMG honesta con jitter 0–60 ms 0/120 rechazos (antes, por llegadas, 1–3 por ráfaga en la matriz); ct al doble de ritmo → ${cheat.acc} tiros en ${cheat.span.toFixed(1)} s (tope horario + crédito de HEAD ${capCheat})`);
    }
    // aturdidora: no cruza el muro fino de la torre de Fortaleza (ya fallaba en
    // HEAD: pasos de ~0.3 m y el adelanto de 5.5 cm de mapLineBlocked)
    {
      const { CombatPrototypes } = await import('../src/combat/prototypes.js');
      const { mapPathBlocked, serverMapPhysics } = await import('../server/map-geometry.js');
      // La cara sur de la torre está en z=-5. Entrar dos milímetros
      // (o seguir dentro) bloquea incluso con pasos menores que ORIGIN_NUDGE.
      assert.ok(mapPathBlocked('fortaleza', [0,1,-5.002], [0,1,-4.998]));
      assert.ok(mapPathBlocked('fortaleza', [0,1,-4.998], [0,1,-4.996]));
      assert.ok(!mapPathBlocked('fortaleza', [0,1,-5], [0,1,-5.01]));
      const cross = (blockedFn) => {
        let crossed = 0;
        for (let k = 0; k < 40; k++) {
          const A = { id: 'A', team: 'red', alive: true, x: 0, y: 0, z: -9 }, B = { id: 'B', team: 'blue', alive: true, x: 0, y: 0, z: -1.5 };
          let hit = false;
          const P = new CombatPrototypes({ experimental: true, actors: () => [A, B], blocked: blockedFn,
            physics: { resolveCircle: (...q) => serverMapPhysics('fortaleza').resolveCircle(...q), groundHeight: (...q) => serverMapPhysics('fortaleza').groundHeight(...q) },
            event: (e) => { if (e.kind === 'stun') hit = true; }, inventory: () => {}, damage: () => {} });
          P.setRound('r', true); P.state('A').stunAmmo = 4;
          const z0 = -8.42 + k * 0.0075; // fases de paso distintas
          P.fire('A', 'stun', { x: -0.1, y: 1.51, z: z0 }, { x: 0, y: 0, z: 1 });
          for (let i = 0; i < 40; i++) P.tick(0.05 + ((k * 7 + i * 3) % 11) * 0.001); // ritmo del servidor (20 Hz, con jitter)
          if (hit) crossed++;
        }
        return crossed;
      };
      const old = cross((a, b) => mapLineBlocked('fortaleza', [a.x, a.y, a.z], [b.x, b.y, b.z], 0.015));
      const now = cross((a, b) => mapPathBlocked('fortaleza', [a.x, a.y, a.z], [b.x, b.y, b.z]));
      assert.equal(now, 0, `aturdidora cruza el muro en ${now}/40 fases`);
      // C5: un lanzamiento ASCENDENTE que empieza justo encima de una cobertura
      // baja (agachado pegado a ella, lanzando por encima) no se bloquea; con el
      // retraso del inicio de la ronda 2 sí se bloqueaba
      const ORIGIN_NUDGE = 0.055;
      const backoff = (a, b) => { const d = b.map((v, i) => v - a[i]), l = Math.hypot(...d), k = (ORIGIN_NUDGE + 0.005) / l;
        return mapLineBlocked('fortaleza', a.map((v, i) => v - d[i] * k), b, 0.015); };
      let lowCases = 0, oldBlocked = 0, nowBlocked = 0;
      for (let x = -22; x <= 22 && lowCases < 24; x += 0.5) for (let z = -22; z <= 22 && lowCases < 24; z += 0.5) {
        // tope por bisección DESDE ARRIBA (un rayo que empieza dentro no ve la caja)
        if (!mapLineBlocked('fortaleza', [x, 2.6, z], [x, 0.3, z], 0)) continue;
        let lo = 0.3, hi = 2.6; // lo: bajando hasta aquí choca; hi: no
        for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (mapLineBlocked('fortaleza', [x, 2.6, z], [x, m, z], 0)) lo = m; else hi = m; }
        // solo coberturas BAJAS (tope ~1.1 m) con el espacio de encima libre
        if (hi < 0.95 || hi > 1.25) continue;
        for (const [dx, dz] of [[0.3, 0.3], [-0.3, 0.3], [0, 0.42], [0, -0.42]]) {
          const a = [x, hi + 0.002, z], b = [x + dx, hi + 0.30, z + dz];
          if (mapLineBlocked('fortaleza', [b[0], 2.6, b[2]], [b[0], hi + 0.05, b[2]], 0)) continue; // algo alto al lado: no es "por encima de la cobertura"
          // otro obstáculo en el camino (borde, baranda): el mismo tramo 5 cm más alto también choca
          if (mapPathBlocked('fortaleza', [a[0], a[1] + 0.05, a[2]], [b[0], b[1] + 0.05, b[2]])) continue;
          lowCases++; if (backoff(a, b)) oldBlocked++; if (mapPathBlocked('fortaleza', a, b)) nowBlocked++;
        }
      }
      assert.ok(lowCases >= 6 && nowBlocked === 0, `C5: ${nowBlocked}/${lowCases} lanzamientos sobre cobertura baja bloqueados`);
      note(`C5 lanzamiento ascendente desde 2 mm sobre coberturas bajas (tope 0.95–1.25 m) de Fortaleza: bloqueado en ${oldBlocked}/${lowCases} con el inicio retrasado de la ronda 2; ahora 0/${lowCases} (penetración real, en los dos sentidos)`);
      note(`aturdidora vs muro fino de la torre (40 fases de paso): cruzaba en ${old}/40 con la regla de HEAD; ahora 0/40 (mismo muro que para el cohete)`);
    }
    // ---------- ronda 3 (puros) ----------
    {
      const G = await import('../server/guards.js');
      const iv = 60 / TUNING.weapons.smg.rpm;
      // C1: tres tiros SMG simultáneos en tiempo de servidor: HEAD admitía dos
      const e1 = {}; let ok3 = 0;
      for (let i = 0; i < 3; i++) if (G.srvBurstAllows(e1, 'smg', iv, 10)) { G.commitSrvBurst(e1, 'smg', 10); ok3++; }
      assert.equal(ok3, 2, `C1: ${ok3} tiros simultáneos admitidos (HEAD: 2)`);
      note('C1 ráfaga concentrada en tiempo de servidor = la de HEAD: de 3 tiros SMG simultáneos se admiten 2 (antes 3); el ritmo sostenido lo sigue fijando el horario sobre el reloj de simulación');
      // C4: entrada a slide con sprint de 70 ms pero a 4.8 m/s (no a 5.6) → sin presupuesto rápido
      const F4 = TUNING.fp;
      const seq4 = (parts) => {
        const e = { x: 0, y: 0, z: 0, fps: true }; G.resetMovementGuard(e, 0); let t = 0, good = true, ct = 0;
        for (const [stt, dur, v] of parts) for (let k = 0; k < Math.round(dur / 0.05); k++) {
          t += 0.05; ct += 0.05; const n = { x: e.x + v * 0.05, y: 0, z: 0, st: stt, ct }; if (G.acceptMovement(e, n, t)) e.x = n.x; else good = false;
        }
        return good;
      };
      assert.ok(!seq4([['run', 0.5, 4.8], ['roadie', 0.1, 4.8], ['slide', 0.7, 8]]), 'C4: slide desde un sprint lento (4.8 m/s) con presupuesto rápido');
      assert.ok(seq4([['run', 0.5, 4.8], ['roadie', 0.4, F4.sprintSpeed], ['slide', 0.7, 8]]), 'C4: slide honesto rechazado');
      note('C4 entrada a slide: sprint previo ≥ mínimo con 10 ms de tolerancia (antes 100 ms anulaban los 69/60 ms) y velocidad real de entrada ≥ 0.95·5.6 m/s medida del último tramo; desde 4.8 m/s, lento');
      // C7: pausa de pestaña de 400 ms a mitad de slide (ct se detiene, el servidor sigue)
      {
        const e = { x: 0, y: 0, z: 0, fps: true }; G.resetMovementGuard(e, 0); let t = 0, ct = 0, bad = 0;
        const step = (stt, v, dt, dct = dt) => { t += dt; ct += dct; G.advanceCadenceClock(e, ct, t); const n = { x: e.x + v * dct, y: 0, z: 0, st: stt, ct }; if (G.acceptMovement(e, n, t)) e.x = n.x; else bad++; };
        for (let i = 0; i < 8; i++) step('roadie', F4.sprintSpeed, 0.05);
        for (let i = 0; i < 3; i++) step('slide', 8, 0.05);
        step('slide', 8, 0.4, 0.05); // 400 ms sin mensajes; el cliente solo avanzó un cuadro
        for (let i = 0; i < 4; i++) step('slide', 7, 0.05);
        assert.equal(bad, 0, `C7: ${bad} estados rechazados tras una pausa de 400 ms en slide`);
        note('C7 pausa de 400 ms a mitad de slide: 0 estados rechazados (ventanas de slide/placaje en el reloj de simulación acotado; la primera muestra tras ≥ 0.25 s re-basa la postura; sin crédito extra de velocidad)');
      }
      // C3: golpe — un solo criterio, el de HEAD: centro del blanco en 58° de la mirada
      const { meleeHitOk, meleeReachOk, meleeTargetPoint } = await import('../src/combat/melee-reach.js');
      const eyeM3 = [0, 1.6, 0];
      const at = (deg) => [Math.sin(-deg * Math.PI / 180) * -1.2, 0.9, -Math.cos(deg * Math.PI / 180) * 1.2];
      const c60 = at(60), c50 = at(50);
      const vol60 = placeHitPose(hitPose({ st: 'idle' }), c60[0], 0, c60[2], 0), vol50 = placeHitPose(hitPose({ st: 'idle' }), c50[0], 0, c50[2], 0);
      const p60 = meleeTargetPoint(eyeM3, vol60).point, p50 = meleeTargetPoint(eyeM3, vol50).point;
      assert.ok(!meleeHitOk(eyeM3, 0, p60, c60) && meleeHitOk(eyeM3, 0, p50, c50), 'C3: golpe a 60° (fuera de los 58° de HEAD) aceptado o a 50° rechazado');
      const angle = 55 * Math.PI / 180;
      const centre = [1.1 * Math.sin(angle), 0.9, -1.1 * Math.cos(angle)];
      const leaned = placeHitPose(hitPose({st:'idle', aim:true, cl:-1, ce:1, wep:'smg'}), centre[0], 0, centre[2], 2);
      assert.ok(!meleeReachOk(eyeM3, 0, meleeTargetPoint(eyeM3, leaned).point));
      const contact = meleeTargetPoint(eyeM3, leaned, 0);
      assert.ok(contact && meleeReachOk(eyeM3, 0, contact.point) && meleeHitOk(eyeM3, 0, contact.point, centre));
      note('C3 golpe: un criterio compartido (centro del blanco en 58° del yaw de MIRADA, contacto al alcance desde el ojo) en cliente y servidor; 62° sobre el contacto era más laxo que HEAD: deshecho');
    }
    note('R7 MOVE_GATES: slide renovado a 0.8 s (ciclo 1.1 s) sin presupuesto rápido; tras el ciclo, sí; placaje desde un slide no legal, lento');
  }
  note(`1a ${shots} tiros honestos (60 y 30 FPS · 6 perfiles: mezclas sprint/slide, agacharse/asomo, lean, 50 rad de giro, salto · jitter 0/±30 ms · RTT 20/120/250 ms, subpasos 120 Hz): 0 rechazados; ojo del servidor a ≤ ${(worst * 1000).toFixed(1)} mm del origen (tope ${FPS_EYE_TOL * 1000} mm)`);
  // desplazados respecto del ojo de la muestra: siempre rechazados
  const still = [{ at: 1, x: 0, y: 0, z: 0, yaw: 0, st: 'idle', aim: 1, ce: 1, cl: 0, p: 0, ae: 0, w: 'smg' }];
  const e0 = eyeWorld(shotPose(still), 0, 0, 0, 0);
  for (let i = 0; i < 2000; i++) {
    const th = Math.acos(1 - 2 * rand()), ph = rand() * Math.PI * 2, r = FPS_EYE_TOL + 0.005 + rand() * 0.5;
    const o = [e0[0] + r * Math.sin(th) * Math.cos(ph), e0[1] + r * Math.cos(th), e0[2] + r * Math.sin(th) * Math.sin(ph)];
    assert.ok(Math.hypot(...o.map((v, k) => v - e0[k])) > FPS_EYE_TOL, 'origen desplazado aceptado');
  }
  note(`1b el origen solo vale a ≤ ${FPS_EYE_TOL} m del ojo de SU muestra (antes 0.40 m de cualquier tramo de cabeza de 100 ms)`);
  // guarda de postura: un cliente que intenta subir la cabeza de golpe
  const ent = { fps: true }; let t = 0;
  for (let i = 0; i < 10; i++) acceptPosture(ent, { st: 'crouch', ce: 0, cl: 0 }, (t += 0.05));
  const up = acceptPosture(ent, { st: 'idle', ce: 1, cl: 1 }, (t += 0.05));
  assert.ok(up.st === 'crouch' && up.ce <= 0.51 && up.cl <= 0.51, `cabeza teletransportada: ${JSON.stringify(up)}`);
  for (let i = 0; i < 10; i++) acceptPosture(ent, { st: 'crouch', ce: 0, cl: 0 }, (t += 0.05));
  // crouch → roadie de golpe: el estado se acepta, pero la cabeza que el
  // servidor usa para SUS disparos y su volumen sale de la mezcla desde la
  // muestra agachada (no salta)
  {
    const mk = (at, st, ce) => ({ at, x: 0, y: 0, z: 0, yaw: 0, st, aim: 0, ce, cl: 0, p: 0, ae: 0, w: 'smg' });
    const hist = [mk(1, 'crouch', 0), mk(1.05, 'crouch', 0), mk(1.1, 'roadie', 1)];
    const h0 = hitPose(shotPose(hist.slice(0, 2))).h, h1 = hitPose(shotPose(hist, 0)).h, h2 = hitPose(shotPose([...hist, mk(1.15, 'roadie', 1)], 0.05)).h;
    const d1 = Math.hypot(...h1.map((v, i) => v - h0[i])), d2 = Math.hypot(...h2.map((v, i) => v - h1[i]));
    assert.ok(d1 < 1e-6 && d2 < 0.35, `crouch→roadie: la cabeza salta ${d1.toFixed(3)} / ${d2.toFixed(3)} m`);
  }
  // inclinado al salir de una postura inclinable: `cl` baja a su ritmo
  const lean = { fps: true }; let tl = 0;
  for (let i = 0; i < 6; i++) acceptPosture(lean, { st: 'idle', ce: 1, cl: 1 }, (tl += 0.05));
  const sl = acceptPosture(lean, { st: 'slide', ce: 1, cl: 1 }, (tl += 0.05));
  assert.ok(sl.cl < 1 && sl.cl >= 0.49, `cl fuera de postura inclinable: ${sl.cl}`);
  note(`1c guarda de postura: agachado→de pie+inclinado en un mensaje queda en ce ${up.ce.toFixed(2)}, cl ${up.cl.toFixed(2)}; al deslizar inclinado, cl baja a ${sl.cl.toFixed(2)} (no se copia)`);
  // presupuesto de velocidad por postura (tuning.fp): sostenido 3 s
  const mv = (speed, st, fps = true, secs = 3) => {
    const e = { x: 0, y: 0, z: 0, fps }; resetMovementGuard(e, 0); let ok = 0, n = Math.round(secs / 0.05);
    for (let i = 1; i <= n; i++) { const p = { x: speed * i * 0.05, y: 0, z: 0, st }; if (acceptMovement(e, p, i * 0.05)) { e.x = p.x; ok++; } }
    return ok === n;
  };
  const rows = [];
  for (const [st, honest, cheat] of [['crouch', F.crouchSpeed, 3.2], ['run', F.runSpeed, 6.5], ['roadie', F.sprintSpeed, 9]]) {
    assert.ok(mv(honest, st), `${st}: ${honest} m/s honesto rechazado`);
    assert.ok(!mv(cheat, st), `${st}: ${cheat} m/s aceptado`);
    rows.push(`${st} ${honest} ok / ${cheat} no`);
  }
  {
    // slide (entrada legal: desde sprint): 8 m/s solo ~0.5 s
    const slideRun = (secs) => {
      const e = { x: 0, y: 0, z: 0, fps: true }; resetMovementGuard(e, 0); let t = 0, ok = true;
      for (const [st, dur, v] of [['roadie', 0.6, F.sprintSpeed], ['slide', secs, F.slideMaxSpeed]]) for (let k = 0; k < Math.round(dur / 0.05); k++) {
        t += 0.05; const n = { x: e.x + v * 0.05, y: 0, z: 0, st }; if (acceptMovement(e, n, t)) e.x = n.x; else ok = false;
      }
      return ok;
    };
    assert.ok(slideRun(F.slideTime) && !slideRun(2), 'slide: 8 m/s debe valer solo ~0.5 s');
  }
  assert.ok(mv(13.5, 'idle', false), 'bots: el tope anterior (16.5) cambió');
  note(`1d velocidad por postura (3 s sostenidos): ${rows.join(' · ')} · slide 8 m/s solo ${F.slideTime} s (+0.2) · crédito ${'≈'}0.35 s de su velocidad (antes 7 m) · bots sin cambio`);
}

// Para verificar el origen en entornos sin sockets se puede ejecutar solo
// la simulación anterior, con las mismas guardas de producción.
if (process.argv.includes('--pure')) {
  console.log('ORIGEN FPS OK · sección Node sin servidor');
  process.exit(0);
}

// ---------- 2. servidor real ----------
const port = await freePort();
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1', BREACH_LOG_FIRE_REJECTS: process.env.DEBUG ? '1' : '' }, stdio: process.env.DEBUG ? ['ignore', 'inherit', 'ignore'] : 'ignore',
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(join) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = { ws, messages: [], waiters: [], closed: false };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', ...join })));
    ws.on('error', reject);
    ws.on('close', () => { peer.closed = true; resolve(peer); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw); peer.messages.push(msg);
      if (msg.t === 'welcome' || msg.t === 'lobbyError') resolve(peer);
      for (const w of [...peer.waiters]) if (w.pred(msg)) { peer.waiters.splice(peer.waiters.indexOf(w), 1); w.resolve(msg); }
    });
  });
}
const waitFor = (peer, pred, timeout = 1200) => new Promise((resolve) => {
  const w = { pred, resolve }; peer.waiters.push(w);
  setTimeout(() => { const i = peer.waiters.indexOf(w); if (i >= 0) { peer.waiters.splice(i, 1); resolve(null); } }, timeout);
});
const send = withSamples((p, m) => p.ws.send(JSON.stringify(m)));
const peers = [];
let oldServer, oldDir;
try {
  await waitHttp(`http://127.0.0.1:${port}/status`);
  // cliente anterior (sin fps): rechazado por lobbyError antes del welcome
  const old = await connect({ action: 'create', name: 'OLD', v: 0, hp: 2 });
  const err = old.messages.find((m) => m.t === 'lobbyError');
  assert.ok(err && err.code === 'reload-page' && !old.messages.some((m) => m.t === 'welcome'), 'cliente sin fps no rechazado con reload-page');
  await delay(100);
  assert.ok(old.closed, 'el servidor no cerró al cliente anterior');
  const a = await connect({ action: 'create', name: 'FPS-A', v: 0, hp: 2, fps: 1 }); peers.push(a);
  const welcome = a.messages.find((m) => m.t === 'welcome');
  assert.equal(welcome?.fps, 1, 'welcome sin fps:1');
  const b = await connect({ action: 'join', name: 'FPS-B', v: 0, hp: 2, fps: 1 }); peers.push(b);
  note(`2a versiones: cliente sin fps → lobbyError '${err.code}' + cierre (1008); cliente fps → welcome fps:1`);
  send(a, { t: 'lobbyStart' });
  await waitFor(a, (m) => m.t === 'matchStart');
  await delay(300);
  const aid = welcome.id, bid = b.messages.find((m) => m.t === 'welcome').id;
  const bx = 3, bz = -2, az = bz - 6;
  const st = (p, extra) => send(p, { t: 's', x: bx, z: az, y: 0, yaw: Math.PI, st: 'idle', aim: 1, p: 0, ae: 0, cl: 0, ce: 1, w: 'smg', am: 50, ar: 150, sp: 0, ...extra });
  st(b, { z: bz, yaw: 0, aim: 0 }); st(a); await delay(150);
  const eyeA = eyeWorld({ st: 'idle', aim: true, wep: 'smg' }, bx, 0, az, Math.PI).map(r2);
  const echo = (o, sq, p = [bx, 30, az + 8]) => { const w = waitFor(b, (m) => m.t === 'fire' && m.id === aid, 500); send(a, { t: 'fire', w: 'smg', o, p, d: [], sq }); return w.then((m) => !!m); };
  let sq = 0;
  const gap = () => delay(140);
  assert.ok(await echo(eyeA, ++sq), 'disparo desde el ojo rechazado'); await gap();
  assert.ok(!(await echo([bx, 1.1, az], ++sq)), 'disparo desde 1.1 (altura antigua) aceptado'); await gap();
  assert.ok(!(await echo([bx, 1.6, az - 2.2], ++sq)), 'disparo desde la cámara de hombro aceptado'); await gap();
  assert.ok(!(await echo(eyeA.map((v, i) => (i === 0 ? v + 0.45 : v)), ++sq)), 'origen 0.45 m al lado aceptado'); await gap();
  // agachado: crouch difundido con ce; su ojo agachado vale, el de pie no
  for (let i = 0; i < 8; i++) { st(a, { st: 'crouch', ce: 0, aim: 0 }); await delay(50); }
  const snap = await waitFor(b, (m) => m.t === 'snap' && m.ps.find((p) => p.id === aid)?.st === 'crouch');
  const me = snap?.ps.find((p) => p.id === aid);
  assert.ok(me && me.ce === 0, `crouch no difundido con ce: ${JSON.stringify(me)}`);
  const eyeC = eyeWorld({ st: 'crouch', ce: 0 }, bx, 0, az, Math.PI).map(r2);
  assert.ok(await echo(eyeC, ++sq), 'agachado: disparo desde su ojo rechazado'); await gap();
  assert.ok(!(await echo(eyeA, ++sq)), 'agachado: disparo desde la altura de pie aceptado'); await gap();
  // subir de golpe: el servidor difunde la cabeza subiendo a su ritmo
  st(a, { st: 'idle', ce: 1, aim: 1 });
  const s2 = await waitFor(b, (m) => m.t === 'snap');
  const me2 = s2?.ps.find((p) => p.id === aid);
  assert.ok(me2 && me2.st === 'crouch' && me2.ce < 1, `subida de golpe no recortada: ${JSON.stringify(me2)}`);
  note(`2b origen: ojo de pie y agachado aceptados; 1.1 m, cámara de hombro, +0.45 m de lado y ojo de pie estando agachado rechazados; levantarse de golpe se difunde como crouch ce ${me2.ce}`);
  for (let i = 0; i < 6; i++) { st(a); await delay(50); }
  // estado retirado de un cliente FPS: cover_low → crouch
  for (let i = 0; i < 6; i++) { st(a, { st: 'cover_low', ce: 0, aim: 0 }); await delay(50); }
  const s3 = await waitFor(b, (m) => m.t === 'snap');
  assert.equal(s3?.ps.find((p) => p.id === aid)?.st, 'crouch', 'cover_low de un cliente FPS no traducido');
  for (let i = 0; i < 6; i++) { st(a); await delay(50); }
  // 2c esquina: origen alrededor de un borde (casco oculto) y ojo a través de
  // una pared. Se busca en fortaleza un punto pegado a un muro (cabeza libre)
  // donde el ojo de la pose, girado hacia el muro, queda al otro lado.
  const free = (x, z) => !mapLineBlocked('fortaleza', [x, 0.4, z], [x, 1.75, z], 0);
  const findSpot = (pose) => {
  let spot = null;
  for (let x = -20; x <= 20 && !spot; x += 0.25) for (let z = -20; z <= 20 && !spot; z += 0.25) {
    if (!free(x, z)) continue;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const h = placeHitPose(hitPose(pose), x, 0, z, yaw), head = [h.hx, h.hy, h.hz], eye = eyeWorld(pose, x, 0, z, yaw);
      if (mapLineBlocked('fortaleza', head, eye, 0) || mapLineBlocked('fortaleza', eye, head, 0)) {
        // control: el mismo punto mirando al otro lado, ojo libre
        const yaw2 = yaw + Math.PI, eye2 = eyeWorld(pose, x, 0, z, yaw2), h2 = placeHitPose(hitPose(pose), x, 0, z, yaw2);
        const hd2 = [h2.hx, h2.hy, h2.hz], fwd = [eye2[0] - 0.6 * Math.sin(yaw2), eye2[1] - 0.2, eye2[2] - 0.6 * Math.cos(yaw2)];
        const both = (p, q) => !mapLineBlocked('fortaleza', p, q, 0) && !mapLineBlocked('fortaleza', q, p, 0);
        if (both(hd2, eye2) && both(eye2, fwd) && !mapLineBlocked('fortaleza', eye2, [x, 30, z], 0)) { spot = { x, z, yaw, eye, yaw2, eye2 }; break; }
      }
    }
  }
  return spot;
  };
  const spot = findSpot({ st: 'idle', aim: true, wep: 'smg' });
  if (spot) {
    const at = (yaw) => { for (let i = 0; i < 4; i++) st(a, { x: spot.x, z: spot.z, yaw }); };
    at(spot.yaw2); await delay(150);
    assert.ok(await echo(spot.eye2.map((v) => +v.toFixed(3)), ++sq, [spot.x, 30, spot.z]), 'control: ojo libre rechazado'); await gap();
    at(spot.yaw); await delay(150);
    assert.ok(!(await echo(spot.eye.map((v) => +v.toFixed(3)), ++sq, [spot.x, 30, spot.z])), 'ojo al otro lado de la pared aceptado'); await gap();
    // alrededor del borde: origen 0.3 m de lado (asomando el arma, casco tras el muro)
    at(spot.yaw2); await delay(150);
    const side = [spot.eye2[0] + 0.3 * Math.cos(spot.yaw2), spot.eye2[1], spot.eye2[2] - 0.3 * Math.sin(spot.yaw2)].map((v) => +v.toFixed(3));
    assert.ok(!(await echo(side, ++sq, [spot.x, 30, spot.z])), 'origen 0.3 m fuera del ojo aceptado'); await gap();
    note(`2c pared en (${spot.x}, ${spot.z}): ojo atravesando la pared rechazado; origen a 0.30 m del ojo (antes cabía en 0.40) rechazado; mismo punto mirando al otro lado, aceptado`);
  } else assert.fail('sin punto de pared en fortaleza');
  // 2d yaw acumulado: 50.3 rad (8 vueltas) → mismo ojo que 50.3 mod 2π
  {
    const yawAcc = 50.3, wrapped = srvWrap(yawAcc);
    st(a, { yaw: yawAcc, aim: 1 }); await delay(120);
    const eyeW = eyeWorld({ st: 'idle', aim: true, wep: 'smg' }, bx, 0, az, wrapped).map((v) => +v.toFixed(3));
    assert.ok(await echo(eyeW, ++sq), 'yaw acumulado: disparo honesto rechazado'); await gap();
    note(`2d yaw de 50.3 rad (antes saturado en 10 → la cabeza del servidor a ${(Math.hypot(...['f','s'].map((_, i) => eyeWorld({ st: 'crouch', aim: true, cl: 1, wep: 'smg' }, 0, 0, 0, 10)[i * 2] - eyeWorld({ st: 'crouch', aim: true, cl: 1, wep: 'smg' }, 0, 0, 0, wrapped)[i * 2])) ).toFixed(2)} m del ojo agachado ADS inclinado): aceptado`);
  }
  // 2e puertas por estado y retraso sprint→disparo (fire-gates.js)
  {
    st(a, { st: 'roadie', aim: 0 }); await delay(60);
    assert.ok(!(await echo(eyeWorld({ st: 'roadie' }, bx, 0, az, Math.PI).map((v) => +v.toFixed(3)), ++sq)), 'disparo en sprint aceptado'); await gap();
    st(a, { st: 'roadie', aim: 0 }); await delay(30); st(a, { aim: 0 });
    const e1 = eyeWorld({ st: 'idle', from: { st: 'roadie' }, fromTo: { st: 'idle' }, since: 0.01 }, bx, 0, az, Math.PI);
    send(a, { t: 'fire', w: 'smg', o: e1.map((v) => +v.toFixed(3)), p: [bx, 30, az + 8], d: [], sq: ++sq,
      fs: { x: bx, y: 0, z: az, yaw: Math.PI, st: 'idle', aim: 0, ce: 1, cl: 0, p: 0, ae: 0, ts: 0.01, w: 'smg', n: nextN() } });
    const tooSoon = await waitFor(b, (m) => m.t === 'fire' && m.id === aid, 400);
    assert.ok(!tooSoon, 'disparo 10 ms después del sprint aceptado');
    await delay(400); for (let i = 0; i < 3; i++) { st(a); await delay(40); }
    assert.ok(await echo(eyeA, ++sq), 'disparo pasado el retraso del sprint rechazado'); await gap();
    for (let i = 0; i < 3; i++) { st(a, { st: 'mantle', aim: 0 }); await delay(30); }
    assert.ok(!(await echo(eyeA, ++sq)), 'disparo trepando aceptado'); await gap();
    for (let i = 0; i < 6; i++) { st(a); await delay(50); }
    note('2e en sprint y trepando: rechazado; 10 ms tras el sprint: rechazado; pasado el retraso del arma: aceptado (tabla compartida fire-gates.js)');
  }
  // 2f humo: salida a través de la pared rechazada, delante del ojo aceptada
  {
    // lanzar exige la granada EQUIPADA; sin apuntar
    const spot = findSpot({ st: 'idle', aim: false, wep: 'grenade' });
    const at = (yaw) => { for (let i = 0; i < 4; i++) st(a, { x: spot.x, z: spot.z, yaw, aim: 0, w: 'grenade' }); };
    const nade = (o, cid) => { const w = waitFor(a, (m) => (m.t === 'nadeAck' || m.t === 'nadeReject') && m.cid === cid, 600); send(a, { t: 'nade', cid, o, v: [0, 3, -3] }); return w; };
    at(spot.yaw); await delay(200);
    const beyond = [spot.eye[0] - 0.6 * Math.sin(spot.yaw), spot.eye[1], spot.eye[2] - 0.6 * Math.cos(spot.yaw)].map((v) => +v.toFixed(3));
    const r1 = await nade(beyond, 'wall');
    assert.equal(r1?.t, 'nadeReject', `humo a través de la pared: ${r1?.t}`);
    at(spot.yaw2); await delay(1300);
    // salida del viewmodel: ojo + (0.10, −0.09, −0.50) en el marco de la cámara
    const launchAt = (eye, yaw) => [eye[0] + 0.1 * Math.cos(yaw) - 0.5 * Math.sin(yaw), eye[1] - 0.09, eye[2] - 0.1 * Math.sin(yaw) - 0.5 * Math.cos(yaw)].map((v) => +v.toFixed(3));
    const ahead = launchAt(spot.eye2, spot.yaw2);
    const along = [spot.eye2[0] - 0.5 * Math.sin(spot.yaw2), spot.eye2[1] - 0.2, spot.eye2[2] - 0.5 * Math.cos(spot.yaw2)].map((v) => +v.toFixed(3));
    if (process.env.DEBUG) { const pz = { st: 'idle', aim: false, wep: 'grenade' }; const hh = placeHitPose(hitPose(pz), spot.x, 0, spot.z, spot.yaw2);
      console.log('NADE', spot, ahead, mapLineBlocked('fortaleza', spot.eye2, ahead, 0), mapLineBlocked('fortaleza', ahead, spot.eye2, 0), mapLineBlocked('fortaleza', [hh.hx, hh.hy, hh.hz], spot.eye2, 0)); }
    const r0 = await nade(along, 'off');
    assert.ok(r0?.t === 'nadeReject' && r0.kind === 'grenade' && r0.reason === 'origin', `salida fuera del tramo del viewmodel: ${JSON.stringify(r0)}`);
    await delay(1300);
    const r2 = await nade(ahead, 'ok');
    assert.equal(r2?.t, 'nadeAck', `humo honesto: ${r2?.t}`);
    note(`2f humo humano: tras la pared → nadeReject {kind:'${r1.kind}', reason:'${r1.reason}'}; 0.5 m por el eje y 0.2 abajo (0.13 m fuera de la salida del viewmodel, antes cabía en 0.78 m) → nadeReject 'origin'; salida del viewmodel → aceptada`);
  }
  // 2g modelo de impacto: fps sin hp 2 → rechazado
  {
    const m1 = await connect({ action: 'join', name: 'HP1', v: 0, fps: 1 });
    assert.ok(m1.messages.some((m) => m.t === 'lobbyError' && m.code === 'reload-page'), 'fps con modelo 1 admitido');
    note('2g fps sin hp:2 → lobbyError reload-page (el modelo 1 leía crouch como de pie)');
  }

  // ---------- 4. auditoría final ----------
  for (let i = 0; i < 6; i++) { st(a, { w: 'smg' }); st(b, { z: bz, yaw: 0, aim: 0 }); await delay(50); }
  // 4a escopeta: eje central + cono del peor caso del estado (+2°)
  {
    const SGW = TUNING.weapons.shotgun;
    for (let i = 0; i < 6; i++) { st(a, { w: 'shotgun', aim: 0 }); await delay(60); }
    await delay(700);
    const eyeJ = eyeWorld({ st: 'jump', aim: false, wep: 'shotgun', sp: 0.6 }, bx, 0, az, Math.PI).map((v) => +v.toFixed(3));
    const shotAt = async (deg, label) => {
      const hp0 = (await waitFor(b, (m) => m.t === 'snap'))?.ps.find((p) => p.id === bid)?.hp;
      // tirador en el aire (jump) corriendo: el peor caso de la escopeta
      const fs = { x: bx, y: 0, z: az, yaw: Math.PI, st: 'jump', aim: 0, ce: 1, cl: 0, p: 0, sp: 0.6, ae: 0, w: 'shotgun', n: nextN() };
      const axis = [0, 0, 1], p = [bx, eyeJ[1], az + 20];
      // perdigón a `deg` del eje, hacia el torso de B (lateral)
      // ángulo total `deg` respecto del eje (horizontal, a la altura del ojo):
      // componente vertical hasta el pecho alto (1.3) y el resto lateral
      const dzz = bz - eyeJ[2], vert = Math.atan2(eyeJ[1] - 1.3, dzz);
      const lat = Math.acos(Math.cos(deg * Math.PI / 180) / Math.cos(vert));
      const r = -Math.tan(lat) * dzz; // a la izquierda: carril libre en fortaleza
      const claim = [bx + r, 1.3, bz];
      send(b, { t: 's', x: bx + r, z: bz, y: 0, yaw: 0, st: 'idle', aim: 0, w: 'smg', am: 50, ar: 150 });
      await delay(200);
      const fe = waitFor(b, (m) => m.t === 'fire' && m.id === aid, 500);
      send(a, { t: 'fire', w: 'shotgun', o: eyeJ, p, d: [], sq: ++sq, fs });
      if (process.env.DEBUG) fe.then((m) => console.log('SG fire', label, !!m, JSON.stringify(fs), eyeJ));
      send(a, { t: 'hit', target: bid, dmg: 10, part: 'body', gib: 0, pellets: 1, p: claim, sq });
      const s2 = await waitFor(b, (m) => m.t === 'snap' && (m.ps.find((q) => q.id === bid)?.hp ?? 100) < hp0, 600);
      await delay(Math.ceil(60 / SGW.rpm * 1000) + 100);
      return !!s2;
    };
    const worst = spreadForW('shotgun', { aim: false, moving: 1, airborne: true });
    const inCone = await shotAt(worst - 1, 'extremo');
    const outCone = await shotAt(worst + 3.5, 'fuera');
    assert.ok(inCone && !outCone, `escopeta: perdigón extremo ${inCone ? 'cuenta' : 'NO cuenta'}, fuera del cono ${outCone ? 'cuenta' : 'no cuenta'}`);
    note(`4a escopeta en el aire corriendo: peor caso ${worst.toFixed(1)}° (antes medía hasta 32.8° entre extremos y exigía 20° al último perdigón): perdigón a ${(worst - 1).toFixed(1)}° del eje hace daño; a ${(worst + 3.5).toFixed(1)}° no`);
    for (let i = 0; i < 4; i++) { st(a, { w: 'smg' }); st(b, { z: bz, yaw: 0, aim: 0 }); await delay(60); }
    await delay(700);
  }
  // 4b golpe: el origen es el ojo de la muestra (antes ~4 m de margen)
  {
    const fs = { x: bx, y: 0, z: az, yaw: Math.PI, st: 'idle', aim: 0, ce: 1, cl: 0, p: 0, sp: 0, ae: 0, w: 'smg', n: nextN() };
    const eyeM = eyeWorld({ st: 'idle', wep: 'smg' }, bx, 0, az, Math.PI).map((v) => +v.toFixed(3));
    const melee = async (o) => { const w = waitFor(b, (m) => m.t === 'fire' && m.id === aid && m.w === 'melee', 500); send(a, { t: 'fire', w: 'melee', o, p: [bx, 1.2, az + 1.5], d: [], sq: ++sq, fs: { ...fs, n: nextN() } }); const r = !!(await w); await delay(450); return r; };
    const far = await melee([eyeM[0], eyeM[1], eyeM[2] + 1.0]);
    const ok = await melee(eyeM);
    assert.ok(ok && !far, `golpe: desde el ojo ${ok}, desde 1 m delante ${far}`);
    note('4b golpe FPS: origen 1 m delante del ojo (antes cabía en ~4 m) rechazado; desde el ojo de la muestra aceptado; pared barrida desde ese ojo');
  }
  // 4c eventos de acción: una vez en el snapshot
  {
    send(a, { t: 's', x: bx, z: az, y: 0, yaw: Math.PI, st: 'idle', aim: 0, p: 0, ae: 0, cl: 0, ce: 1, w: 'smg', am: 50, ar: 150, sp: 0, n: nextN(), ev: [['swapStart', 'shotgun'], ['bogus', 'x'], ['reloadCancel', 'smg']] });
    const got = []; const h = (raw) => { const m = JSON.parse(raw); const me = m.t === 'snap' && m.ps.find((p) => p.id === aid); if (me?.ev) got.push(...me.ev); };
    b.ws.on('message', h); await delay(400); b.ws.off('message', h);
    assert.deepEqual(got, [['swapStart', 'shotgun'], ['reloadCancel', 'smg']], `eventos: ${JSON.stringify(got)}`);
    note('4c eventos (swapStart, reloadCancel) llegan una sola vez en el snapshot; el tipo no válido se descarta');
  }
  // 4d muestra fuera de orden (n no posterior): disparo rechazado
  {
    const eyeA2 = eyeWorld({ st: 'idle', aim: true, wep: 'smg' }, bx, 0, az, Math.PI).map((v) => +v.toFixed(3));
    const nStale = nextN(); for (let i = 0; i < 3; i++) { st(a, { n: nextN() }); await delay(60); }
    const w = waitFor(b, (m) => m.t === 'fire' && m.id === aid, 500);
    send(a, { t: 'fire', w: 'smg', o: eyeA2, p: [bx, 30, az + 8], d: [], sq: ++sq,
      fs: { x: bx, y: 0, z: az, yaw: Math.PI, st: 'idle', aim: 1, ce: 1, cl: 0, p: 0, sp: 0, ae: 0, w: 'smg', n: nStale } });
    assert.ok(!(await w), 'muestra con n repetido aceptada');
    await delay(150);
    note('4d muestra con `n` no posterior al último estado: disparo rechazado (el estado vivo nunca retrocede)');
  }
  // ---------- ronda 2 (servidor real) ----------
  {
    const raw = (m) => a.ws.send(JSON.stringify(m));
    const eyeA3 = eyeWorld({ st: 'idle', aim: true, wep: 'smg' }, bx, 0, az, Math.PI).map((v) => +v.toFixed(3));
    for (let i = 0; i < 4; i++) { st(a, { w: 'smg' }); await delay(50); }
    await delay(200);
    const fireRaw = async (m) => { const w = waitFor(b, (x) => x.t === 'fire' && x.id === aid, 450); raw({ t: 'fire', w: 'smg', o: eyeA3, p: [bx, eyeA3[1], az + 30], d: [], sq: ++sq, ...m }); const r = !!(await w); await delay(140); return r; };
    const base = { x: bx, y: 0, z: az, yaw: Math.PI, st: 'idle', aim: 1, ce: 1, cl: 0, p: 0, sp: 0, ae: 0 };
    const noFs = await fireRaw({});
    const noN = await fireRaw({ fs: { ...base, w: 'smg' } });
    const subst = await fireRaw({ w: 'shotgun', fs: { ...base, w: 'shotgun', n: nextN() } }); // R14: el arma de la muestra no está equipada
    const good = await fireRaw({ fs: { ...base, w: 'smg', n: nextN() } });
    assert.ok(!noFs && !noN && !subst && good, `R2/R14: sin fs ${noFs}, sin n ${noN}, arma sustituida ${subst}, válido ${good}`);
    note('R2/R14 sin `fs`, sin `n` o con un arma que no estaba equipada (aunque se posea): rechazado; muestra válida: aceptado');
    const counters = async () => (await fetch(`http://127.0.0.1:${port}/test/refusals`)).json();
    const prevRefusals = await counters();
    raw({t:'hit',target:'missing',sq});
    await waitFor(a, m => m.t === 'snap');
    assert.equal((await counters())['hit-inactive'], (prevRefusals['hit-inactive'] || 0) + 1);
    // R4: una bala — dirección efectiva dentro del cono de su arma; fuera, no
    const offAxis = (deg) => [bx + Math.sin(deg * Math.PI / 180) * 30, eyeA3[1], az + Math.cos(deg * Math.PI / 180) * 30];
    const smgW = spreadForW('smg', { aim: true, moving: 0.2 });
    const inB = await fireRaw({ p: offAxis(smgW), fs: { ...base, w: 'smg', n: nextN() } });
    const outB = await fireRaw({ p: offAxis(smgW + 6), fs: { ...base, w: 'smg', n: nextN() } });
    assert.ok(inB && !outB, `R4: bala a ${smgW.toFixed(1)}° ${inB}, a ${(smgW + 6).toFixed(1)}° ${outB}`);
    note(`R4 una bala: dirección efectiva a ${smgW.toFixed(1)}° del eje (dispersión ADS) aceptada — el sniper sin mira conserva su crédito de cabeza por su punto real —; a ${(smgW + 6).toFixed(1)}° rechazada`);
    // R3: escopeta saltando desde agachado (st crouch + air)
    for (let i = 0; i < 16; i++) { st(a, { w: 'shotgun', aim: 0, st: 'crouch', ce: 0 }); await delay(60); }
    const eyeC = eyeWorld({ st: 'crouch', ce: 0, aim: false, wep: 'shotgun' }, bx, 0.5, az, Math.PI).map((v) => +v.toFixed(3));
    const air = spreadForW('shotgun', { aim: false, moving: 0.2, airborne: true });
    const deg = 12.16;
    const dzz = bz - eyeC[2], vert = Math.atan2(eyeC[1] - 1.3, dzz), lat = Math.acos(Math.cos(deg * Math.PI / 180) / Math.cos(vert)), r = -Math.tan(lat) * dzz;
    send(b, { t: 's', x: bx + r, z: bz, y: 0, yaw: 0, st: 'idle', aim: 0, w: 'smg', am: 50, ar: 150 }); await delay(200);
    const hp0 = (await waitFor(b, (m) => m.t === 'snap'))?.ps.find((q) => q.id === bid)?.hp;
    raw({ t: 'fire', w: 'shotgun', o: eyeC, p: [bx, eyeC[1], az + 20], d: [], sq: ++sq, fs: { x: bx, y: 0.5, z: az, yaw: Math.PI, st: 'crouch', aim: 0, ce: 0, cl: 0, p: 0, sp: 0, ae: 0, air: 1, w: 'shotgun', n: nextN() } });
    raw({ t: 'hit', target: bid, dmg: 10, part: 'body', gib: 0, pellets: 1, p: [bx + r, 1.3, bz], sq });
    const hit3 = await waitFor(b, (m) => m.t === 'snap' && (m.ps.find((q) => q.id === bid)?.hp ?? 100) < hp0, 600);
    assert.ok(hit3, `R3: perdigón a ${deg}° saltando desde agachado sin daño (cono ${(air + 2).toFixed(1)}°)`);
    note(`R3 escopeta saltando desde agachado (st crouch + air): perdigón a ${deg}° acreditado (cono del aire ${(air + 2).toFixed(1)}°; antes 8.85°)`);
    for (let i = 0; i < 4; i++) { st(a, { w: 'smg' }); st(b, { z: bz, yaw: 0, aim: 0 }); await delay(60); }
    await delay(700);
    // R8: rechazo de lanzamiento identificable, una vez por cid, con el motivo real
    const rejects = []; const hr = (rw) => { const m = JSON.parse(rw); if (m.t === 'nadeReject') rejects.push(m); }; a.ws.on('message', hr);
    for (let i = 0; i < 2; i++) { send(a, { t: 'nade', cid: 'dup1', o: eyeA3, v: [0, 3, -3] }); await delay(120); }
    a.ws.off('message', hr);
    assert.ok(rejects.length === 1 && rejects[0].id === aid && Number.isFinite(rejects[0].life) && rejects[0].reason === 'wrong-weapon' && rejects[0].kind === 'grenade',
      `R8: ${JSON.stringify(rejects)}`);
    note(`R8 nadeReject una sola vez por cid: ${JSON.stringify(rejects[0])} (motivo real: la PRIMERA regla, arma equipada)`);
    // C6: fire sin arma válida → rechazado (antes caía a SMG)
    {
      const noW = await fireRaw({ w: undefined, fs: { ...base, w: 'smg', n: nextN() } });
      const badW = await fireRaw({ w: 'laser', fs: { ...base, w: 'smg', n: nextN() } });
      assert.ok(!noW && !badW, `C6: fire sin arma ${noW}, con arma inválida ${badW}`);
      note('C6 `fire` sin `w` o con un arma inválida: rechazado (antes se tomaba como SMG)');
    }
    // C2: la dispersión con la que tiró el cliente (`sa`): ADS a medio subir = cadera
    {
      for (let i = 0; i < 4; i++) { st(a, { w: 'smg', aim: 1 }); await delay(50); }
      await delay(200);
      const hipW = spreadForW('smg', { aim: false, moving: 0.2 });
      const offAxis2 = (deg) => [bx + Math.sin(deg * Math.PI / 180) * 30, eyeA3[1], az + Math.cos(deg * Math.PI / 180) * 30];
      const withSa = await fireRaw({ p: offAxis2(hipW), fs: { ...base, aim: 1, w: 'smg', sa: 0, n: nextN() } });
      const noSa = await fireRaw({ p: offAxis2(hipW + 1.5), fs: { ...base, aim: 1, w: 'smg', n: nextN() } });
      assert.ok(withSa && !noSa, `C2: dispersión de cadera durante la subida ${withSa}, sin sa fuera del cono ADS ${noSa}`);
      note(`C2 subiendo la mira (sa 0, cadera): bala a ${hipW.toFixed(1)}° aceptada; sin \`sa\`, el cono es el de ADS y una bala a ${(hipW + 1.5).toFixed(1)}° se rechaza`);
    }
    // contador de rechazos (matriz honesta)
    const refusals = await (await fetch(`http://127.0.0.1:${port}/test/refusals`)).json();
    assert.ok(refusals['sample-missing'] >= 1 && refusals['sample-weapon'] >= 1 && refusals['fire-direction'] >= 1, `refusals: ${JSON.stringify(refusals)}`);
    note(`contador GET /test/refusals: ${JSON.stringify(refusals)}`);
  }
  // 4e bots: solo estados del contrato
  note('4e estados de bot: cover_low/blind → crouch, dive/flip/cover_high → idle (server.js CONTRACT_STATES); ver check-fps-bots-hosted');

  // ---------- 3. matriz de versiones (decisión 16) contra el servidor ANTERIOR real ----------
  // Revisión publicada en main antes del cambio de protocolo; HEAD en un PR
  // incluye el propio cambio. El servidor de esta revisión omite fps en welcome.
  const legacyRevision = '9fc6f1235def4816f9ddcc2686c428773b89d8f5';
  globalThis.WebSocket = WebSocket;
  const { NetClient } = await import('../src/net/client.js');
  const fakeWep = { cur: 'smg', st: { mag: 30, reserve: 90 }, reloading: false, def: { reloadTime: 2 } };
  const nc = new NetClient(); const sent = [];
  const w1 = await nc.connect(`ws://127.0.0.1:${port}`, 'NC', 0, 'join');
  assert.equal(w1.fps, 1);
  const orig = nc.send.bind(nc); nc.send = (o) => { sent.push(o); orig(o); };
  const crouched = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, aim: false, cam: { pitch: 0 }, speed: 0, stanceLow: 1, lean: 0,
    animState: () => 'crouch', cameraYawError: () => 0 };
  nc.tickState(1, crouched, fakeWep, 1);
  assert.ok(sent.at(-1).st === 'crouch' && Number.isFinite(sent.at(-1).n) && Number.isFinite(sent.at(-1).ct), 'cliente nuevo: estado sin crouch, n o ct');
  nc.close();
  oldDir = fs.mkdtempSync(path.join(root, '.fps-origin-'));
  const archive = execFileSync('git', ['archive', legacyRevision, 'server', 'src', 'package.json'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldDir], { input: archive });
  const legacyPort = await freePort();
  oldServer = spawn(process.execPath, [path.join(oldDir, 'server', 'server.js')], {
    cwd: oldDir, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(legacyPort), INTRO_TIME: '0', COUNTDOWN_TIME: '0', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' }, stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${legacyPort}/status`);
  const nc2 = new NetClient(); let outdatedEvent = null;
  nc2.on('server-outdated', (e) => { outdatedEvent = e; });
  const errOld = await nc2.connect(`ws://127.0.0.1:${legacyPort}`, 'NC', 0, 'create').then(() => null, (e) => e);
  assert.ok(errOld?.code === 'server-outdated' && outdatedEvent && !nc2.connected, `cliente nuevo con servidor anterior: ${errOld?.code ?? 'entró'}`);
  if (nc2.ws.readyState !== WebSocket.CLOSED) {
    await once(nc2.ws, 'close', { signal: AbortSignal.timeout(6000) });
  }
  assert.equal(nc2.ws.readyState, WebSocket.CLOSED, 'el socket con el servidor anterior sigue abierto');
  // El servidor publicado omite ambas marcas. Comprobar además que cada una
  // sea necesaria aunque la otra sí venga en el welcome.
  for (const version of [{ fps: 1 }, { hp: 2 }]) {
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const nc3 = new NetClient();
    try {
      await once(fake, 'listening');
      fake.on('connection', ws => ws.on('message', () => ws.send(JSON.stringify({
        t: 'welcome', id: 'p1', team: 'red', lobby: {}, ...version,
      }))));
      await assert.rejects(nc3.connect(`ws://127.0.0.1:${fake.address().port}`, 'NC', 0, 'join'),
        { code: 'server-outdated' });
      assert.equal(nc3.connected, false);
    } finally {
      nc3.close();
      fake.close();
    }
  }
  note('3 matriz (decisión 16): nuevo/nuevo → juega (crouch, n, ct); nuevo/ANTERIOR (9fc6f12 real) → server-outdated, socket cerrado, no entra; anterior/nuevo → rechazado (2a)');
} finally {
  for (const p of peers) p.ws.close();
  oldServer?.kill();
  server.kill();
  if (oldDir) fs.rmSync(oldDir, { recursive: true, force: true });
}
console.log('FPS ORIGIN OK');
