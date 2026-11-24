// Marcadores de compañeros sobre la vista (DOM, sin three). El NOMBRE ya lo
// pone el rig (etiqueta 3D de rig.js, a 2.05 m: a través de muros solo para
// compañeros); repetirlo aquí lo duplicaba. Este marcador añade lo que la
// etiqueta no da: un chevrón de equipo de tamaño fijo en pantalla, legible a
// cualquier distancia, atenuado y hueco cuando el compañero no está a la vista.
// Enemigos: SOLO lo que diga quien llama (main.js decide cada cuadro quién se
// puede identificar: apuntado con línea de vista real, humo incluido) y aun
// así nunca si viene `occluded`. Ninguna regla propia aquí que pueda
// "rescatar" a un enemigo oculto: lo que no llega identificado no se dibuja.
// `top` (opcional) = altura real de la cabeza en mundo (agachado, tras LOW).
// Pool fijo de nodos; posición por transform (sin layout) y cuantizada a 1 px.
const POOL = 10;
const HEAD = 2.42; // m sobre los pies: por encima de la etiqueta del rig (2.05 m)

export class Markers {
  constructor(root) {
    this.root = root;
    this.nodes = [];
    for (let i = 0; i < POOL; i++) {
      const n = document.createElement('div');
      n.className = 'mk';
      n.innerHTML = '<i class="mk-chev"></i>';
      root.appendChild(n);
      this.nodes.push({ n, on: false, x: NaN, y: NaN, cls: '' });
    }
  }

  // list: [{ x, y, z, team, name, ally, occluded, aimed, dist }]; camera: THREE.Camera
  update(list, camera, width, height) {
    let used = 0;
    if (list && camera) {
      const v = camera.matrixWorldInverse?.elements, p = camera.projectionMatrix?.elements;
      for (const m of list) {
        if (used >= POOL || !v || !p) break;
        const foe = !m.ally;
        if (foe && !(m.aimed === true && m.occluded !== true)) continue;
        const wy = m.labelY ?? (Number.isFinite(m.top) ? m.top + 0.35 : (m.y ?? 0) + HEAD);
        // vista
        const vx = v[0] * m.x + v[4] * wy + v[8] * m.z + v[12];
        const vy = v[1] * m.x + v[5] * wy + v[9] * m.z + v[13];
        const vz = v[2] * m.x + v[6] * wy + v[10] * m.z + v[14];
        if (vz > -0.5) continue; // detrás de la cámara
        // proyección (perspectiva)
        const cx = p[0] * vx + p[8] * vz, cy = p[5] * vy + p[9] * vz, cw = -vz;
        const sx = Math.round((cx / cw * 0.5 + 0.5) * width);
        // El centro del sprite del nombre se proyecta primero; la separación es vertical en pantalla.
        const labelHalf = m.labelY == null ? 0 : 0.19 * p[5] * height / (2 * cw);
        const sy = Math.round((-cy / cw * 0.5 + 0.5) * height - labelHalf);
        if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue;
        const slot = this.nodes[used++];
        const cls = `mk on ${m.team === 'blue' ? 'blue' : 'red'}${foe ? ' foe' : ` ally${m.occluded ? ' occ' : ''}`}`;
        if (slot.cls !== cls) { slot.cls = cls; slot.n.className = cls; }
        if (slot.x !== sx || slot.y !== sy) {
          slot.x = sx; slot.y = sy;
          slot.n.style.transform = `translate3d(${sx}px,${sy}px,0)`;
        }
        slot.on = true;
      }
    }
    for (let i = used; i < POOL; i++) {
      const slot = this.nodes[i];
      if (slot.on) { slot.on = false; slot.cls = 'mk'; slot.n.className = 'mk'; }
    }
  }
}
