// Efectos ligeros: tracers, fogonazos, impactos, gibs estilizados, polvo de slides.
import * as THREE from 'three';

const DECAL_MAX = 96;
const DECAL_LIFE = 22;
const DECAL_FADE = 4;
const PLUS_Z = new THREE.Vector3(0, 0, 1);
const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const IMPACT_COLORS = {
  concrete: new THREE.Color(0x6c7375),
  stone: new THREE.Color(0x786a58),
  metal: new THREE.Color(0x8c7155),
};

function makePool(scene, count, factory) {
  const free = [];
  for (let i = 0; i < count; i++) {
    const obj = factory();
    obj.visible = false;
    obj.frustumCulled = false;
    scene.add(obj);
    free.push(obj);
  }
  return {
    free,
    acquire() { return this.free.pop() || null; },
    release(obj) {
      obj.visible = false;
      this.free.push(obj);
    },
  };
}

// Un solo InstancedMesh y un ring buffer: 96 impactos cuestan un draw call,
// nunca crean/destruyen meshes y la marca más antigua se reutiliza primero.
class ImpactDecalPool {
  constructor(scene, max = DECAL_MAX) {
    this.max = max;
    this.cursor = 0;
    this.activeCount = 0;
    this.slots = new Array(max).fill(null);
    this.opacity = new Float32Array(max);
    this.colors = new Float32Array(max * 3);

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(this.opacity, 1));
    geo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(this.colors, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: `
        attribute float instanceOpacity;
        attribute vec3 instanceColor;
        varying vec2 vUv;
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vOpacity = instanceOpacity;
          vColor = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          float a = atan(p.y, p.x);
          float jag = sin(a * 7.0 + 0.8) * 0.018 + sin(a * 13.0) * 0.010;
          float outer = 1.0 - smoothstep(0.43 + jag, 0.50 + jag, r);
          float core = 1.0 - smoothstep(0.08, 0.29, r);
          float ring = smoothstep(0.24, 0.31, r) - smoothstep(0.38 + jag, 0.46 + jag, r);
          ring *= 0.68 + 0.32 * sin(a * 9.0 + 1.7);
          float alpha = max(core * 0.86, max(ring * 0.82, outer * 0.13)) * vOpacity;
          if (alpha < 0.025) discard;
          vec3 soot = vec3(0.018, 0.021, 0.023);
          vec3 color = mix(soot, vColor, clamp(ring * 1.35, 0.0, 0.72));
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    geo.userData.shared = true;
    mat.userData.shared = true;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = 'impact-decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);

    this._normal = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._spin = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
  }

  add(point, normal, surface = 'concrete') {
    if (!point || !normal) return;
    this._normal.set(normal.x, normal.y, normal.z);
    if (this._normal.lengthSq() < 0.5) return;
    this._normal.normalize();

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (!this.slots[i]) this.activeCount++;
    this.slots[i] = { age: 0, ttl: DECAL_LIFE + Math.random() * 4 };

    const base = surface === 'metal' ? 0.115 : surface === 'stone' ? 0.155 : 0.14;
    const size = base * (0.82 + Math.random() * 0.36);
    this._pos.copy(point).addScaledVector(this._normal, 0.008);
    this._quat.setFromUnitVectors(PLUS_Z, this._normal);
    this._spin.setFromAxisAngle(PLUS_Z, Math.random() * Math.PI * 2);
    this._quat.multiply(this._spin);
    this._scale.set(size, size * (0.86 + Math.random() * 0.2), 1);
    this._matrix.compose(this._pos, this._quat, this._scale);
    this.mesh.setMatrixAt(i, this._matrix);

    const color = IMPACT_COLORS[surface] || IMPACT_COLORS.concrete;
    const tone = 0.82 + Math.random() * 0.28;
    this.colors[i * 3] = color.r * tone;
    this.colors[i * 3 + 1] = color.g * tone;
    this.colors[i * 3 + 2] = color.b * tone;
    this.opacity[i] = 0.92 + Math.random() * 0.08;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.instanceColor.needsUpdate = true;
    this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  }

  update(dt) {
    let opacityDirty = false, matrixDirty = false;
    for (let i = 0; i < this.max; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        this.slots[i] = null;
        this.activeCount--;
        this.opacity[i] = 0;
        this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
        opacityDirty = matrixDirty = true;
      } else if (slot.age > slot.ttl - DECAL_FADE) {
        this.opacity[i] = Math.max(0, (slot.ttl - slot.age) / DECAL_FADE);
        opacityDirty = true;
      }
    }
    if (opacityDirty) this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.cursor = 0;
    this.activeCount = 0;
    this.slots.fill(null);
    this.opacity.fill(0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = []; // {obj, life, ttl, tick(item, dt)}
    this._tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true });
    this._tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this._flashMat = new THREE.MeshBasicMaterial({ color: 0xffcf7d, transparent: true, opacity: 0.95 });
    this._flashGeo = [
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.SphereGeometry(0.14, 8, 6),
    ];
    this._gibGeo = new THREE.BoxGeometry(1, 1, 1);
    this._gibMats = new Map();
    this.decals = new ImpactDecalPool(scene);
    this._impactBurstBudget = 4;
    // Una sola luz siempre presente: intensidad 0 cuando está inactiva.
    // Añadir/quitar PointLights por disparo invalidaba los programas WebGL.
    this._muzzleLight = new THREE.PointLight(0xffb35c, 0, 7);
    this._muzzleLightT = 0;
    this._muzzleLightPeak = 0;
    scene.add(this._muzzleLight);
    this._tracerPool = makePool(scene, 32,
      () => new THREE.Mesh(this._tracerGeo, this._tracerMat));
    this._flashPools = this._flashGeo.map((geo) => makePool(scene, 16,
      () => new THREE.Mesh(geo, this._flashMat)));
    for (const r of [this._tracerMat, this._tracerGeo, this._flashMat, ...this._flashGeo, this._gibGeo]) {
      r.userData.shared = true;
    }
  }

  _add(obj, ttl, tick, release = null) {
    if (!obj.parent) this.scene.add(obj);
    obj.visible = true;
    this.items.push({ obj, life: 0, ttl, tick, release });
  }

  tracer(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.3) return;
    const m = this._tracerPool.acquire();
    if (!m) return; // priorizar frame time sobre un tracer extra
    m.scale.set(0.025, 0.025, len);
    m.position.copy(from).addScaledVector(dir, 0.5);
    m.lookAt(to);
    this._add(m, 0.07, (it) => {
      const fade = Math.max(0.15, 1 - it.life / it.ttl);
      it.obj.scale.x = it.obj.scale.y = 0.025 * fade;
    }, (obj) => this._tracerPool.release(obj));
  }

  muzzleFlash(pos, big = false) {
    this._muzzleLight.position.copy(pos);
    this._muzzleLightPeak = big ? 26 : 14;
    this._muzzleLight.intensity = this._muzzleLightPeak;
    this._muzzleLightT = 0.055;
    const pool = this._flashPools[big ? 1 : 0];
    const s = pool.acquire();
    if (!s) return;
    s.position.copy(pos);
    s.scale.setScalar(1);
    this._add(s, 0.05, (it) => {
      it.obj.scale.multiplyScalar(1.18);
    }, (obj) => pool.release(obj));
  }

  _burst(pos, count, color, speed, size, ttl, gravity = 9, normal = null) {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 2, Math.random() * 0.9 + 0.1, (Math.random() - 0.5) * 2
      );
      if (normal) {
        const dot = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
        if (dot < 0) vel.addScaledVector(normal, -2 * dot);
        vel.addScaledVector(normal, 0.75);
      }
      vels.push(vel.normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6)));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color, size, transparent: true });
    const pts = new THREE.Points(geo, mat);
    this._add(pts, ttl, (it, dt) => {
      const p = it.obj.geometry.attributes.position;
      for (let i = 0; i < count; i++) {
        vels[i].y -= gravity * dt;
        p.array[i * 3] += vels[i].x * dt;
        p.array[i * 3 + 1] = Math.max(0.02, p.array[i * 3 + 1] + vels[i].y * dt);
        p.array[i * 3 + 2] += vels[i].z * dt;
      }
      p.needsUpdate = true;
      it.obj.material.opacity = 1 - it.life / it.ttl;
    });
  }

  impact(pos, normal = null, surface = 'concrete') {
    if (normal) this.decals.add(pos, normal, surface);
    // Los decals siempre se registran; los puffs se presupuestan para que una
    // escopeta no cree ocho sistemas de partículas en el mismo frame.
    if (this._impactBurstBudget < 1) return;
    this._impactBurstBudget--;
    if (surface === 'metal') this._burst(pos, 4, 0xffb568, 4.1, 0.045, 0.24, 5, normal);
    else if (surface === 'stone') this._burst(pos, 5, 0xb5a58d, 2.5, 0.052, 0.32, 8, normal);
    else this._burst(pos, 5, 0xb8bec0, 2.4, 0.05, 0.3, 7, normal);
  }
  blood(pos, teamColor) { this._burst(pos, 10, teamColor, 2.6, 0.07, 0.4); }
  dust(pos) { this._burst(new THREE.Vector3(pos.x, 0.15, pos.z), 9, 0xbdb6a8, 1.6, 0.09, 0.5, 2.5); }

  // explosión de piezas al morir por gib (cubos del color del equipo + gris)
  gib(pos, teamColor) {
    for (let i = 0; i < 14; i++) {
      const c = i % 3 === 0 ? teamColor : (i % 3 === 1 ? 0x565b63 : 0x33363c);
      const s = 0.07 + Math.random() * 0.12;
      let mat = this._gibMats.get(c);
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ color: c });
        mat.userData.shared = true;
        this._gibMats.set(c, mat);
      }
      const m = new THREE.Mesh(
        this._gibGeo,
        mat
      );
      m.scale.setScalar(s);
      m.castShadow = true;
      m.position.set(pos.x, 0.9 + Math.random() * 0.5, pos.z);
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 6, Math.random() * 5 + 2, (Math.random() - 0.5) * 6
      );
      const rot = new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      this._add(m, 1.1, (it, dt) => {
        vel.y -= 16 * dt;
        it.obj.position.addScaledVector(vel, dt);
        if (it.obj.position.y < 0.05) { it.obj.position.y = 0.05; vel.y *= -0.35; vel.x *= 0.7; vel.z *= 0.7; }
        it.obj.rotation.x += rot.x * dt; it.obj.rotation.y += rot.y * dt;
        if (it.life > it.ttl * 0.7) {
          const fade = Math.max(0.05, 1 - (it.life - it.ttl * 0.7) / (it.ttl * 0.3));
          it.obj.scale.setScalar(s * fade);
        }
      });
    }
  }

  update(dt) {
    if (this._muzzleLightT > 0) {
      this._muzzleLightT = Math.max(0, this._muzzleLightT - dt);
      this._muzzleLight.intensity = this._muzzleLightPeak * (this._muzzleLightT / 0.055);
    } else this._muzzleLight.intensity = 0;
    this._impactBurstBudget = Math.min(4, this._impactBurstBudget + dt * 10);
    this.decals.update(dt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      if (it.life >= it.ttl) {
        if (it.release) it.release(it.obj);
        else {
          this.scene.remove(it.obj);
          if (it.obj.geometry && !it.obj.geometry.userData.shared) it.obj.geometry.dispose();
          if (it.obj.material && !it.obj.material.userData.shared) it.obj.material.dispose?.();
        }
        this.items.splice(i, 1);
      } else it.tick(it, dt);
    }
  }

  // Prepara los programas/materiales que solo aparecen al disparar o impactar.
  // Se ejecuta una vez, detrás del splash, y limpia todos los objetos de prueba.
  async prepare(renderer, camera) {
    if (this._prepared) return;
    this._prepared = true;
    const p = new THREE.Vector3(0, -1000, 0);
    const q = new THREE.Vector3(0, -1000, -3);
    const n = new THREE.Vector3(0, 1, 0);
    this.tracer(p, q);
    this.muzzleFlash(p, false);
    this.muzzleFlash(q, true);
    this._impactBurstBudget = 4;
    this.impact(p, n, 'concrete');
    this.impact(q, n, 'metal');
    this.blood(p, 0xd94f3f);
    this.dust(q);
    if (renderer.compileAsync) await renderer.compileAsync(this.scene, camera);
    else renderer.compile(this.scene, camera);
    this.update(999);
    this.clearImpacts();
    this._impactBurstBudget = 4;
  }

  clearImpacts() { this.decals.clear(); }
}
