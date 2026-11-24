// Retícula de primera persona. Una sola SVG centrada; cada clase de arma
// enseña su forma y el TAMAÑO es la dispersión real que llega por cuadro
// (semiángulo en grados, el mismo valor que usa el disparo). Escribe atributos
// solo cuando cambia el valor cuantizado (0.5 px): cero trabajo en reposo.
//
// Formas (propias de Breach, cada trazo con un motivo):
//  auto      tres marcas (izq., der., abajo): sin marca superior para no tapar
//            la cabeza del blanco que se está siguiendo en ráfaga.
//  precise   dos marcas horizontales cortas: arma de tiro a tiro.
//  pattern   anillo partido en cuatro: el cono real de los perdigones.
//  marksman  punto + anillo fino: el rifle sin mira es impreciso y lo dice.
//  launcher  punto + soporte bajo: proyectil, no rayo.
//  thrown    punto + arco superior: lanzamiento parabólico.
import { reticleKind } from './hud-layout.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = Object.freeze({
  white: '#f4f3ee', green: '#5ee08f', yellow: '#ffd84a', cyan: '#5fd8f0', magenta: '#ff6ad5', red: '#ff5a4a',
});
const KINDS = ['auto', 'precise', 'pattern', 'marksman', 'launcher', 'thrown'];
const RAD = Math.PI / 180;

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  parent?.appendChild(n);
  return n;
}

export class Reticle {
  constructor(root) {
    this.root = root;
    this.svg = el('svg', { viewBox: '-160 -160 320 320', width: 320, height: 320, 'aria-hidden': 'true' }, root);
    const g = (kind) => el('g', { class: `rk rk-${kind}` }, this.svg);
    this.groups = Object.fromEntries(KINDS.map((k) => [k, g(k)]));
    // marcas: línea de longitud L que empieza en la separación (gap)
    this.ticks = {};
    const tick = (kind, dir) => {
      const line = el('line', { x1: 0, y1: 0, x2: 0, y2: 0 }, this.groups[kind]);
      (this.ticks[kind] ??= []).push({ line, dir });
    };
    tick('auto', [-1, 0]); tick('auto', [1, 0]); tick('auto', [0, 1]);
    tick('precise', [-1, 0]); tick('precise', [1, 0]);
    this.ring = el('circle', { cx: 0, cy: 0, r: 20, class: 'ring' }, this.groups.pattern);
    this.mRing = el('circle', { cx: 0, cy: 0, r: 20, class: 'ring thin' }, this.groups.marksman);
    this.launch = el('path', { d: '', class: 'bracket' }, this.groups.launcher);
    this.arc = el('path', { d: '', class: 'bracket' }, this.groups.thrown);
    this.dot = el('circle', { cx: 0, cy: 0, r: 1.6, class: 'dot' }, this.svg);
    this.wideRing = el('circle', { cx: 0, cy: 0, r: 80, class: 'wide-ring' }, this.svg);
    this.blocked = el('path', { d: 'M-5 -5L5 5M5 -5L-5 5', class: 'blocked' }, this.svg);
    this.state = { wide: false, kind: '', gap: -1, size: -1, aim: -1, color: '', visible: null, blocked: null, kick: -1 };
    this.size = 1;
    this.color = 'white';
    this.enabled = true;
    this._kick = 0;
    this._kickAt = 0;
  }

  setOptions({ visible, color, size } = {}) {
    if (visible !== undefined) this.enabled = !!visible;
    if (color !== undefined && COLORS[color]) this.color = color;
    if (size !== undefined && Number.isFinite(size)) this.size = Math.max(0.5, Math.min(2, size));
  }

  // Pulso de disparo: 2 px hacia fuera que se apagan en 90 ms. Es respuesta,
  // no dispersión (la dispersión real ya viene en spreadDeg).
  kick(reduced) { if (!reduced) { this._kick = 2; this._kickAt = performance.now(); } }

