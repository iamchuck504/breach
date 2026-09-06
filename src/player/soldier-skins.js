import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Cosmetic only: five existing network variant IDs, one anatomy and one rig.
export const SOLDIER_SKINS = Object.freeze([
  {name:'Recruit'}, {name:'Sentinel'}, {name:'Scout'}, {name:'Heavy'}, {name:'Ghost'},
]);
const box=new RoundedBoxGeometry(1,1,1,1,.10);
const disc=new THREE.CylinderGeometry(1,1,1,12);
box.userData.shared=disc.userData.shared=true;

/** Details are attached to existing joints; no bone, socket or scale changes. */
export function attachSkinDetails(rig){
  const v=rig.variant,skin=SOLDIER_SKINS[v];
  rig.root.userData.skin=skin.name;
  if(v===0)return;
  // Reuse the Recruit's actual materials, including its roughness/emission.
  // No per-skin recolors: identity comes exclusively from attached geometry.
  const base=[];
  rig.root.traverse(o=>{if(o.userData.blenderSoldier)
    base.push(...(Array.isArray(o.material)?o.material:[o.material]));});
  const find=name=>base.find(m=>m.name.includes(name));
  const armor=find('slate ceramic'),metal=find('edge gunmetal');
  const dark=find('rubber seals'),ivory=find('unit markings');
  const team=find('team red armor'),light=find('helmet red LED');
  const detail=(parent,name,size,pos,mat=armor,geometry=box)=>{
    const o=new THREE.Mesh(geometry,mat);o.name=`${skin.name}: ${name}`;
    o.scale.set(...size);o.position.set(...pos);o.castShadow=o.receiveShadow=true;
    o.userData.blenderSoldier=true;o.userData.skinDetail=true;parent.add(o);return o;
  };
  const plate=(name,size,pos,mat=armor)=>detail(rig.head,name,size,pos,mat);
  const lens=(name,x,y,z,r=.035)=>{
    const housing=detail(rig.head,name,[r,r*.65,r],[x,y,z],dark,disc);
    housing.rotation.x=Math.PI/2;
    const glass=detail(rig.head,name+' glass',[r*.72,.009,r*.72],[x,y,z-r*.36],light,disc);
    glass.rotation.x=Math.PI/2;
  };
  if(v===1){
    // Sentinel: ballistic brow, temple guards and disciplined unit bars.
    plate('ballistic brow',[.48,.066,.045],[0,.335,-.294],armor);
    for(const x of [-.26,.26]){
      plate('temple reinforcement',[.075,.19,.16],[x,.275,-.14],armor);
      plate('temple team tab',[.025,.09,.018],[x,.27,-.225],team);
    }
    plate('chin guard',[.29,.052,.032],[0,.075,-.308],metal);
    detail(rig.torso,'chest guard',[.29,.085,.022],[0,.565,-.287],armor);
    for(let i=0;i<3;i++)detail(rig.torso,'rank bar',[.032,.044,.009],[-.05+i*.05,.565,-.303],team);
  }else if(v===2){
    // Scout: binocular rangefinder, tucked radio and field utility gear.
    plate('optic bridge',[.26,.098,.037],[0,.275,-.306],dark);
    lens('rangefinder right',.078,.28,-.337);lens('rangefinder left',-.078,.28,-.337);
    plate('radio receiver',[.046,.135,.088],[.31,.25,.065],dark);
    plate('short aerial',[.013,.12,.013],[.31,.38,.08],metal);
    const strap=detail(rig.torso,'utility webbing',[.037,.28,.014],[-.20,.49,-.286],dark);
    strap.rotation.z=-.12;
    detail(rig.torso,'radio panel',[.09,.12,.025],[.21,.55,-.28],dark);
    detail(rig.torso,'radio indicator',[.045,.013,.01],[.21,.575,-.3],light);
    detail(rig.torso,'field case',[.15,.11,.04],[-.19,.23,-.245],armor);
    detail(rig.torso,'case latch',[.035,.028,.012],[-.19,.23,-.27],metal);
  }else if(v===3){
    // Heavy: reinforced face protection, twin filters and ribbed torso armor.
    plate('brow reinforcement',[.49,.072,.06],[0,.338,-.292],metal);
    plate('respirator',[.25,.125,.053],[0,.115,-.292],dark);
    for(const x of [-.155,.155]){
      const filter=detail(rig.head,'filter housing',[.061,.043,.061],[x,.125,-.30],metal,disc);
      filter.rotation.x=Math.PI/2;
      for(let i=0;i<3;i++)plate('filter slot',[.064,.01,.012],[x,.103+i*.022,-.327],dark);
    }
    for(let i=0;i<3;i++)detail(rig.torso,'breastplate rib',[.30,.022,.022],[0,.51+i*.038,-.289],metal);
    for(const x of [-.23,.23])detail(rig.torso,'reinforcement lock',[.045,.08,.024],[x,.58,-.272],team);
  }else{
    // Ghost: dark shell, narrow split optics and a ceramic lower-face mask.
    plate('optic shroud',[.46,.105,.034],[0,.277,-.304],dark);
    for(const x of [-.105,.105])plate('narrow optic',[.145,.018,.013],[x,.284,-.327],light);
    plate('ceramic mask',[.28,.115,.035],[0,.14,-.311],metal);
    for(const x of [-.065,0,.065])plate('mask vent',[.014,.064,.008],[x,.134,-.333],dark);
    detail(rig.torso,'low profile chest panel',[.26,.10,.014],[0,.54,-.292],dark);
    for(const x of [-.035,.035]){
      const slash=detail(rig.torso,'unit slash',[.015,.064,.008],[x,.54,-.305],ivory);slash.rotation.z=-.35;
    }
    detail(rig.torso,'identification band',[.10,.023,.014],[.21,.61,-.269],team);
  }
  // Back-side identity remains readable behind a shouldered weapon.
  for(let i=0;i<=v;i++)detail(rig.torso,'dorsal unit stripe',[.028,.06,.012],[-.15+i*.042,.59,.425],team);
}
