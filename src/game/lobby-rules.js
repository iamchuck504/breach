export const MAX_PLAYERS = 8;
export const TEAM_CAPACITY = 4;
// Mapas aprobados para la build pública. Los layouts restantes se conservan
// en el proyecto para seguir trabajándolos, pero no aparecen en lobbies ni en
// la rotación automática hasta que estén listos.
export const MAPS = ['fortaleza', 'azoteas', 'calle2'];
// Datos de gameplay que deben coincidir entre cliente y servidor. Mantenerlos
// aquí evita que el mapa dibuje pickups en un sitio mientras la autoridad
// online los valida en otro.
export const MAP_RUNTIME = Object.freeze({
  fortaleza: Object.freeze({
    spawnZ: 23.4,
    // v2: las cajas salen de la línea central (quien tomaba el centro tenía
    // el arma especial y las dos cajas a 14 m) y van al pie de cada galería
    crates: Object.freeze([{ x: -16.5, z: -6.5 }, { x: 16.5, z: 6.5 }]),
    // equidistante por el suelo: 28.3 m desde cada spawn (analyze-map.mjs)
    special: Object.freeze({ x: 2.8, z: 0, y: 0 }),
  }),
  azoteas: Object.freeze({
    spawnZ: 35.1,
    // v2: fuera del eje central (ahí ya están el helipuerto y el arma
    // especial); cada caja queda en el flanco propio de un equipo
    crates: Object.freeze([{ x: -24.4, z: -18.6 }, { x: 24.4, z: 18.6 }]),
    special: Object.freeze({ x: 0, z: 0, y: 1.1 }),
  }),
  calle: Object.freeze({
    spawnZ: 38.4,
    crates: Object.freeze([{ x: -14, z: 0 }, { x: 14, z: 0 }]),
    special: Object.freeze({ x: 0, z: 0, y: 0 }),
  }),
  calle2: Object.freeze({
    spawnZ: 38.4,
    // v2: la munición vive en el centro de cada callejón lateral. La avenida
    // ya tiene el arma especial; los callejones eran un rodeo sin premio.
    crates: Object.freeze([{ x: -26.4, z: 0 }, { x: 26.4, z: 0 }]),
    special: Object.freeze({ x: 0, z: 0, y: 0 }),
  }),
  metro: Object.freeze({
    spawnZ: 22.4,
    crates: Object.freeze([{ x: -8, z: 0 }, { x: 8, z: 0 }]),
    special: Object.freeze({ x: 0, z: 0, y: 0 }),
  }),
  prision: Object.freeze({
    spawnZ: 26.4,
    crates: Object.freeze([{ x: -17.5, z: -2 }, { x: 17.5, z: 2 }]),
    special: Object.freeze({ x: 9, z: 0, y: 0 }),
  }),
  pueblo: Object.freeze({
    spawnZ: 30.4,
    crates: Object.freeze([{ x: 12, z: -20 }, { x: -12, z: 20 }]),
    special: Object.freeze({ x: 7.5, z: 0, y: 0 }),
  }),
});
export const ROUND_OPTIONS = [1, 3, 5];
export const LIFE_OPTIONS = [8, 12, 15, 20];
export const POST_MATCH_OPTIONS = ['lobby', 'next-map'];

export const DEFAULT_LOBBY_SETTINGS = Object.freeze({
  mode: 'tdm',
  map: 'fortaleza',
  rounds: 3,
  lives: 15,
  postMatch: 'lobby',
  // Online: los lugares vacíos se rellenan con bots, un jugador que entra
  // toma el lugar de un bot y uno que sale deja un bot en el suyo.
  fillBots: true,
});

// Los mapas del editor viven en el cliente ('custom:<id>'). El lobby LOCAL
// los acepta; online sigue restringido a los mapas que el servidor conoce.
export const isCustomMapId = (id) => typeof id === 'string' && id.startsWith('custom:');

export function normalizeLobbySettings(value = {}, { allowCustom = false } = {}) {
  // Old saved street selections now open the retained expanded map.
  if(value.map==='calle')value={...value,map:'calle2'};
  const rounds = Number(value.rounds);
  const lives = Number(value.lives);
  const mapOk = MAPS.includes(value.map) || (allowCustom && isCustomMapId(value.map));
  return {
    mode: 'tdm',
    map: mapOk ? value.map : DEFAULT_LOBBY_SETTINGS.map,
    rounds: ROUND_OPTIONS.includes(rounds) ? rounds : DEFAULT_LOBBY_SETTINGS.rounds,
    lives: LIFE_OPTIONS.includes(lives) ? lives : DEFAULT_LOBBY_SETTINGS.lives,
    postMatch: POST_MATCH_OPTIONS.includes(value.postMatch)
      ? value.postMatch : DEFAULT_LOBBY_SETTINGS.postMatch,
    fillBots: typeof value.fillBots === 'boolean' ? value.fillBots : DEFAULT_LOBBY_SETTINGS.fillBots,
  };
}

export function nextLobbyMap(map) {
  const i = MAPS.indexOf(map);
  return MAPS[(i + 1 + MAPS.length) % MAPS.length];
}

export function teamCounts(slots = []) {
  const out = { red: 0, blue: 0 };
  for (const slot of slots) if (slot && (slot.team === 'red' || slot.team === 'blue')) out[slot.team]++;
  return out;
}

export function validateLobby(slots = [], settings = DEFAULT_LOBBY_SETTINGS) {
  const errors = [];
  const counts = teamCounts(slots);
  if (!slots.length) errors.push('empty');
  if (slots.length > MAX_PLAYERS) errors.push('too-many-players');
  if (counts.red > TEAM_CAPACITY) errors.push('red-full');
  if (counts.blue > TEAM_CAPACITY) errors.push('blue-full');
  if (slots.some((slot) => slot.team !== 'red' && slot.team !== 'blue')) errors.push('unassigned-team');
  if (counts.red < 1 || counts.blue < 1) errors.push('team-empty');
  if (counts.red !== counts.blue) errors.push('teams-unbalanced');
  if (settings.lives < Math.max(counts.red, counts.blue)) errors.push('not-enough-lives');
  return { ok: errors.length === 0, errors, counts, open: {
    red: TEAM_CAPACITY - counts.red,
    blue: TEAM_CAPACITY - counts.blue,
    total: MAX_PLAYERS - slots.length,
  } };
}

export function makeBotName(team, occupied = []) {
  const names = team === 'red'
    ? ['REX', 'VOLT', 'JAZZ', 'EMBER']
    : ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'];
  return names.find((name) => !occupied.includes(name)) || `BOT ${occupied.length + 1}`;
}
