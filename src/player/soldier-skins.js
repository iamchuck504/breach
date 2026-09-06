import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Cosmetic only: five existing network variant IDs, one anatomy and one rig.
export const SOLDIER_SKINS = Object.freeze([
  {name:'Recruit'}, {name:'Sentinel'}, {name:'Scout'}, {name:'Heavy'}, {name:'Ghost'},
]);
const box=new RoundedBoxGeometry(1,1,1,1,.10);
const disc=new THREE.CylinderGeometry(1,1,1,12);
box.userData.shared=disc.userData.shared=true;
const faceShape=new THREE.Shape();
faceShape.moveTo(-.5,.32);faceShape.lineTo(-.32,.5);faceShape.lineTo(.32,.5);
faceShape.lineTo(.5,.32);faceShape.lineTo(.38,-.22);faceShape.lineTo(0,-.5);
faceShape.lineTo(-.38,-.22);faceShape.closePath();
const shield=new THREE.ExtrudeGeometry(faceShape,{depth:1,steps:1,bevelEnabled:false});
shield.translate(0,0,-.5);shield.userData.shared=true;

/** Details are attached to existing joints; no bone, socket or scale changes. */
export function attachSkinDetails(rig){
  const v=rig.variant,skin=SOLDIER_SKINS[v];
  rig.root.userData.skin=skin.name;
  // Reuse the Recruit's actual materials, including its roughness/emission.
  // No per-skin recolors: identity comes exclusively from attached geometry.
  const base=[];
  rig.root.traverse(o=>{if(o.userData.blenderSoldier)
    base.push(...(Array.isArray(o.material)?o.material:[o.material]));});
  const find=name=>base.find(m=>m.name.includes(name));
  const armor=find('slate ceramic'),metal=find('edge gunmetal');
  const dark=find('rubber seals'),ivory=find('unit markings');
  const team=find('team red armor'),light=find('helmet red LED');
  // Replace armor shells, not anatomy: the same head/shoulder joints and
  // collision volumes drive every variant. No more identical helmet + decals.
  if(v!==0)rig.head.traverse(o=>{if(o.isMesh&&o.userData.blenderSoldier){
    o.visible=false;o.userData.blenderSourceHidden=true;
  }});
  if(v!==0)for(const arm of [rig.armL,rig.armR])arm.shoulder.traverse(o=>{
    if(o.name.startsWith('segment_pauldron')){o.visible=false;o.userData.blenderSourceHidden=true;}
  });
  const detail=(parent,name,size,pos,mat=armor,geometry=box)=>{
    const o=new THREE.Mesh(geometry,mat);o.name=`${skin.name}: ${name}`;
    o.scale.set(...size);o.position.set(...pos);o.castShadow=o.receiveShadow=true;
    o.userData.blenderSoldier=true;o.userData.skinDetail=true;parent.add(o);return o;
  };
  const plate=(name,size,pos,mat=armor)=>detail(rig.head,name,size,pos,mat);
  const lens=(name,x,y,z,r=.035)=>{
    const housing=detail(rig.head,name,[r,r*.65,r],[x,y,z],metal,disc);
    housing.rotation.x=Math.PI/2;
    const glass=detail(rig.head,name+' glass',[r*.79,.009,r*.79],[x,y,z-r*.36],dark,disc);
    glass.rotation.x=Math.PI/2;
    const core=detail(rig.head,name+' sensor',[r*.34,.01,r*.34],[x,y,z-r*.43],light,disc);
    core.rotation.x=Math.PI/2;
  };
  const shoulder=(side,size,pos,mat=team,angle=0)=>{
    const arm=side===1?rig.armR:rig.armL;
    const o=detail(arm.shoulder,'shoulder shell',size,[pos[0]*side,pos[1],pos[2]],mat);
    o.rotation.z=angle*side;return o;
  };
  const fastener=(x,y,z)=>{
    const o=detail(rig.head,'recessed fastener',[.010,.006,.010],[x,y,z],metal,disc);
    o.rotation.x=Math.PI/2;
    plate('fastener slot',[.010,.0025,.003],[x,y,z-.005],dark);
  };
  const grille=(name,x,y,z,w,h,rows=3)=>{
    plate(name+' gasket',[w+.018,h+.018,.012],[x,y,z+.006],dark);
    plate(name+' frame',[w,h,.011],[x,y,z],metal);
    for(let i=0;i<rows;i++)plate(name+' louver',[w*.78,h/(rows*2.5),.008],
      [x,y+h*.32-i*h*.64/Math.max(1,rows-1),z-.009],dark);
  };
  if(v===0){
    // Keep the original face and add a restrained service panel on the mask.
    grille('mouth intake',0,.145,-.32,.115,.040,3);
    for(const side of [-1,1]){
      fastener(side*.115,.12,-.314);
      plate('cheek gasket',[.012,.055,.008],[side*.15,.165,-.286],dark);
    }
    return;
  }
  // Compact neck gasket is common; the external helmet varies substantially.
  plate('neck seal',[.26,.07,.24],[0,.065,.015],dark);
  if(v===1){
    // Sentinel: enclosed riot helmet with a T visor and angular crest.
    plate('riot shell',[.56,.35,.48],[0,.28,-.005],armor);
    plate('face shield',[.44,.28,.055],[0,.245,-.259],metal);
    plate('T visor crossbar',[.38,.068,.017],[0,.30,-.294],dark);
    plate('T visor stem',[.066,.15,.019],[0,.205,-.295],dark);
    for(const x of [-.113,.113])plate('visor light',[.14,.016,.012],[x,.303,-.307],light);
    plate('center crest',[.075,.036,.34],[0,.471,-.015],team);
    for(const x of [-.19,.19])plate('cheek rail',[.024,.13,.016],[x,.193,-.298],armor);
    plate('ballistic brow',[.50,.054,.067],[0,.366,-.25],armor);
    for(const x of [-.26,.26]){
      plate('temple reinforcement',[.09,.25,.19],[x,.235,-.12],armor);
      plate('temple team tab',[.025,.09,.018],[x,.27,-.225],team);
    }
    plate('chin guard',[.29,.052,.032],[0,.075,-.308],metal);
    for(const side of [-1,1]){
      grille('cheek intake',side*.112,.187,-.30,.076,.074,4);
      fastener(side*.184,.342,-.296);
      plate('visor hinge',[.040,.038,.027],[side*.259,.313,-.226],metal);
    }
    plate('chin seam',[.19,.009,.008],[0,.073,-.328],dark);
    detail(rig.torso,'chest guard',[.29,.085,.022],[0,.565,-.287],armor);
    for(let i=0;i<3;i++)detail(rig.torso,'rank bar',[.032,.044,.009],[-.05+i*.05,.565,-.303],team);
    for(const side of [-1,1]){
      shoulder(side,[.29,.19,.33],[.035,.075,-.015]);
      shoulder(side,[.30,.045,.35],[.035,.18,-.015],metal);
    }
  }else if(v===2){
    // Scout: low flight helmet and conspicuous asymmetric rangefinder.
    plate('flight shell',[.53,.29,.45],[0,.285,-.01],armor);
    plate('cap lip',[.56,.055,.46],[0,.426,-.025],team);
    plate('goggle band',[.50,.12,.043],[0,.29,-.254],dark);
    lens('large rangefinder',.115,.29,-.30,.078);
    plate('small optic',[.12,.048,.034],[-.115,.29,-.283],light);
    plate('soft lower mask',[.34,.12,.32],[0,.115,-.04],dark);
    for(const x of [-.09,0,.09])plate('mask rib',[.04,.065,.022],[x,.115,-.214],metal);
    grille('compact breathing intake',0,.118,-.232,.067,.041,3);
    for(const side of [-1,1]){
      plate('mask strap anchor',[.035,.036,.036],[side*.17,.13,-.18],armor);
      fastener(side*.165,.13,-.207);
    }
    // Knurled rangefinder focus collar; no additional light or new color.
    for(const angle of [-.8,0,.8,Math.PI]){
      const x=.115+Math.sin(angle)*.074,y=.29+Math.cos(angle)*.074;
      const grip=plate('focus collar grip',[.016,.012,.025],[x,y,-.315],armor);
      grip.rotation.z=-angle;
    }
    plate('optic dividing seam',[.011,.089,.009],[-.023,.29,-.28],metal);
    plate('radio receiver',[.046,.135,.088],[.31,.25,.065],dark);
    plate('short aerial',[.013,.12,.013],[.31,.38,.08],metal);
    const strap=detail(rig.torso,'utility webbing',[.037,.28,.014],[-.20,.49,-.286],dark);
    strap.rotation.z=-.12;
    detail(rig.torso,'radio panel',[.09,.12,.025],[.21,.55,-.28],dark);
    detail(rig.torso,'radio indicator',[.045,.013,.01],[.21,.575,-.3],light);
    detail(rig.torso,'field case',[.15,.11,.04],[-.19,.23,-.245],armor);
    detail(rig.torso,'case latch',[.035,.028,.012],[-.19,.23,-.27],metal);
    for(const side of [-1,1]){
      shoulder(side,[.25,.115,.29],[.045,.09,-.015],team,-.20);
      shoulder(side,[.21,.035,.23],[.045,.152,-.015],armor,-.20);
    }
  }else if(v===3){
    // Heavy: broad welding helmet, recessed slit, twin industrial filters.
    plate('reinforced shell',[.59,.36,.48],[0,.275,.005],armor);
    plate('blast face',[.47,.25,.065],[0,.255,-.265],metal);
    plate('recessed slit',[.37,.06,.018],[0,.32,-.306],dark);
    plate('single slit optic',[.29,.018,.012],[0,.323,-.32],light);
    plate('brow reinforcement',[.53,.066,.085],[0,.38,-.255],team);
    for(const x of [-.21,.21])plate('face lock',[.031,.029,.018],[x,.257,-.309],dark);
    plate('respirator',[.27,.135,.07],[0,.15,-.286],dark);
    for(const x of [-.19,.19]){
      const filter=detail(rig.head,'filter housing',[.078,.065,.078],[x,.145,-.30],metal,disc);
      filter.rotation.x=Math.PI/2;
      for(let i=0;i<3;i++)plate('filter slot',[.087,.013,.012],[x,.122+i*.022,-.34],dark);
      for(const dx of [-.061,.061])fastener(x+dx,.145,-.338);
    }
    grille('central breathing valve',0,.158,-.332,.122,.064,4);
    plate('nose reinforcement',[.064,.069,.024],[0,.237,-.31],armor);
    for(const side of [-1,1]){
      plate('filter connector',[.037,.039,.042],[side*.125,.15,-.30],armor);
      fastener(side*.214,.356,-.312);
    }
    for(let i=0;i<3;i++)detail(rig.torso,'breastplate rib',[.30,.022,.022],[0,.51+i*.038,-.289],metal);
    for(const x of [-.23,.23])detail(rig.torso,'reinforcement lock',[.045,.08,.024],[x,.58,-.272],team);
    for(const side of [-1,1]){
      shoulder(side,[.32,.17,.35],[.04,.10,-.015],team);
      shoulder(side,[.29,.085,.31],[.055,-.015,-.01],armor);
      shoulder(side,[.25,.04,.27],[.045,.194,-.015],metal);
    }
  }else{
    // Ghost: tapered full-face shell, uninterrupted slit and pointed jaw.
    plate('rear helmet',[.50,.32,.41],[0,.265,.015],armor);
    detail(rig.head,'tapered face',[.51,.42,.08],[0,.256,-.235],armor,shield);
    plate('continuous visor',[.41,.055,.018],[0,.31,-.285],dark);
    plate('continuous optic',[.34,.012,.012],[0,.312,-.298],light);
    detail(rig.head,'jaw shield',[.27,.18,.024],[0,.144,-.284],metal,shield);
    for(const side of [-1,1]){
      const cheek=plate('swept cheek',[.023,.13,.019],[side*.165,.212,-.279],metal);
      cheek.rotation.z=side*-.38;
    }
    for(const x of [-.048,0,.048])plate('jaw vent',[.014,.047,.008],[x,.16,-.301],dark);
    for(const side of [-1,1]){
      const seam=plate('cheek panel seam',[.008,.102,.007],[side*.133,.217,-.28],dark);
      seam.rotation.z=-side*.38;
      const inset=plate('cheek recessed panel',[.046,.073,.009],[side*.19,.226,-.279],metal);
      inset.rotation.z=side*-.38;
      for(let i=0;i<3;i++){
        const slot=plate('cheek microvent',[.029,.007,.005],[side*(.182+i*.006),.244-i*.018,-.287],dark);
        slot.rotation.z=side*-.38;
      }
      fastener(side*.191,.345,-.281);
    }
    plate('nose bridge',[.030,.054,.016],[0,.256,-.286],metal);
    plate('chin lock',[.033,.022,.013],[0,.10,-.30],armor);
    detail(rig.torso,'low profile chest panel',[.26,.10,.014],[0,.54,-.292],dark);
    for(const x of [-.035,.035]){
      const slash=detail(rig.torso,'unit slash',[.015,.064,.008],[x,.54,-.305],ivory);slash.rotation.z=-.35;
    }
    detail(rig.torso,'identification band',[.10,.023,.014],[.21,.61,-.269],team);
    for(const side of [-1,1]){
      const o=detail((side===1?rig.armR:rig.armL).shoulder,'tapered shoulder',
        [.29,.20,.07],[side*.04,.06,-.14],team,shield);o.rotation.z=side*-.22;
      shoulder(side,[.23,.11,.24],[.04,.10,.015],armor,-.22);
    }
  }
  // Back-side identity remains readable behind a shouldered weapon.
  for(let i=0;i<=v;i++)detail(rig.torso,'dorsal unit stripe',[.028,.06,.012],[-.15+i*.042,.59,.425],team);
}
