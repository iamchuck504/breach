import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';import {chromium} from 'playwright-core';import {CHROME} from './lib-chrome.mjs';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','8845'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,1000));const browser=await chromium.launch({executablePath:CHROME,headless:true});
const dir='artifacts/visual-ux/ui';await fs.mkdir(dir,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8845/?nolock=1');await page.screenshot({path:`${dir}/splash.png`});
 await page.locator('#btn-enter').click();await page.waitForSelector('#splash.off',{state:'attached'});
 await page.screenshot({path:`${dir}/main.png`});
 // Exercise implemented navigation before the localisation layout matrix.
 await page.locator('#btn-options').click();
 for(const tab of ['audio','video','language','controls']){
  await page.locator(`#btn-opt-${tab}`).click();await page.waitForTimeout(180);
  await page.screenshot({path:`${dir}/${tab}.png`});
  await page.locator(tab==='controls'?'#btn-back':`#btn-${tab}-back`).click();
 }
 await page.locator('#btn-options-back').click();await page.locator('#btn-bots').click();await page.waitForTimeout(200);
 await page.screenshot({path:`${dir}/lobby.png`});await page.locator('#btn-lobby-leave').click();
 const layouts=[];
 for(const [width,height] of [[1280,720],[1920,1080],[2560,1080],[800,600]]){
  await page.setViewportSize({width,height});
  for(const lang of ['en','es','pt','fr','ja','it','zh']){
   const issues=await page.evaluate(async(lang)=>{
    const {setLanguage}=await import('/src/core/i18n.js');setLanguage(lang);
    const out=[];
    for(const card of document.querySelectorAll('.menu-card')){
     if(card.id==='lobby-card')continue;
     const styles=[...document.querySelectorAll('.menu-card')].map(e=>[e,e.style.display]);
     for(const [e]of styles)e.style.display=e===card?'block':'none';
     const r=card.getBoundingClientRect();if(r.left<-.5||r.right>innerWidth+.5||card.scrollWidth>card.clientWidth+2)out.push(`${card.id}: overflow`);
     for(const [e,display]of styles)e.style.display=display;
    }return out;
   },lang);layouts.push({width,height,lang,issues});
  }
 }
 await page.setViewportSize({width:1280,height:720});
 const hud=await page.evaluate(async()=>{
  const {setLanguage}=await import('/src/core/i18n.js');setLanguage('en');
  const {HUD}=await import('/src/ui/hud.js');const {TUNING}=await import('/src/config/tuning.js');
  const h=window.qaHud=new HUD();h.show(true);h.showMenu(false);
  const w={cur:'smg',slots:['smg','shotgun','pistol','grenade'],state:{},get st(){return this.state[this.cur]},get def(){return TUNING.weapons[this.cur]}};
  for(const id of ['smg','shotgun','pistol','grenade','sniper','bazooka'])w.state[id]={mag:TUNING.weapons[id].mag,reserve:20};
  w.state.smg={mag:0,reserve:0};w.state.shotgun={mag:0,reserve:8};h.ammo(w);h.weaponWheel(w);h.score(12,9);
  window.qaWeapon=w;
  return {dry:document.querySelector('[data-slot="0"]').classList.contains('dry'),reload:document.querySelector('[data-slot="1"]').classList.contains('needs-reload')};
 });assert(hud.dry&&hud.reload);
 await page.waitForTimeout(100);await page.screenshot({path:`${dir}/hud-wheel.png`});
 await page.waitForTimeout(750);assert(!await page.locator('#weapon-wheel').evaluate(e=>e.classList.contains('on')||e.classList.contains('leaving')));
 await page.evaluate(()=>{qaWeapon.slots[0]='sniper';qaWeapon.cur='sniper';qaHud.ammo(qaWeapon);qaHud.weaponWheel(qaWeapon);});
 assert.equal(await page.locator('.wheel-sector[data-slot="0"]').getAttribute('data-weapon'),'sniper');
 await page.evaluate(()=>{qaWeapon.slots[0]='bazooka';qaWeapon.cur='bazooka';qaHud.ammo(qaWeapon);qaHud.weaponWheel(qaWeapon);});
 assert.equal(await page.locator('.wheel-sector[data-slot="0"]').getAttribute('data-weapon'),'bazooka');
 await page.evaluate(()=>{qaWeapon.slots[1]=null;qaHud.ammo(qaWeapon);qaHud.hideWeaponWheel(true);});
 assert(await page.locator('.wheel-sector[data-slot="1"]').evaluate(e=>e.classList.contains('unavailable')));
 await page.evaluate(()=>qaHud.spectator({name:'PLAYER TWO',respawn:'NEXT RESPAWN WAVE · 7s',controls:'← →',ready:false}));
 await page.screenshot({path:`${dir}/spectator.png`});
 await page.evaluate(()=>qaHud.spectator({name:'PLAYER TWO',respawn:'NEXT RESPAWN WAVE · 7s',controls:'← →',ready:true}));
 assert(await page.locator('.spec-respawn').evaluate(e=>e.classList.contains('ready')));
 for(const phase of ['intro','countdown','round-end','final-score','mvp']){
  await page.evaluate(phase=>{qaHud.spectator(null);qaHud.presentation({phase,title:'VICTORY',sub:'FORTRESS',count:3,red:2,blue:1,rows:[],mvp:{name:'PLAYER ONE',team:'red',kills:12,deaths:3,score:1200}});},phase);
  await page.screenshot({path:`${dir}/${phase}.png`});
 }
 await fs.writeFile(`${dir}/report.json`,JSON.stringify({layouts,errors},null,2));
 assert(layouts.every(x=>!x.issues.length),JSON.stringify(layouts.filter(x=>x.issues.length)));
 assert.deepEqual(errors,[]);console.log('VISUAL UX OK: 28 locale/viewport combinations, menus, HUD states, special slots, spectator and presentation.');
}finally{await browser.close();server.kill();}
