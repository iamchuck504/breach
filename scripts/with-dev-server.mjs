// Corre suites que cargan el juego desde el dev server de Vite
// (http://127.0.0.1:5200). Si ya hay uno escuchando lo reutiliza; si no, lo
// levanta en 127.0.0.1 (en macOS "localhost" puede resolver solo a ::1 y las
// suites apuntan a 127.0.0.1) y lo apaga al terminar.
//
// Uso: node scripts/with-dev-server.mjs check-calle2 check-shop-recess ...
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'http://127.0.0.1:5200/';
const names = process.argv.slice(2);
if (!names.length) {
  console.error('uso: node scripts/with-dev-server.mjs <check-nombre> [...]');
  process.exit(2);
}

async function up() {
  try { return (await fetch(URL)).ok; } catch { return false; }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let vite = null;
if (!(await up())) {
  vite = spawn(process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5200', '--strictPort', '--host', '127.0.0.1'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  vite.stdout.on('data', (d) => { log += d; });
  vite.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await up())) {
    vite.kill();
    console.error(`no se pudo levantar Vite en ${URL}\n${log}`);
    process.exit(1);
  }
}

let code = 0;
try {
  for (const name of names) {
    const file = path.join('scripts', name.endsWith('.mjs') ? name : `${name}.mjs`);
    code = await run(process.execPath, [file]);
    if (code !== 0) break;
  }
} finally {
  vite?.kill();
}
process.exit(code);
