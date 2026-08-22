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
