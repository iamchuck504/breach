import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
  const page=await browser.newPage({viewport:{width:1500,height:1100},deviceScaleFactor:1});
  const shops=['DAILY-BREAD','UNION-BARBER','SPIN-CYCLE','SIGNAL-ELECTRONICS','MOTOR-WORKS','PAPER---INK'];
  await page.setContent(`<style>body{margin:0;background:#101923;color:#ddd;font:18px Arial}main{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:12px}figure{margin:0}img{width:100%;display:block}figcaption{padding:8px}</style><main>${shops.map(s=>`<figure><img src="http://127.0.0.1:5200/artifacts/calle2/shop-${s}.png"><figcaption>${s.replaceAll('-',' ')}</figcaption></figure>`).join('')}</main>`);
  await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())));
  await page.screenshot({path:'artifacts/calle2/district-gallery.png',fullPage:true});
}finally{await browser.close();}
