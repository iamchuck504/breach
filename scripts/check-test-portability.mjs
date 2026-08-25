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
assert.equal(pkg.scripts.pretest, 'npm run build',
  'npm test debe generar dist antes de iniciar los harness de navegador');
assert(!/npm run build/.test(pkg.scripts.verify),
  'verify no debe duplicar el build que ya ejecuta pretest');

console.log('TEST PORTABILITY OK · navegador portable · dist generado por npm test');
