export const MAX_PLAYERS = 8;
export const TEAM_CAPACITY = 4;
export const MAPS = ['fortaleza', 'azoteas', 'calle', 'metro', 'prision', 'pueblo'];
// Datos de gameplay que deben coincidir entre cliente y servidor. Mantenerlos
// aquí evita que el mapa dibuje pickups en un sitio mientras la autoridad
// online los valida en otro.
export const MAP_RUNTIME = Object.freeze({
  fortaleza: Object.freeze({
    spawnZ: 23.4,
    crates: Object.freeze([{ x: 7, z: 0 }, { x: -7, z: 0 }]),
    special: Object.freeze({ x: 2.8, z: 0, y: 0 }),
  }),
  azoteas: Object.freeze({
    spawnZ: 35.1,
    crates: Object.freeze([{ x: 0, z: -12.1 }, { x: 0, z: 12.1 }]),
    special: Object.freeze({ x: 0, z: 0, y: 1.1 }),
  }),
  calle: Object.freeze({
    spawnZ: 26.4,
    crates: Object.freeze([{ x: -14, z: 0 }, { x: 14, z: 0 }]),
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
});

export function normalizeLobbySettings(value = {}) {
  const rounds = Number(value.rounds);
  const lives = Number(value.lives);
  return {
    mode: 'tdm',
    map: MAPS.includes(value.map) ? value.map : DEFAULT_LOBBY_SETTINGS.map,
    rounds: ROUND_OPTIONS.includes(rounds) ? rounds : DEFAULT_LOBBY_SETTINGS.rounds,
    lives: LIFE_OPTIONS.includes(lives) ? lives : DEFAULT_LOBBY_SETTINGS.lives,
    postMatch: POST_MATCH_OPTIONS.includes(value.postMatch)
      ? value.postMatch : DEFAULT_LOBBY_SETTINGS.postMatch,
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
