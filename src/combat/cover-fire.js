// Contrato físico entre pose de cobertura y balística. La cámara decide la
// intención, pero el arma solo puede disparar cuando hombro, cañón y muzzle
// tienen una salida real de la geometría.

export function coverKind(face) {
  return face?.kind || (face?.h <= 1.4 ? 'low' : 'high');
}

export function coverTopY(face, playerY = 0) {
  // Los faces antiguos usan altura absoluta sobre el piso base. Las barandas
  // elevadas declaran topY explícito para no confundir altura táctica con Y.
  return Number.isFinite(face?.topY) ? face.topY
    : Number.isFinite(face?.baseY) ? face.baseY + face.h
      : playerY + (face?.h ?? 0);
}

export function coverAimPose(face, pitch, exposure = 1) {
  const kind = coverKind(face);
  const e = Math.max(0, Math.min(1, exposure));
  const down = Math.max(0, Math.min(1, -(pitch || 0) / 0.55));
  const railing = kind === 'railing' || kind === 'platform-edge';
  return {
    // Cubierto continúa profundo; ADS se acerca a altura de pie y expone
    // cabeza/torso. Apuntar abajo eleva los hombros un poco más.
    hipsY: 0.18 + ((railing ? 0.69 : 0.66) + down * (railing ? 0.20 : 0.18) - 0.18) * e,
    aimRigY: 0.5 + ((railing ? 0.09 : 0.11) + down * (railing ? 0.30 : 0.34)) * e,
    gunForward: (railing ? 0.10 : 0.16) * e,
    torsoLean: down * (railing ? 0.12 : 0.07) * e,
  };
}

export function coverBlindPose(face, pitch) {
  const kind = coverKind(face);
  const railing = kind === 'railing' || kind === 'platform-edge';
  const down = Math.max(0, Math.min(1, -(pitch || 0) / 0.55));
  return {
    hipsY: railing ? 0.44 : 0.42,
    aimRigY: 0.5 + down * (railing ? 0.50 : 0.46),
    gunForward: 0.08 + down * 0.08,
  };
}

function detailedHit(world, origin, dir, maxDist) {
  const detailed = world.raycastHit?.(origin, dir, maxDist);
  if (detailed) return detailed;
  const t = world.raycast(origin, dir, maxDist);
  return t !== null ? { t, collider: null } : null;
}

export function muzzleHasClearance(world, face, weaponRoot, muzzle, fireDir) {
  const barrel = muzzle.clone().sub(weaponRoot);
  const barrelLen = barrel.length();
  if (barrelLen > 0.001) {
    barrel.multiplyScalar(1 / barrelLen);
    const hit = detailedHit(world, weaponRoot, barrel, barrelLen - 0.025);
    if (hit) return false; // el modelo del arma atraviesa cover/geometría
  }

  // Una salida corta basta para detectar que el muzzle sigue detrás/dentro de
  // la cobertura. Obstáculos más lejanos son impactos válidos, no bloqueos del
  // gatillo: allí sí se consume munición y se muestra el decal correspondiente.
  const outHit = detailedHit(world, muzzle, fireDir, 0.32);
  if (!outHit) return true;
  return !!face?.collider && outHit.collider !== face.collider;
}

export function segmentsHaveClearance(world, segments) {
  for (const [from, to] of segments) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len <= 0.025) continue;
    dir.multiplyScalar(1 / len);
    if (detailedHit(world, from, dir, len - 0.02)) return false;
  }
  return true;
}
