// Patada del soldado en tercera persona, confirmación remota y contacto del bot.
// Las medidas salen de las articulaciones que mueve el rig en partida.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { attachBlenderSoldier } from '../src/player/blender-soldier.js';
import { Scene, Vector3 } from 'three';
import { Rig } from '../src/player/rig.js';
import { RemotePlayer } from '../src/player/remote.js';
import { BotMatch } from '../src/game/botmatch.js';
import { meleeHitOk } from '../src/combat/melee-reach.js';
import { eyeWorld } from '../src/combat/hit-pose.js';
import { TUNING } from '../src/config/tuning.js';

const ml = TUNING.melee;
const scene = new Scene();
const rig = new Rig(scene, 'red');
// Conecta el cargador de partida a los GLB locales para medir las suelas Blender.
const load = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = async function (url) {
  const bytes = await readFile(new URL('../public' + url, import.meta.url));
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
};
try { await attachBlenderSoldier(rig); } finally { GLTFLoader.prototype.loadAsync = load; }
rig.update(1 / 60, { state: 'idle', speed: 0 });
assert.equal(rig.blenderSoldier, true);
const sole = new Vector3();
const head = new Vector3();
for (const hz of [30, 60, 144]) {
  const dt = 1 / hz;
  for (const recovery of [ml.hitRecovery, ml.killRecovery, ml.missRecovery]) {
    for (let i = 0; i < hz; i++) rig.update(dt, { state: 'idle', speed: 0 });
    rig.root.updateMatrixWorld(true);
    const headAtStart = rig._headInRoot(new Vector3());
    let contact = -1;
    const total = ml.hitAt + recovery;
    for (let i = 0; i <= Math.ceil(total * hz); i++) {
      const elapsed = i * dt;
      const end = elapsed < ml.hitAt ? ml.time : total;
      rig.update(dt, { state: 'melee', speed: 0, meleePhase: Math.min(1, elapsed / end), meleeEnd: end });
      rig.root.updateMatrixWorld(true);
      assert(rig._headInRoot(head).distanceTo(headAtStart) < 0.015, 'el casco se alejó de su pose impactable');
      if (contact < 0 && rig.legR.knee.rotation.x >= -0.06000001) {
        contact = i;
        rig.soleWorld(rig.legR, sole);
        assert(sole.z < -0.6 && sole.y > 0.68, 'la suela no llegó al frente: ' + sole.toArray());
      }
    }
    assert(Math.abs(contact * dt - ml.hitAt) <= dt + 1e-8, 'la rodilla llega tarde al tope');
    rig.soleWorld(rig.legR, sole, true);
    assert(sole.y < 0.02, 'la bota quedó levantada');
  }

  for (const advancing of [false, true]) {
    rig.setTransform(0, 0, 0);
    for (let i = 0; i < hz; i++) rig.update(dt, { state: 'idle', speed: 0 });
    const planted = rig.soleWorld(rig.legL, new Vector3());
    let lift = 0;
    for (let i = 0; i <= Math.ceil(ml.hitAt * hz); i++) {
      const t = Math.min(ml.hitAt, i * dt);
      rig.setTransform(0, advancing ? -6 * t : 0, 0);
      rig.update(dt, { state: 'melee', speed: advancing && t < ml.hitAt ? 1 : 0, meleePhase: t / ml.time, meleeEnd: ml.time });
      const height = rig.soleWorld(rig.legL, sole, true).y;
      lift = Math.max(lift, height);
      if (!advancing || t === ml.hitAt) assert(Math.abs(height) < 0.015, 'El pie de apoyo debe pisar en el contacto');
      if (!advancing) {
        rig.soleWorld(rig.legL, sole);
        assert(Math.hypot(sole.x - planted.x, sole.z - planted.z) < 0.01, 'La huella del apoyo patina');
      }
    }
    if (advancing) assert(lift > 0.05, 'El pie debe despegar durante el paso de embestida');
    assert(rig.torso.rotation.x > 0.10 && rig.hips.position.z < -0.06, 'La pelvis y el pecho acompañan la extensión');
  }

  const remote = new RemotePlayer(scene, 'remoto', null, 'red', 0, rig);
  const event = 1 + ml.hitAt;
  for (let i = 0; i <= 25; i++) {
    const t = 0.5 + i / 20;
    remote.push({ st: t >= 1 && t < 1.5 ? 'melee' : 'idle', x: 0, z: 0, y: 0, yaw: 0, w: 'smg' }, t);
  }
  for (let i = 0; i <= Math.ceil(hz * (event - 0.65)); i++) {
    const t = 0.65 + i * dt;
    if (t >= event) remote.applyMeleeHit(t);
    remote.update(dt, scene, t);
  }
  assert.equal(remote.st, 'melee');
  assert(Math.abs(rig.legR.knee.rotation.x + 0.06) < 1e-8, 'el remoto no extendió al confirmar');
}

const bot = { id: 'bot0', name: 'Bot', team: 'red', yaw: 0, pos: { x: 0, z: 0 }, y: 0, pose: () => ({ st: 'melee' }) };
const eye = eyeWorld(bot.pose(), 0, 0, 0, 0);
let solid = false, hits = 0, fx = 0;
const world = {
  raycast: () => solid ? 0.3 : null,
  raycastHit: () => solid ? { t: 0.3, normal: new Vector3(0, 0, 1) } : null,
};
const enemy = { id: 'target', alive: true, team: 'blue', x: 0, y: 0, z: 0 };
const match = new BotMatch(scene, world, {
  humans: () => [enemy],
  botFire: (b, origin, point) => {
    assert(origin.distanceTo(new Vector3(...eye)) < 1e-8, 'el bot golpeó desde otro origen');
    assert(meleeHitOk(eye, bot.yaw, point.toArray(), [enemy.x, 0.9, enemy.z]));
  },
  botHit: () => hits++,
  effects: { meleeWorld: () => fx++ },
}, { external: true, bots: [] });
for (const [degrees, distance, blocked, expected] of [[57, 1.3, false, true], [59, 1.3, false, false],
  [0, 4, false, false], [0, 1.3, true, false], [0, 1.3, false, true]]) {
  solid = blocked;
  enemy.x = eye[0] + Math.sin(degrees * Math.PI / 180) * distance;
  enemy.z = eye[2] - Math.cos(degrees * Math.PI / 180) * distance;
  assert.equal(match.botMelee(bot).connected, expected, 'el bot discrepa de la validación a ' + degrees + '°');
}
assert.equal(hits, 2);
assert.equal(fx, 1, 'solo la pared produce polvo sin daño');
console.log('Patada 3P a 30/60/144 Hz, cabeza, confirmación remota, ojo, alcance, cono y pared de bots OK.');
