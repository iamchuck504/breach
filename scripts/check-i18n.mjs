import assert from 'node:assert/strict';
import { LANGUAGES, setLanguage, t, translationAudit } from '../src/core/i18n.js';

const expected = ['en', 'es', 'pt', 'fr', 'ja', 'it', 'zh'];
assert.deepEqual(LANGUAGES.map(({ code }) => code), expected, 'lista de idiomas inesperada');

for (const [code, missing] of Object.entries(translationAudit())) {
  assert.deepEqual(missing, [], `${code} tiene claves ausentes: ${missing.join(', ')}`);
}

for (const code of expected) {
  setLanguage(code);
  const samples = [
    'common.play', 'menu.language', 'menu.run', 'hud.scoreboard', 'hud.spectating',
    'weapon.smg', 'weapon.shotgun', 'mode.teamDeathmatch', 'flow.victory',
    'spectator.noTeammates', 'binding.sprint', 'msg.spawnProtection',
  ];
  for (const key of samples) assert.notEqual(t(key), key, `${code} no resuelve ${key}`);
  const visible = samples.map((key) => t(key)).join(' ');
  assert.doesNotMatch(visible, /roadie|gears of war/i, `${code} conserva terminología ajena`);
}

setLanguage('en');
console.log(`I18N OK · ${expected.length} idiomas · English default · terminología neutral`);
