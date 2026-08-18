// Efectos ligeros: tracers, fogonazos, impactos, gibs estilizados, polvo de slides.
import * as THREE from 'three';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = []; // {obj, life, ttl, tick(item, dt)}
    this._tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true });
    this._tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  }

  _add(obj, ttl, tick) {
    this.scene.add(obj);
    this.items.push({ obj, life: 0, ttl, tick });
  }

  tracer(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.3) return;
    const m = new THREE.Mesh(this._tracerGeo, this._tracerMat.clone());
    m.scale.set(0.025, 0.025, len);
    m.position.copy(from).addScaledVector(dir, 0.5);
    m.lookAt(to);
    this._add(m, 0.07, (it) => {
      it.obj.material.opacity = 1 - it.life / it.ttl;
    });
  }

  muzzleFlash(pos, big = false) {
    const light = new THREE.PointLight(0xffb35c, big ? 26 : 14, 7);
    light.position.copy(pos);
    this._add(light, 0.055, (it) => {
      it.obj.intensity *= 0.75;
    });
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(big ? 0.14 : 0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffcf7d, transparent: true, opacity: 0.95 })
    );
    s.position.copy(pos);
    this._add(s, 0.05, (it) => {
      it.obj.scale.multiplyScalar(1.18);
      it.obj.material.opacity = 0.95 * (1 - it.life / it.ttl);
    });
  }

  _burst(pos, count, color, speed, size, ttl, gravity = 9) {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
      vels.push(new THREE.Vector3(
        (Math.random() - 0.5) * 2, Math.random() * 0.9 + 0.1, (Math.random() - 0.5) * 2
      ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6)));
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

  impact(pos) { this._burst(pos, 8, 0xd8d2c4, 3.2, 0.055, 0.35); }
  blood(pos, teamColor) { this._burst(pos, 10, teamColor, 2.6, 0.07, 0.4); }
  dust(pos) { this._burst(new THREE.Vector3(pos.x, 0.15, pos.z), 9, 0xbdb6a8, 1.6, 0.09, 0.5, 2.5); }

  // explosión de piezas al morir por gib (cubos del color del equipo + gris)
  gib(pos, teamColor) {
    for (let i = 0; i < 14; i++) {
      const c = i % 3 === 0 ? teamColor : (i % 3 === 1 ? 0x565b63 : 0x33363c);
      const s = 0.07 + Math.random() * 0.12;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshLambertMaterial({ color: c })
      );
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
          it.obj.material.transparent = true;
          it.obj.material.opacity = 1 - (it.life - it.ttl * 0.7) / (it.ttl * 0.3);
        }
      });
    }
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      if (it.life >= it.ttl) {
        this.scene.remove(it.obj);
        if (it.obj.geometry && it.obj.geometry !== this._tracerGeo) it.obj.geometry.dispose();
        if (it.obj.material && it.obj.material !== this._tracerMat) it.obj.material.dispose?.();
        this.items.splice(i, 1);
      } else it.tick(it, dt);
    }
  }
}