  // spreadDeg: semiángulo; fovDeg: FOV vertical de la cámara; maxGap: radio
  // de la zona de la retícula (nada se dibuja fuera de ella).
  draw({ weapon, def, spreadDeg = 0, aim = 0, aligned = false, show = true, blocked = false, fovDeg = 72, height = 720, maxGap = 60, dodging = false }) {
    const s = this.state;
    const visible = show && this.enabled;
    if (s.visible !== visible) { s.visible = visible; this.root.classList.toggle('on', visible); }
    if (!visible) return;
    const kind = reticleKind(weapon, def);
    if (s.kind !== kind) { s.kind = kind; this.root.dataset.kind = kind; }
    const color = COLORS[this.color];
    if (s.color !== color) { s.color = color; this.root.style.setProperty('--ret-color', color); }
    if (s.blocked !== !!blocked) { s.blocked = !!blocked; this.root.classList.toggle('blocked', !!blocked); }
    // ADS: las miras del arma hacen el trabajo → la retícula se retira; el
    // patrón de la escopeta sigue (el cono sigue importando apuntando).
    if (s.aligned !== aligned) { s.aligned = aligned; this.root.classList.toggle('aligned', aligned); }
    const a = Math.max(0, Math.min(1, aim));
    const aq = Math.round(a * 20) / 20;
    if (s.aim !== aq) { s.aim = aq; this.root.style.setProperty('--ret-aim', String(aq)); this.root.classList.toggle('ads', aq >= 0.6); }
    let kick = 0;
    if (this._kick) {
      const age = performance.now() - this._kickAt;
      kick = age >= 90 ? 0 : this._kick * (1 - age / 90);
      if (!kick) this._kick = 0;
    }
    const L = Math.round(6 * this.size * 2) / 2;
    const px = Math.tan(Math.max(0, spreadDeg) * RAD) / Math.tan(fovDeg * RAD / 2) * (height / 2);
    // Dos regímenes, nunca un tope silencioso:
    //  - el cono cabe en la zona central → la forma del arma a su radio real
    //    (separación mínima para no tapar el punto);
    //  - no cabe (escopeta de cadera deslizando, en el aire, FOV estrecho…) →
    //    la forma se retira y queda el punto + un círculo fino al radio REAL
    //    del cono, aunque cruce el resto del HUD: así nunca parece más cerrado.
    // Al abrirse el FOV el cono cabe un instante y al frenar vuelve a salir.
    // Conservamos el anillo durante el impulso, siempre con su radio real.
    const wide = px + kick > maxGap - L - 2 || (dodging && s.wide);
    const gap = Math.round((wide ? px : Math.max(3 + this.size * 2, px) + kick) * 2) / 2;
    if (s.wide !== wide) { s.wide = wide; this.root.classList.toggle('wide', wide); }
    this.trueGap = px;
    if (s.gap === gap && s.size === this.size) return;
    s.gap = gap; s.size = this.size;
    this.wideRing.setAttribute('r', gap);
    this.svg.style.setProperty('--ret-w', (1.6 * Math.sqrt(this.size)).toFixed(2));
    this.dot.setAttribute('r', (1.3 * Math.sqrt(this.size)).toFixed(2));
    for (const k of ['auto', 'precise']) {
      const len = k === 'precise' ? Math.max(3, L * 0.7) : L;
      for (const { line, dir } of this.ticks[k]) {
        line.setAttribute('x1', dir[0] * gap); line.setAttribute('y1', dir[1] * gap);
        line.setAttribute('x2', dir[0] * (gap + len)); line.setAttribute('y2', dir[1] * (gap + len));
      }
    }
    // anillo partido: cuatro arcos con huecos de 12° en las diagonales
    const r = Math.max(gap, 4);
    const c = 2 * Math.PI * r, hole = Math.min(c / 8, 12 * RAD * r);
    this.ring.setAttribute('r', r);
    this.ring.setAttribute('stroke-dasharray', `${(c / 4 - hole).toFixed(2)} ${hole.toFixed(2)}`);
    this.ring.setAttribute('stroke-dashoffset', (-(hole / 2) + c / 8).toFixed(2));
    this.mRing.setAttribute('r', r);
    const b = gap, w = L * 0.9;
    this.launch.setAttribute('d', `M${-w} ${b}V${b + L * 0.6}H${w}V${b}`);
    this.arc.setAttribute('d', `M${-w} ${-b}Q0 ${-b - L * 1.1} ${w} ${-b}`);
  }
}

export const RETICLE_COLORS = COLORS;
