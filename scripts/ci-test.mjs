// CI: corre las mismas suites que `npm test` y `npm run test:dev`, pero cada
// suite que falla se reintenta UNA vez. Los runners de CI no tienen GPU real
// y sus frames duran cientos de ms: las suites de gameplay miden tiempos en
// reloj de pared y a veces fallan por el runner, no por el juego. Una
// regresión real falla dos veces; un tropiezo de timing pasa al reintento y
// queda reportado como inestable. En local, `npm test` sigue siendo estricto.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const runNpm = (name) =>
  spawnSync(npm, ['run', name], { cwd: root, stdio: 'inherit' }).status === 0;

// `npm test` = una cadena de `npm run check:x && ...`
const suites = scripts.test.split('&&').map((part) => {
  const m = part.trim().match(/^npm run (\S+)$/);
  if (!m) throw new Error(`paso de npm test no reconocido: ${part.trim()}`);
  return m[1];
});

if (!runNpm('pretest')) process.exit(1); // build + chequeos estáticos: sin reintento

const flaky = [], failed = [];
for (const name of [...suites, 'test:dev']) {
  if (runNpm(name)) continue;
  console.log(`\n::warning::${name} falló; reintentando una vez`);
  if (runNpm(name)) flaky.push(name);
  else failed.push(name);
}

console.log('\n==== CI TEST ====');
console.log(`suites: ${suites.length + 1} · inestables: ${flaky.length} · fallidas: ${failed.length}`);
if (flaky.length) console.log(`::warning::inestables (pasaron al reintento): ${flaky.join(', ')}`);
if (failed.length) {
  console.log(`::error::fallaron dos veces: ${failed.join(', ')}`);
  process.exit(1);
}
