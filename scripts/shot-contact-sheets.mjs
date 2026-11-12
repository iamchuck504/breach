// Agrupa las capturas de una carpeta en hojas de contacto (2×2) para
// revisarlas de un vistazo.  node scripts/shot-contact-sheets.mjs <carpeta>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const dir = path.resolve(process.argv[2]);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('sheet-')).sort();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1128 } });
for (let i = 0, n = 1; i < files.length; i += 4, n++) {
  const cells = files.slice(i, i + 4).map((f) => `<figure><img src="${encodeURI(f)}"><figcaption>${f}</figcaption></figure>`).join('');
  // archivo real junto a las capturas: una página en memoria no puede cargar file://
  const html = path.join(dir, '_sheet.html');
  fs.writeFileSync(html, `<style>body{margin:0;background:#222;display:grid;grid-template-columns:960px 960px;grid-auto-rows:564px;font:14px monospace;color:#fff}
    figure{margin:0;position:relative;background:#000}img{width:960px;height:540px;object-fit:contain;display:block}
    figcaption{height:24px;line-height:24px;padding-left:8px;background:#333}</style>${cells}`);
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15000 });
  fs.unlinkSync(html);
  await page.screenshot({ path: path.join(dir, `sheet-${String(n).padStart(2, '0')}.png`) });
}
await browser.close();
console.log(`${Math.ceil(files.length / 4)} hojas`);
