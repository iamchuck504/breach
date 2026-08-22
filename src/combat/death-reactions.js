// Reacciones de muerte derivadas únicamente de datos de impacto validados.
// Esta función se usa cuando el impacto YA resultó letal; no convierte un
// headshot no letal en desmembramiento por sí sola.
export function isSniperHeadshotDeath(ctxOrWeapon, part = null) {
  if (typeof ctxOrWeapon === 'string') {
    return ctxOrWeapon === 'sniper' && part === 'head';
  }
  const ctx = ctxOrWeapon || {};
  const matchesImpact = ctx.weapon === 'sniper' && ctx.part === 'head';
  // Un false explícito viene de la autoridad online y debe ganar. Contextos
  // locales/legados sin flag todavía pueden derivarse del arma + zona.
  if (Object.prototype.hasOwnProperty.call(ctx, 'sniperHeadshot')) {
    return ctx.sniperHeadshot === true && matchesImpact;
  }
  return matchesImpact;
}

// Clasificación compartida de una muerte explosiva. Solo se consulta una vez
// confirmado que el daño fue letal: un splash no letal nunca desmiembra.
// 2 = destrucción total, 1 = desmembramiento severo, 0 = muerte normal.
export function rocketDeathLevel(ctxOrWeapon, distance = null, damage = null,
  direct = false) {
  if (typeof ctxOrWeapon === 'string') {
    if (ctxOrWeapon !== 'bazooka') return 0;
    const dist = Number(distance);
    const dmg = Number(damage);
    if (direct || (Number.isFinite(dist) && dist <= 1.25 && dmg >= 80)) return 2;
    if (Number.isFinite(dist) && dist <= 2.4 && dmg >= 60) return 1;
    return 0;
  }
  const ctx = ctxOrWeapon || {};
  if (ctx.weapon !== 'bazooka') return 0;
  // Multiplayer entrega un nivel explícito calculado por el servidor. Un 0
  // explícito gana sobre cualquier dato cliente/legado.
  if (Object.prototype.hasOwnProperty.call(ctx, 'rocketDeathLevel')) {
    const level = Math.round(Number(ctx.rocketDeathLevel) || 0);
    return Math.max(0, Math.min(2, level));
  }
  return rocketDeathLevel(ctx.weapon, ctx.distance, ctx.damage, !!ctx.direct);
}

// El punto de impacto viaja por red como [x,y,z], mientras que las rutas
// locales conservan Vector3/objetos. Normalizar aquí evita ramas visuales
// distintas entre práctica, bots y multiplayer.
export function deathImpactPoint(ctx, fallback, headHeight = 1.52) {
  const p = ctx?.point;
  if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) {
    return { x: p[0], y: p[1], z: p[2] };
  }
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
    return { x: p.x, y: p.y, z: p.z };
  }
  return {
    x: fallback?.x ?? 0,
    y: (fallback?.y ?? 0) + headHeight,
    z: fallback?.z ?? 0,
  };
}
