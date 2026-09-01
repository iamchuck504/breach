// Resuelve el Chromium COMPLETO para las suites headless.
//
// MEDIDO 2026-08-31: playwright-core sin executablePath resuelve al
// "chromium headless shell" (instalado junto a chromium-1234), que
// throttlea requestAnimationFrame a ~3/s — el juego corre a 3fps y TODOS
// los timings de los harnesses se rompen (dive perdido, recargas que no
// arrancan, countdowns que exceden los waitForFunction). Los fallos
// aparecían y desaparecían según si la sesión de shell tenía CHROME_PATH
// exportado, y se atribuían por error a la suite o al cambio de turno.
//
// Regla: CHROME_PATH manda (override de CI); si no, el chromium-<rev>
// completo más nuevo de ms-playwright. Jamás el headless shell.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* sin ms-playwright: caer al default */ }
  return undefined;
}

export const CHROME = chromePath();
