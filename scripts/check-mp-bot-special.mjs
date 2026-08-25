// Host con un bot real de lobby: el bot reclama la especial a través del
// servidor y solo la equipa después del broadcast autoritativo.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8800;
const chrome = process.env.CHROME_PATH || undefined;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port), INTRO_TIME: '1', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 700));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, port);
  await page.evaluate(() => document.getElementById('btn-lobby-create').click());
  await page.waitForFunction(() => window.BREACH?.net?.connected && window.BREACH?.lobby?.hostId);
  await page.evaluate(() => window.BREACH.net.lobbyAddBot('blue'));
  await page.waitForFunction(() => window.BREACH?.lobby?.bots?.length === 1);
  await page.evaluate(() => window.BREACH.net.lobbyStart());
  await page.waitForFunction(() => window.BREACH?.mode === 'online' &&
    window.BREACH?.onlinePhase === 'playing' && window.BREACH?.onlineBots?.bots?.length, null,
  { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const G = window.BREACH, M = G.onlineBots, S = window.BREACH_SPECIALS;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const bot = M.bots[0], spot = window.BREACH_WORLD.specialSpot;
    bot.pos.x = spot.x; bot.pos.z = spot.z; bot.y = 0;
    G.net.botState([bot]);
    await wait(150);
    M.botTakeSpecial(bot);
    await wait(500);
    return {
      wep: bot.wep, ammo: bot.specialAmmo, pedestal: !!S.active,
      serverPhase: G.onlinePhase,
    };
  });
  const ok = result.wep === 'sniper' && result.ammo === 6 && !result.pedestal && errors.length === 0;
  console.log(`${ok ? 'MP BOT SPECIAL OK' : 'MP BOT SPECIAL FAIL'} — ${JSON.stringify({ ...result, errors })}`);
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}
