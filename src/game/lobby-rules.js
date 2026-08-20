export const MAX_PLAYERS = 8;
export const TEAM_CAPACITY = 4;
export const MAPS = ['fortaleza', 'azoteas', 'calle', 'metro', 'prision', 'pueblo'];
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
