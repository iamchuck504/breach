// El GLB aporta el PBR y la familia del acabado. El tinte de la frag y
// del emisor procede del mismo perfil que usa el viewmodel.
import { surfaceOf } from '../view/fp/material.js';
import { PROFILES } from '../view/fp/profiles.js';

export function weaponSurface(material, key) {
  const name = material.name.toLowerCase();
  const surface = surfaceOf(name, 'gun');
  surface.color = material.color.clone().lerp(surface.color, 0.25);
  surface.rough = material.roughness;
  surface.metal = material.metalness;
  if (surface.glow) surface.glow = material.emissiveIntensity;
  for (const [match, tint] of Object.entries(PROFILES[key].tint ?? {})) {
    if (!name.includes(match)) continue;
    surface.color.setRGB(...tint.slice(0, 3));
    surface.team = 0;
    surface.glow = tint[3] ?? surface.glow;
  }
  return surface;
}
