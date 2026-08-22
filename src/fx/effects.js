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
      // Los impactos pueden quedar sobre perfiles biselados muy finos. Al
      // dibujar ambas caras siguen obedeciendo al depth buffer, pero no
      // desaparecen al mirar la superficie desde un ángulo rasante.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
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

  add(point, normal, surface = 'concrete', sizeScale = 1) {
    if (!point || !normal) return;
    this._normal.set(normal.x, normal.y, normal.z);
    if (this._normal.lengthSq() < 0.5) return;
    this._normal.normalize();

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (!this.slots[i]) this.activeCount++;
    this.slots[i] = { age: 0, ttl: DECAL_LIFE + Math.random() * 4 };

    const base = surface === 'metal' ? 0.115 : surface === 'stone' ? 0.155 : 0.14;
    const scale = Math.max(0.5, Math.min(5, Number(sizeScale) || 1));
    const size = base * (0.82 + Math.random() * 0.36) * scale;
    // Separación mínima de la superficie para evitar z-fighting al usar FOV
    // estrecho. Sigue visualmente pegado al material (1.2 cm en el mundo).
    this._pos.copy(point).addScaledVector(this._normal, 0.012);
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
  constructor(scene, world = null) {
    this.scene = scene;
    this.world = world;
    this.items = []; // {obj, life, ttl, tick(item, dt)}
    this._tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true });
    this._tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this._flashMat = new THREE.MeshBasicMaterial({ color: 0xffcf7d, transparent: true, opacity: 0.95 });
    this._flashGeo = [
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.SphereGeometry(0.14, 8, 6),
    ];
    this._gibGeo = new THREE.BoxGeometry(1, 1, 1);
    this._blastSphereGeo = new THREE.SphereGeometry(1, 14, 10);
    this._blastRingGeo = new THREE.RingGeometry(0.48, 1, 32);
    this._gibMats = new Map();
    this.decals = new ImpactDecalPool(scene);
    this._impactBurstBudget = 4;
    // Una sola luz siempre presente: intensidad 0 cuando está inactiva.
    // Añadir/quitar PointLights por disparo invalidaba los programas WebGL.
    this._muzzleLight = new THREE.PointLight(0xffb35c, 0, 7);
    this._muzzleLightT = 0;
    this._muzzleLightPeak = 0;
    scene.add(this._muzzleLight);
    // Luz independiente: una explosión no roba el flash de un arma que se
    // dispare durante el mismo frame y nunca crea/destruye luces dinámicas.
    this._blastLight = new THREE.PointLight(0xff8a3d, 0, 13, 2);
    this._blastLightT = 0;
    this._blastLightPeak = 0;
    scene.add(this._blastLight);
    this._tracerPool = makePool(scene, 32,
      () => new THREE.Mesh(this._tracerGeo, this._tracerMat));
    this._flashPools = this._flashGeo.map((geo) => makePool(scene, 16,
      () => new THREE.Mesh(geo, this._flashMat)));
    for (const r of [this._tracerMat, this._tracerGeo, this._flashMat, ...this._flashGeo,
      this._gibGeo, this._blastSphereGeo, this._blastRingGeo]) {
      r.userData.shared = true;
    }
  }

  _add(obj, ttl, tick, release = null) {
    if (!obj.parent) this.scene.add(obj);
    obj.visible = true;
    this.items.push({ obj, life: 0, ttl, tick, release });
  }

  tracer(from, to, emphasized = false) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.3) return;
    const m = this._tracerPool.acquire();
    if (!m) return; // priorizar frame time sobre un tracer extra
    const width = emphasized ? 0.038 : 0.025;
    const ttl = emphasized ? 0.10 : 0.07;
    m.scale.set(width, width, len);
    m.position.copy(from).addScaledVector(dir, 0.5);
    m.lookAt(to);
    this._add(m, ttl, (it) => {
      const fade = Math.max(0.15, 1 - it.life / it.ttl);
      it.obj.scale.x = it.obj.scale.y = width * fade;
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

  _burst(pos, count, color, speed, size, ttl, gravity = 9, normal = null, floorY = 0) {
    const floor = Number.isFinite(floorY) ? floorY + 0.02 : 0.02;
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
        p.array[i * 3 + 1] = Math.max(floor, p.array[i * 3 + 1] + vels[i].y * dt);
        p.array[i * 3 + 2] += vels[i].z * dt;
      }
      p.needsUpdate = true;
      it.obj.material.opacity = 1 - it.life / it.ttl;
    });
    return pts;
  }

  impact(pos, normal = null, surface = 'concrete', options = null) {
    const emphasized = !!options?.emphasized;
    if (normal) this.decals.add(pos, normal, surface, emphasized ? 1.65 : 1);
    // Los decals siempre se registran; los puffs se presupuestan para que una
    // escopeta no cree ocho sistemas de partículas en el mismo frame. Un
    // impacto local de sniper scoped siempre conserva un puff único y breve:
    // es el feedback que debe poder leerse dentro del FOV de 20 grados.
    if (this._impactBurstBudget < 1 && !emphasized) return;
    if (this._impactBurstBudget >= 1) this._impactBurstBudget--;
    const sizeScale = emphasized ? 1.5 : 1;
    const ttlScale = emphasized ? 1.22 : 1;
    let puff;
    if (surface === 'metal') puff = this._burst(pos, emphasized ? 7 : 4, 0xffb568,
      4.1, 0.045 * sizeScale, 0.24 * ttlScale, 5, normal);
    else if (surface === 'stone') puff = this._burst(pos, emphasized ? 8 : 5, 0xb5a58d,
      2.5, 0.052 * sizeScale, 0.32 * ttlScale, 8, normal);
    else puff = this._burst(pos, emphasized ? 8 : 5, 0xb8bec0,
      2.4, 0.05 * sizeScale, 0.3 * ttlScale, 7, normal);
    if (emphasized && puff) {
      puff.name = 'sniper-impact-puff';
      puff.renderOrder = 4;
      puff.material.depthWrite = false;
    }
  }
  blood(pos, teamColor) { this._burst(pos, 10, teamColor, 2.6, 0.07, 0.4); }

  // Explosión ambiental de bazooka. El daño sigue completamente separado:
  // este método solo presenta flash, bola de fuego, onda, humo y scorch mark.
  rocketExplosion(pos, info = {}) {
    const origin = new THREE.Vector3(pos.x, pos.y, pos.z);
    const direct = !!info.direct;
    const floorY = Number.isFinite(info.floorY) ? info.floorY : 0;
    const surface = info.surface || 'concrete';
    const normal = info.normal && Number.isFinite(info.normal.x)
      ? new THREE.Vector3(info.normal.x, info.normal.y, info.normal.z).normalize()
      : new THREE.Vector3(0, 1, 0);

    this._blastLight.position.copy(origin);
    this._blastLightPeak = direct ? 62 : 48;
    this._blastLight.intensity = this._blastLightPeak;
    this._blastLightT = direct ? 0.18 : 0.15;

    const fireMat = new THREE.MeshBasicMaterial({
      color: direct ? 0xff6a2e : 0xff8c3d, transparent: true,
      opacity: 0.96, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const fire = new THREE.Mesh(this._blastSphereGeo, fireMat);
    fire.position.copy(origin);
    fire.scale.setScalar(0.18);
    fire.renderOrder = 7;
    this._add(fire, direct ? 0.38 : 0.32, (it) => {
      const k = Math.min(1, it.life / it.ttl);
      const radius = (direct ? 2.35 : 1.9) * (1 - Math.pow(1 - k, 2));
      it.obj.scale.setScalar(Math.max(0.18, radius));
      it.obj.material.opacity = Math.pow(1 - k, 1.7) * 0.96;
    });

    const shockMat = new THREE.MeshBasicMaterial({
      color: 0xffe0b2, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    });
    const shock = new THREE.Mesh(this._blastSphereGeo, shockMat);
    shock.position.copy(origin);
    shock.scale.setScalar(0.35);
    shock.renderOrder = 6;
    this._add(shock, 0.46, (it) => {
      const k = Math.min(1, it.life / it.ttl);
      it.obj.scale.setScalar(0.35 + k * (direct ? 4.6 : 3.9));
      it.obj.material.opacity = (1 - k) * (1 - k) * 0.42;
    });

    // Onda pegada a la superficie y marca persistente. No se crea sobre un
    // impacto directo de carne, donde la lectura debe venir del cuerpo.
    if (!direct && info.normal) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffbd72, transparent: true, opacity: 0.68,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(this._blastRingGeo, ringMat);
      ring.position.copy(origin).addScaledVector(normal, 0.035);
      ring.quaternion.setFromUnitVectors(PLUS_Z, normal);
      ring.scale.setScalar(0.25);
      ring.renderOrder = 8;
      this._add(ring, 0.42, (it) => {
        const k = Math.min(1, it.life / it.ttl);
        it.obj.scale.setScalar(0.25 + k * 3.25);
        it.obj.material.opacity = (1 - k) * 0.68;
      });
      this.decals.add(origin, normal, surface, 4.2);
    }

    const debrisColor = surface === 'metal' ? 0xffb568
      : surface === 'stone' ? 0xb7a58c : 0xa89c8b;
    this._burst(origin, direct ? 22 : 16, 0xff9a45, direct ? 7.2 : 6.2,
      0.055, 0.62, 12, normal, floorY);
    this._burst(origin, direct ? 18 : 13, debrisColor, direct ? 5.8 : 4.8,
      0.075, 0.85, 14, normal, floorY);
    this._burst(origin, direct ? 24 : 18, 0x34383c, direct ? 3.5 : 2.9,
      direct ? 0.2 : 0.17, 1.35, -0.7, normal, floorY);
    if (direct) this._burst(origin, 15, 0x7a2028, 5.6, 0.1, 0.72, 11, normal, floorY);
  }

  // Restos de una muerte por bazooka. Los fragmentos tienen suelo local y
  // chocan con paredes; desaparecen pronto para no acumular física ni drawcalls.
  rocketDeath(pos, teamColor, level = 2, direction = null, floorY = 0) {
    const total = level >= 2;
    const count = total ? 26 : 14;
    const origin = new THREE.Vector3(pos.x, (pos.y ?? floorY) + 0.9, pos.z);
    let dir = null;
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) {
      dir = new THREE.Vector3(direction.x, direction.y ?? 0.12, direction.z);
      if (dir.lengthSq() > 0.001) dir.normalize(); else dir = null;
    }
    this._burst(origin, total ? 28 : 17, 0x741d25, total ? 6.8 : 5.0,
      total ? 0.105 : 0.085, total ? 0.95 : 0.72, 12, dir, floorY);
    this._burst(origin, total ? 16 : 10, teamColor, total ? 6.1 : 4.6,
      0.075, 0.78, 13, dir, floorY);

    const colors = [teamColor, 0x292d33, 0x555c65, 0x7a2028];
    for (let i = 0; i < count; i++) {
      const c = colors[i % colors.length];
      let mat = this._gibMats.get(c);
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ color: c });
        mat.userData.shared = true;
        this._gibMats.set(c, mat);
      }
      const chunk = new THREE.Mesh(this._gibGeo, mat);
      const size = (total ? 0.075 : 0.065) + Math.random() * (total ? 0.14 : 0.1);
      const long = i % 5 === 0 ? 1.85 : 0.8 + Math.random() * 0.55;
      chunk.scale.set(size * long, size * (0.65 + Math.random()), size * (0.7 + Math.random() * 0.8));
      const baseScale = chunk.scale.clone();
      chunk.position.copy(origin).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.38,
        (Math.random() - 0.5) * 0.42,
        (Math.random() - 0.5) * 0.38,
      ));
      chunk.castShadow = true;
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * (total ? 7.2 : 5.2),
        1.8 + Math.random() * (total ? 5.8 : 4.1),
        (Math.random() - 0.5) * (total ? 7.2 : 5.2),
      );
      if (dir) vel.addScaledVector(dir, total ? 2.2 + Math.random() * 2 : 1.3 + Math.random());
      const rot = new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      this._add(chunk, total ? 1.8 : 1.45, (it, dt) => {
        vel.y -= 16 * dt;
        const step = vel.clone().multiplyScalar(dt);
        const len = step.length();
        let collided = false;
        if (this.world && len > 0.001) {
          const hit = this.world.raycastHit(it.obj.position, step.clone().multiplyScalar(1 / len), len + 0.035);
          if (hit && hit.t <= len + 0.035) {
            const n = hit.normal ?? { x: 0, y: 1, z: 0 };
            it.obj.position.addScaledVector(step.normalize(), Math.max(0, hit.t - 0.025));
            const dot = vel.x * n.x + vel.y * n.y + vel.z * n.z;
            if (dot < 0) vel.addScaledVector(n, -1.35 * dot);
            vel.multiplyScalar(0.48);
            collided = true;
          }
        }
        if (!collided) it.obj.position.add(step);
        const localFloor = this.world?.groundHeight
          ? this.world.groundHeight({ x: it.obj.position.x, z: it.obj.position.z }, 0.04, it.obj.position.y)
          : floorY;
        const floor = Math.max(floorY, Number.isFinite(localFloor) ? localFloor : floorY) + 0.04;
        if (it.obj.position.y < floor) {
          it.obj.position.y = floor;
          vel.y *= -0.2; vel.x *= 0.62; vel.z *= 0.62;
        }
        it.obj.rotation.x += rot.x * dt;
        it.obj.rotation.y += rot.y * dt;
        if (it.life > it.ttl * 0.72) {
          const fade = Math.max(0.02, 1 - (it.life - it.ttl * 0.72) / (it.ttl * 0.28));
          it.obj.scale.copy(baseScale).multiplyScalar(fade);
        }
      });
    }
  }
  // Remate exclusivo del sniper a la cabeza: sangre concentrada a la altura
  // real del impacto + fragmentos pequeños de casco. Es deliberadamente más
  // localizado que gib(), que representa daño destructivo de cuerpo completo.
  sniperHeadshot(pos, teamColor, direction = null, floorY = 0) {
    const origin = new THREE.Vector3(pos.x, pos.y, pos.z);
    const floor = (Number.isFinite(floorY) ? floorY : 0) + 0.04;
    let dir = null;
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) {
      dir = new THREE.Vector3(direction.x, direction.y ?? 0.08, direction.z);
      if (dir.lengthSq() > 0.001) dir.normalize();
      else dir = null;
    }
    this._burst(origin, 18, 0x7a2028, 4.8, 0.085, 0.58, 10, dir, floorY);
    this._burst(origin, 9, teamColor, 5.4, 0.065, 0.5, 11, dir, floorY);
    for (let i = 0; i < 8; i++) {
      const c = i % 3 === 0 ? teamColor : (i % 3 === 1 ? 0x343941 : 0x606771);
      let mat = this._gibMats.get(c);
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ color: c });
        mat.userData.shared = true;
        this._gibMats.set(c, mat);
      }
      const shard = new THREE.Mesh(this._gibGeo, mat);
      const size = 0.035 + Math.random() * 0.055;
      shard.scale.set(size * (0.7 + Math.random() * 0.8), size, size * 0.65);
      const baseScale = shard.scale.clone();
      shard.position.copy(origin);
      shard.castShadow = true;
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4.8,
        1.4 + Math.random() * 3.8,
        (Math.random() - 0.5) * 4.8,
      );
      if (dir) vel.addScaledVector(dir, 2.4 + Math.random() * 1.5);
      const rot = new THREE.Vector3(Math.random() * 11, Math.random() * 11, Math.random() * 11);
      this._add(shard, 0.9, (it, dt) => {
        vel.y -= 15 * dt;
        it.obj.position.addScaledVector(vel, dt);
        if (it.obj.position.y < floor) {
          it.obj.position.y = floor;
          vel.y *= -0.22; vel.x *= 0.62; vel.z *= 0.62;
        }
        it.obj.rotation.x += rot.x * dt;
        it.obj.rotation.y += rot.y * dt;
        if (it.life > it.ttl * 0.68) {
          const fade = Math.max(0.02, 1 - (it.life - it.ttl * 0.68) / (it.ttl * 0.32));
          it.obj.scale.copy(baseScale).multiplyScalar(fade);
        }
      });
    }
  }
  meleeImpact(pos, teamColor, direction = null) {
    // Contacto compacto: destello cálido + partículas del color de la víctima.
    // Es deliberadamente menor que una explosión y no deja decal de bala.
    this._burst(pos, 5, 0xffc27a, 3.2, 0.055, 0.16, 5, direction);
    this._burst(pos, 7, teamColor, 2.15, 0.07, 0.34, 7, direction);
  }
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
    if (this._blastLightT > 0) {
      this._blastLightT = Math.max(0, this._blastLightT - dt);
      this._blastLight.intensity = this._blastLightPeak
        * Math.min(1, this._blastLightT / 0.18);
    } else this._blastLight.intensity = 0;
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
    this.sniperHeadshot(q, 0x4f8de0, n);
    this.rocketExplosion(q, { normal: n, surface: 'concrete', floorY: -1000 });
    this.rocketDeath(q, 0xd94f3f, 2, n, -1000);
    this.meleeImpact(q, 0x4f8de0, n);
    this.dust(q);
    if (renderer.compileAsync) await renderer.compileAsync(this.scene, camera);
    else renderer.compile(this.scene, camera);
    this.update(999);
    this.clearImpacts();
    this._impactBurstBudget = 4;
  }

  clearImpacts() { this.decals.clear(); }
}
