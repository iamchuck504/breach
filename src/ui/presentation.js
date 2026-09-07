import {t,onLanguageChange} from '../core/i18n.js';

// Context lives beside actions, not inside buttons. No new gameplay options.
export function initMenuPresentation(){
 document.querySelector('#main-card .menu-grid > section').append(document.getElementById('server-field'));
 const keys={'btn-bots':'menu.botsSub','btn-practice':'menu.practiceSub','btn-online':'menu.multiplayerSub'};
 let active='menu.botsSub';const detail=document.getElementById('mode-detail');
 const refresh=()=>{if(detail){detail.removeAttribute('data-i18n');detail.textContent=t(active);}};
 for(const [id,key] of Object.entries(keys)){
  const button=document.getElementById(id);button.setAttribute('aria-describedby','mode-detail');
  for(const event of ['focus','pointerenter'])button.addEventListener(event,()=>{active=key;refresh();});
 }
 onLanguageChange(refresh);refresh();
}
export function updateMapPreview(map){
 const image=document.getElementById('map-preview');if(!image)return;
 if(['fortaleza','azoteas','calle','calle2'].includes(map))image.src=`${import.meta.env.BASE_URL}assets/ui/map-${map}.png`;
 else image.removeAttribute('src');
}
