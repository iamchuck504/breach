import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(root, 'scripts');
const files = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs'));
const offenders = [];

for (const name of files) {
  const source = readFileSync(path.join(scriptsDir, name), 'utf8');
  if (/Users[\\/]iamch|chromium-\d+[\\/]chrome-win64/i.test(source)) offenders.push(name);
}

assert.deepEqual(offenders, [],
  `scripts con navegador ligado a una PC específica: ${offenders.join(', ')}`);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.scripts.pretest.split('&&')[0].trim(), 'npm run build',
  'npm test debe generar dist antes de iniciar los harness de navegador');
assert(!/npm run build/.test(pkg.scripts.verify),
  'verify no debe duplicar el build que ya ejecuta pretest');

// Coherencia de las cadenas (PRUEBAS, corrida 6):
// - ninguna suite fija puerto (lib-test.mjs freePort): en esta máquina hay
//   huérfanos en puertos fijos y dos suites con el mismo número chocaban;
// - las suites de dev server leen BASE (with-dev-server levanta su propio Vite);
// - todo script registrado existe y ninguna suite está dos veces en `test`.
const fixedPort = [], noBase = [];
for (const name of files.filter((n) => n.startsWith('check-'))) {
  const source = readFileSync(path.join(scriptsDir, name), 'utf8');
  if (/\b(?:port|PORT)\s*=\s*['"]?\d{4}\b/.test(source) || /'--port',\s*'\d{4}'/.test(source)) fixedPort.push(name);
  if (/127\.0\.0\.1:5200/.test(source) && !/process\.env\.BASE|DEV_BASE/.test(source)) noBase.push(name);
}
assert.deepEqual(fixedPort, [], `suites con puerto fijo (usar freePort de lib-test.mjs): ${fixedPort.join(', ')}`);
assert.deepEqual(noBase, [], `suites de dev server sin BASE: ${noBase.join(', ')}`);
const referenced = new Set();
for (const v of Object.values(pkg.scripts)) for (const m of v.matchAll(/(check-[\w-]+)(?:\.mjs)?/g)) referenced.add(m[1]);
const missing = [...referenced].filter((n) => !files.includes(n + '.mjs'));
assert.deepEqual(missing, [], `package.json registra suites que no existen: ${missing.join(', ')}`);
const chain = pkg.scripts.test.split('&&').map((x) => x.trim());
const dup = chain.filter((x, i) => chain.indexOf(x) !== i);
assert.deepEqual(dup, [], `suites repetidas en npm test: ${dup.join(', ')}`);
for (const step of chain) {
  const m = step.match(/^npm run (\S+)$/);
  assert.ok(m && pkg.scripts[m[1]], `paso de npm test sin script: ${step}`);
}

console.log('TEST PORTABILITY OK · navegador portable · dist generado por npm test · puertos libres · cadenas coherentes');
