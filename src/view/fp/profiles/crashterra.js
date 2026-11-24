// Curvas de view.ts, vulcan.ts, vesper.ts y reaper.ts. Se evalúan en el
// reloj de la acción de Breach, también al interrumpirla o cambiar de arma.
const segment = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
const smooth = (u, a, b) => {
  const t = segment(u, a, b);
  return t * t * (3 - 2 * t);
};

function scaled(out, v, k) {
  for (let i = 0; i < v.length; i++) out[i] = k * v[i];
  return out;
}

const equip = [0.04, -0.30, 0.06, -1, -0.15, 0.45];
export function equipPose(u, out) {
  const e = Math.min(1, Math.abs(2 * u - 1));
  return scaled(out, equip, (1 - e) ** 2 * (1 + 0.6 * e));
}

// Inclinación del rifle para que se lea el recorrido de la mano sobre el cerrojo.
const rifle = [.01, .004, -.04, -.12, .31, .53];
const reloadTilt = u => smooth(u, 0, 0.12) * (1 - smooth(u, 0.82, 1));
export function sniperReload(u, out) {
  return scaled(out, rifle, reloadTilt(u));
}

// La derecha presenta el brocal de costado y cede al extraer el cargador.
const smgReloadPose = [0, .01, -.015, .285, .55, -.44];
export function smgReload(u, out) {
  scaled(out, smgReloadPose, smooth(u, 0, 0.12) * (1 - smooth(u, 0.77, 0.97)));
  const tiron = smooth(u, .15, .27) * (1 - smooth(u, .27, .43));
  out[3] -= .065 * tiron;
  out[5] += .085 * tiron;
  // El arma acusa el golpe de la palma en la base del cargador ya encajado.
  out[1] += .006 * smooth(u, .72, .75) * (1 - smooth(u, .75, .79));
  return out;
}

// El tubo descansa en el hombro. Con el mismo ritmo de la VULCAN, la
// boca queda al alcance del guante y el codo permanece bajo la pantalla.
const launcher = [0.014, -0.012, -0.025, -0.035, -0.06, -0.18];
export function launcherReload(u, out) {
  return scaled(out, launcher, reloadTilt(u));
}

const vesper = [.056, .008, -.059, .02, .10, -.45];
export function vesperReload(u, out) {
  return scaled(out, vesper, smooth(u, 0, 0.15) * (1 - smooth(u, 0.80, 1)));
}

// La izquierda mantiene la pinza hasta asentar el cargador con la palma.
export function vulcanHand(u, out) {
  const mag = smooth(u, 0.025, 0.1065) * (1 - smooth(u, 0.76, 0.91));
  out.fill(0);
  out[0] = 1 - mag;
  out[1] = mag;
  return out;
}

// Sale por la guía, baja hacia la bolsa y vuelve por su izquierda.
// El cambio de cargador ocurre bajo el borde inferior.
export function vulcanTravel(u, out) {
  const baja = smooth(u, .178, .415);
  const sube = smooth(u, .35, .585);
  const palma = smooth(u, .64, .70) * (1 - smooth(u, .70, .75));
  out[0] = -.85 * smooth(u, .32, .43) * (1 - smooth(u, .48, .56)) - .10 * palma;
  out[1] = -.75 * (baja - sube) - .065 * palma;
  out[2] = 0;
  return out;
}

export function reaperPump(u, out) {
  out[0] = smooth(u, 0, 0.38) * (1 - smooth(u, 0.50, 0.85));
  return out;
}

export function reaperCycle(u, out) {
  const k = Math.sin(Math.PI * segment(u, 0, 0.9));
  out.fill(0);
  out[3] = -0.06 * k;
  out[5] = 0.05 * k;
  return out;
}

// El primer cartucho parte de la bomba. Los siguientes enlazan el final
// del empuje anterior con la toma de otro cartucho del soporte lateral.
export function reaperShellHand(first) {
  return (u, out) => {
    const take = smooth(u, 0, first ? 0.18 : 0.25);
    const seat = smooth(u, 0.72, 0.98);
    out.fill(0);
    out[first ? 0 : 1] = 1 - take;
    out[2] = take * (1 - seat);
    out[1] += take * seat;
    return out;
  };
}

export function reaperTravel(unitsPerMetre, arranque = unitsPerMetre) {
  return (u, out) => {
    const dip = smooth(u, 0, 0.32) * (1 - smooth(u, 0.32, 0.72));
    const approach = 1 - smooth(u, 0.72, 0.98);
    // Al soltar el cartucho anterior, los dedos libran primero el labio de la ventana.
    const escala = unitsPerMetre + (arranque - unitsPerMetre) * (1 - smooth(u, .12, .30));
    out[0] = (-0.03 * approach - 0.08 * dip) * escala;
    out[1] = -0.30 * dip * escala;
    out[2] = 0;
    return out;
  };
}

// Desplazamiento de la muñeca en milímetros físicos. Cada paso empieza y
// termina con velocidad nula para enlazar la pinza con sus apoyos rígidos.
export function pasoDeMuneca(claves) {
  return (u, out) => {
    const i = claves.findIndex(c => c[0] >= u);
    if (i <= 0) {
      out.fill(0, 0, 3);
      return out;
    }
    const a = claves[i - 1], b = claves[i];
    const t = (u - a[0]) / (b[0] - a[0]);
    const peso = t * t * (3 - 2 * t);
    for (let j = 0; j < 3; j++) out[j] = a[j + 1] + peso * (b[j + 1] - a[j + 1]);
    return out;
  };
}
