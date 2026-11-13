// Convierte SVG a PNG con el navegador sin ventana. Con dos SVG los pone lado
// a lado (misma escala) en una sola imagen: comparación antes/después.
//   node scripts/svg-to-png.mjs <salida.png> <a.svg> [b.svg]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { CHROME } from './lib-chrome.mjs';
import { clearClip } from './lib-clip.mjs';

const [out, ...inputs] = process.argv.slice(2);
const svgs = inputs.map((f) => fs.readFileSync(f, 'utf8'));
const size = (s) => [Number(/width="([\d.]+)"/.exec(s)[1]), Number(/height="([\d.]+)"/.exec(s)[1])];
const dims = svgs.map(size);
const W = dims.reduce((a, d) => a + d[0], 0) + (svgs.length - 1) * 8, H = Math.max(...dims.map((d) => d[1]));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: Math.ceil(W), height: Math.ceil(H) } });
  await page.setContent(`<body style="margin:0;background:#000;display:flex;gap:8px">${svgs.join('')}</body>`);
  await page.screenshot({ path: out });
} finally { await browser.close(); await clearClip(); }
console.log(out);
