// Fórmulas de daño compartidas por cliente, bots y servidor. Mantenerlas aquí
// evita que una build online aplique números distintos a los que presenta el
// juego local.

export function damageFalloff(def, distance) {
  const start = Number(def?.falloffStart);
  const end = Number(def?.falloffEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;

  const min = Number.isFinite(def.falloffMin)
    ? Math.max(0, Math.min(1, Number(def.falloffMin)))
    : 0;
  if (distance <= start) return 1;
  if (distance >= end) return min;
  const t = (distance - start) / (end - start);
  return 1 - (1 - min) * t;
}

export function firearmDamage(def, distance, part = 'body', pellets = 1,
  damageScale = 1) {
  const count = Math.max(1, Math.min(def?.pellets || 1, Math.floor(pellets || 1)));
  const head = part === 'head' ? (def?.headMult ?? 1) : 1;
  return Math.max(0,
    (def?.dmg || 0) * damageFalloff(def, distance) * head * count * damageScale);
}

export function rocketSplashDamage(def, distance, selfDamage = false) {
  const radius = Math.max(0.001, def?.splashRadius || 0.001);
  const factor = Math.max(0.25, 1 - (Math.max(0, distance) / radius) * 0.75);
  return Math.max(0, (def?.dmg || 0) * factor * (selfDamage ? 0.7 : 1));
}
