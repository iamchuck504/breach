// CALIDAD AUTOMÁTICA. Dos piezas:
//  1. initialQuality(): nivel de arranque según el equipo (nombre de la GPU,
//     núcleos, memoria, pantalla táctil). Antes todo escritorio con GPU real
//     arrancaba en 'high', también un portátil con gráficos integrados.
//  2. AutoQuality: mide los cuadros reales mientras se juega y, si se
//     sostienen por debajo del umbral, baja un escalón (efectos primero,
//     resolución interna después). Solo baja: subir con v-sync no se puede
//     medir sin provocar justo los tirones que se quieren evitar. El nivel
//     alcanzado se recuerda una semana y luego se vuelve a probar.
// Módulo puro (sin three ni DOM) para poder probarlo en Node.

// De más caro a más barato. scale multiplica la resolución interna.
export const AUTO_STEPS = Object.freeze([
  { quality: 'high', scale: 1 },
  { quality: 'medium', scale: 1 },
  { quality: 'low', scale: 1 },
  { quality: 'low', scale: 0.75 },
  { quality: 'off', scale: 0.75 },
  { quality: 'off', scale: 0.5 },
]);
const stepOf = (quality) => Math.max(0, AUTO_STEPS.findIndex((s) => s.quality === quality));

const SOFTWARE = /swiftshader|llvmpipe|software|basic render/;
// integradas antiguas o de gama baja y móviles modestos
const WEAK = /intel[^,]*\b(u?hd graphics|gma|iris plus|iris(?! xe)\b)|mali|adreno ?[1-5]\d\d|powervr|videocore|radeon (r[2-7]\b|hd [2-8]\d{3})|geforce (gt\b|[2-9]\d{2}m?\b|mx ?1\d\d)|apple a\d/;
// integradas modernas y dedicadas de entrada
const MID = /intel[^,]*\b(iris xe|arc)|radeon[^,]*(vega|graphics|rx 5[5-6]0)|adreno ?[6-7]\d\d|geforce (gtx (9\d\d|10[0-5]0)|mx ?[2-5]\d\d)|apple m1\b/;

// info: { gpu, cores, memoryGb, coarse }
export function initialQuality({ gpu = '', cores = 0, memoryGb = 0, coarse = false } = {}) {
  const name = String(gpu).toLowerCase().replace(/[(](r|tm)[)]/g, '');
  if (SOFTWARE.test(name)) return 'off';
  let level = WEAK.test(name) ? 'low' : MID.test(name) ? 'medium' : 'high';
  const cap = (max) => { if (stepOf(level) < stepOf(max)) level = max; };
  if (coarse) cap('medium');                           // táctil / móvil
  if ((cores && cores <= 4) || (memoryGb && memoryGb <= 4)) cap('medium');
  if (cores && cores <= 2) cap('low');
  return level;
}

export class AutoQuality {
  // start: nivel de arranque; storage: localStorage o equivalente (opcional)
  constructor({ start = 'high', storage = null, now = () => Date.now(),
    lowFps = 42, windowSec = 2, strikes = 3, settleSec = 5, rememberMs = 7 * 864e5 } = {}) {
    this.storage = storage; this.now = now;
    this.lowFps = lowFps; this.windowSec = windowSec; this.strikes = strikes;
    this.settleSec = settleSec; this.rememberMs = rememberMs;
    this.startStep = stepOf(start);
    this.step = this.startStep;
    try {
      const saved = JSON.parse(storage?.getItem('breach.video.auto') || 'null');
      // lo recordado solo vale si es más barato que el arranque y reciente
      if (saved && Number.isInteger(saved.step) && saved.step > this.startStep &&
          saved.step < AUTO_STEPS.length && now() - saved.at < rememberMs) this.step = saved.step;
    } catch { /* almacenamiento ilegible: se arranca limpio */ }
    this._settle = settleSec; this._t = 0; this._n = 0; this._bad = 0;
    this.lastFps = 0;
  }
  get quality() { return AUTO_STEPS[this.step].quality; }
  get scale() { return AUTO_STEPS[this.step].scale; }
  get floor() { return this.step >= AUTO_STEPS.length - 1; }

  // Pausa la medición (carga de mapa, cambio de nivel: compilan sombreadores).
  settle(seconds = this.settleSec) { this._settle = Math.max(this._settle, seconds); this._t = 0; this._n = 0; this._bad = 0; }

  // Vuelve al nivel de arranque y olvida lo recordado.
  reset() {
    this.step = this.startStep;
    try { this.storage?.removeItem('breach.video.auto'); } catch { /* sin almacenamiento */ }
    this.settle();
  }

  // dt = segundos reales del cuadro. Devuelve true si acaba de bajar un escalón.
  sample(dt, visible = true) {
    if (!visible || !(dt > 0) || dt > 0.25) return false;   // pestaña oculta, tirón de carga
    if (this._settle > 0) { this._settle -= dt; return false; }
    this._t += dt; this._n++;
    if (this._t < this.windowSec) return false;
    const fps = this._n / this._t;
    this.lastFps = fps; this._t = 0; this._n = 0;
    this._bad = fps < this.lowFps ? this._bad + 1 : 0;
    if (this._bad < this.strikes || this.floor) return false;
    this.step++;
    try { this.storage?.setItem('breach.video.auto', JSON.stringify({ step: this.step, at: this.now() })); } catch { /* sin almacenamiento */ }
    this.settle();
    return true;
  }
}
