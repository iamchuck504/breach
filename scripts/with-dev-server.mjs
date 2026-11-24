// Corre suites que cargan el juego desde un dev server de Vite PROPIO, en un
// puerto libre, y se lo pasa a cada suite en `BASE` (p. ej.
// http://127.0.0.1:53114). Antes reutilizaba lo que hubiera en 5200: con
// varios árboles en la máquina eso podía probar OTRO árbol. Con `BASE` ya
// definido (servidor externo a propósito) lo usa tal cual.
// Se levanta en 127.0.0.1 (en macOS "localhost" puede resolver solo a ::1).
//
// Uso: node scripts/with-dev-server.mjs check-calle2 check-shop-recess ...
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './lib-test.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = process.argv.slice(2);
if (!names.length) {
  console.error('uso: node scripts/with-dev-server.mjs <check-nombre> [...]');
  process.exit(2);
}

async function up(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let vite = null;
let base = process.env.BASE;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  vite = spawn(process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  vite.stdout.on('data', (d) => { log += d; });
  vite.stderr.on('data', (d) => { log += d; });
  // sondeo hasta que responde (en CI el arranque en frío puede tardar)
  for (let i = 0; i < 600 && !(await up(base + '/')); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await up(base + '/'))) {
    vite.kill();
    console.error(`no se pudo levantar Vite en ${base}\n${log}`);
    process.exit(1);
  }
}

let code = 0;
try {
  for (const name of names) {
    const file = path.join('scripts', name.endsWith('.mjs') ? name : `${name}.mjs`);
    code = await run(process.execPath, [file], { ...process.env, BASE: base });
    if (code !== 0) break;
  }
} finally {
  vite?.kill();
}
process.exit(code);
