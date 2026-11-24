// En panorámico se reserva el cuerpo hasta el paso 1.15 del deslizador.
export function protectWeaponBody(width, height, scale) {
  return width / height >= 1.6 && scale <= 1.15;
}

export function zoneInPixels(rect, width, height) {
  return rect && { left: rect.x0 * width, right: rect.x1 * width,
    top: rect.y0 * height, bottom: rect.y1 * height };
}

// Radio de la zona de la retícula en píxeles CSS para una ventana dada.
// 9 % de la altura (≈65 px a 720p), nunca menos de 52 px.
export function reticleZoneRadius(height) {
  return Math.max(52, Math.round(height * 0.09));
}

// Escala efectiva: la del ajuste × el ajuste automático por tamaño de ventana
// (por debajo de 720 px de alto el HUD se reduce para no comerse la vista).
export function fitScale(width, height) {
  const k = height / 720;
  return k >= 1 ? 1 : Math.max(0.78, Math.round(k * 100) / 100);
}

// Rectángulo contra círculo (la zona de la retícula es redonda).
export function rectHitsCircle(rect, cx, cy, r) {
  const nx = Math.max(rect.left, Math.min(cx, rect.right));
  const ny = Math.max(rect.top, Math.min(cy, rect.bottom));
  return (nx - cx) ** 2 + (ny - cy) ** 2 < r * r;
}

export function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Clase de retícula por arma: decide la FORMA, no el tamaño (el tamaño es la
// dispersión real que llega en cada cuadro).
export function reticleKind(weaponKey, def) {
  if (!def) return 'auto';
  if (def.thrown) return 'thrown';
  if (weaponKey === 'sniper') return 'marksman';
  if ((def.pellets ?? 1) > 1) return 'pattern';
  if (def.projectile || def.projSpeed) return 'launcher';
  if (def.auto) return 'auto';
  return 'precise';
}
