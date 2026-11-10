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
// completo más nuevo de ms-playwright (Windows, macOS o Linux). Jamás el
// headless shell. Instalarlo: `npx playwright-core install chromium`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function browsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

// Rutas del ejecutable dentro de chromium-<rev>/ según plataforma y versión
// de Playwright (Chromium clásico o "Chrome for Testing").
function candidates(dir) {
  if (process.platform === 'win32') {
    return [path.join(dir, 'chrome-win64', 'chrome.exe'), path.join(dir, 'chrome-win', 'chrome.exe')];
  }
  if (process.platform === 'darwin') {
    return ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap((sub) => [
      path.join(dir, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(dir, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    ]);
  }
  return [path.join(dir, 'chrome-linux64', 'chrome'), path.join(dir, 'chrome-linux', 'chrome')];
}

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = browsersDir();
  try {
    const dirs = fs.readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const exe of candidates(path.join(base, d))) if (fs.existsSync(exe)) return exe;
    }
  } catch { /* sin ms-playwright: caer al default */ }
  return undefined;
}

export const CHROME = chromePath();
