// Imagen lateral generada por scripts/build-thirdperson-weapons.mjs.
const weapons = new Set(['smg', 'shotgun', 'pistol', 'sniper', 'bazooka', 'grenade', 'frag', 'stun']);
export const weaponIconMarkup = (weapon, extraClass = '') => {
  const key = weapons.has(weapon) ? weapon : 'smg';
  return `<svg class="weapon-glyph icon-${key} ${extraClass}" data-icon="${key}" viewBox="0 0 480 160" aria-hidden="true" focusable="false"><image href="${import.meta.env?.BASE_URL??'/'}assets/ui/${key}.png" width="480" height="160" /></svg>`;
};

// Glifos chicos para kill feed y confirmación de baja. Las armas usan su
// ilustración real; la patada (melee) y un origen desconocido no tienen
// arma, así que llevan un glifo vectorial propio en el mismo idioma visual.
const MELEE_GLYPH = `<svg class="weapon-glyph icon-melee" data-icon="melee" viewBox="0 0 480 160" aria-hidden="true" focusable="false"><g fill="currentColor"><path d="M176 18h70l6 64 52 22c22 9 34 24 34 42v4H170l-8-22 14-26z"/><path class="wi-accent" d="M168 132h170v14H168z"/></g><path d="M74 70h70M58 96h86M90 122h54" stroke="currentColor" stroke-width="10" stroke-linecap="round" opacity=".55"/></svg>`;
const GENERIC_GLYPH = `<svg class="weapon-glyph icon-generic" data-icon="generic" viewBox="0 0 480 160" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"><circle cx="240" cy="80" r="46"/><path d="M240 10v38M240 112v38M170 80h38M272 80h38"/></g></svg>`;
export const feedIconMarkup = (weapon) => {
  if (weapon === 'melee') return MELEE_GLYPH;
  if (!weapon) return GENERIC_GLYPH;
  return weaponIconMarkup(weapon, 'feed-glyph');
};
// Cabeza con mira: marca de headshot en feed y confirmación.
export const HEAD_GLYPH = `<svg class="head-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="2" fill="currentColor"/><path d="M10 0.8v4M10 15.2v4M0.8 10h4M15.2 10h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
