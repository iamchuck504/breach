import * as THREE from 'three';
import { applyPelletPattern } from '../src/combat/ballistics.js';
import { TUNING } from '../src/config/tuning.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const near = (a, b, eps = 1e-7) => Math.abs(a - b) <= eps;

function basis(dir) {
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  return { right, vertical: new THREE.Vector3().crossVectors(dir, right).normalize() };
}

function localOffsets(dir, spread) {
  const b = basis(dir);
  const tanSpread = Math.tan(spread * Math.PI / 180);
  return Array.from({ length: 8 }, (_, i) => {
    const pellet = applyPelletPattern(dir, spread, i, 8);
    // Intersección con el plano situado a forward=1. Así recuperamos el
    // offset angular independientemente de la dirección mundial del tiro.
    const forward = pellet.dot(dir);
    return {
      x: pellet.dot(b.right) / forward / tanSpread,
      y: pellet.dot(b.vertical) / forward / tanSpread,
      dir: pellet,
    };
  });
}

const def = TUNING.weapons.shotgun;
check(def.pellets === 8, `cantidad de pellets cambió (${def.pellets})`);

const forward = new THREE.Vector3(0, 0, -1);
const first = localOffsets(forward, def.spreadHip);
const second = localOffsets(forward, def.spreadHip);
for (let i = 0; i < 8; i++) {
  check(first[i].dir.distanceTo(second[i].dir) < 1e-12,
    `pellet ${i} cambió entre disparos idénticos`);
}

// Simetría exacta: cada punto tiene su opuesto; la media permanece centrada.
let meanX = 0, meanY = 0;
for (const p of first) {
  meanX += p.x; meanY += p.y;
  check(first.some((q) => near(q.x, -p.x) && near(q.y, -p.y)),
    `sin opuesto para (${p.x.toFixed(3)}, ${p.y.toFixed(3)})`);
}
check(near(meanX, 0) && near(meanY, 0), `patrón descentrado (${meanX}, ${meanY})`);
const radii = first.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
check(radii.slice(0, 4).every((r) => near(r, 0.38, 1e-6)), 'anillo interior irregular');
check(radii.slice(4).every((r) => near(r, 1, 1e-6)), 'anillo exterior perdió el radio de spread');

// Hip, ADS y blindfire conservan exactamente sus conos existentes.
for (const key of ['spreadAim', 'spreadHip', 'spreadBlind']) {
  const pts = localOffsets(forward, def[key]);
  const maxAngle = Math.max(...pts.map((p) => forward.angleTo(p.dir))) * 180 / Math.PI;
  check(near(maxAngle, def[key], 1e-6), `${key}: ${maxAngle}° != ${def[key]}°`);
}

// Yaw/pitch diferentes producen los mismos offsets LOCALES, incluso cerca de
// vertical: el patrón acompaña al arma/cámara y nunca usa direcciones absolutas.
for (const dir of [
  new THREE.Vector3(0.72, 0.28, -0.64).normalize(),
  new THREE.Vector3(-0.35, -0.62, -0.7).normalize(),
  new THREE.Vector3(0.03, 0.995, -0.095).normalize(),
  new THREE.Vector3(-0.04, -0.996, 0.08).normalize(),
]) {
  const rotated = localOffsets(dir, def.spreadHip);
  for (let i = 0; i < 8; i++) {
    check(near(rotated[i].x, first[i].x, 1e-6) && near(rotated[i].y, first[i].y, 1e-6),
      `patrón mundial/vertical cambió en pellet ${i}`);
    check(Number.isFinite(rotated[i].dir.x + rotated[i].dir.y + rotated[i].dir.z),
      `dirección inválida en pellet ${i}`);
  }
}

// La forma se conserva con la distancia: al duplicarla, se duplica la
// separación física en el plano de impacto sin cambiar el patrón relativo.
const b = basis(forward);
for (const p of first) {
  const f = p.dir.dot(forward);
  const at10 = new THREE.Vector2(p.dir.dot(b.right) / f * 10, p.dir.dot(b.vertical) / f * 10);
  const at20 = new THREE.Vector2(p.dir.dot(b.right) / f * 20, p.dir.dot(b.vertical) / f * 20);
  check(at20.distanceTo(at10.clone().multiplyScalar(2)) < 1e-8, 'el patrón no escala linealmente con distancia');
}

if (failures.length) {
  console.error('SHOTGUN PATTERN ERRORS:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('SHOTGUN PATTERN OK · 8 pellets · simétrico · repetible · yaw/pitch/distancia');
