import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

// Cosmetic, parent-local attachments. No collider, cover face, light or animation.
export function polishCalleProp(world, parent, kind, spec={}) {
  const source=world.customMap?.base ?? world.layout;
  if ((source!=='calle2' && world.theme!=='calle2') || parent.userData.callePolish) return;
  if(!['sedan','truck','bus','dumpster','jersey','kiosk','coffee','suvMinivan','busShelter','fireHydrant','streetlight'].includes(kind))return;
  parent.userData.callePolish=kind;
  const root=new T.Group();root.name=`calle2-prop-polish:${kind}`;
  const batches=new Map(),materials=new Map();
  const mat=(color,metalness=.25,roughness=.65)=>{
    const key=`${color}:${metalness}:${roughness}`;
    if(!materials.has(key))materials.set(key,new T.MeshStandardMaterial({color,metalness,roughness}));
    return materials.get(key);
  };
  const black=()=>mat(0x141b1f,.2,.8),steel=()=>mat(0x697378,.65,.43),amber=()=>mat(0xc29a50,.3,.4);
  const geo=(geometry,material,pos,rot=[0,0,0])=>{
    geometry.applyMatrix4(new T.Matrix4().compose(new T.Vector3(...pos),
      new T.Quaternion().setFromEuler(new T.Euler(...rot)),new T.Vector3(1,1,1)));
    if(!batches.has(material))batches.set(material,[]);batches.get(material).push(geometry);
  };
  const box=(w,h,d,pos,m,rot)=>geo(new T.BoxGeometry(w,h,d),m,pos,rot);
  const disc=(r,pos,m,side)=>geo(new T.CircleGeometry(r,12),m,pos,[0,side*Math.PI/2,0]);
  const label=(title,sub,w,h,pos,ry=0,{bg='#ced0bd',fg='#25343a',border='#6a7674'}={})=>{
    const c=document.createElement('canvas');c.width=512;c.height=192;const g=c.getContext('2d');
    g.fillStyle=bg;g.fillRect(0,0,512,192);g.strokeStyle=border;g.lineWidth=7;g.strokeRect(8,8,496,176);
    g.fillStyle=fg;g.textAlign='center';g.font='bold 60px sans-serif';g.fillText(title,256,89,465);
    g.font='28px sans-serif';g.fillText(sub,256,144,465);
    const map=new T.CanvasTexture(c);map.colorSpace=T.SRGBColorSpace;map.anisotropy=4;
    const m=new T.MeshStandardMaterial({map,roughness:.62,metalness:.15,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    const o=new T.Mesh(new T.PlaneGeometry(w,h),m);o.position.set(...pos);o.rotation.y=ry;
    o.name=`prop-label:${title}`;root.add(o);
  };
  const vehicle=['sedan','truck','bus'].includes(kind);
  if(vehicle){
    // Keep the tire diameter/width and the existing gray hubs. Add inset hub
    // hardware on the outer wheel face, not a torus wrapped around the tire.
    const wheels=parent.children.filter(o=>o.isMesh&&o.geometry.type==='CylinderGeometry'
      &&o.geometry.parameters.radiusTop>.3&&o.geometry.parameters.radiusTop<.7);
    for(const w of wheels){
      const side=Math.sign(w.position.x),r=w.geometry.parameters.radiusTop;
      const hub=parent.children.filter(o=>o.isMesh&&o.geometry.type==='CylinderGeometry'
        &&Math.abs(o.position.y-w.position.y)<.002&&Math.abs(o.position.z-w.position.z)<.002
        &&Math.sign(o.position.x)===side&&o.geometry.parameters.radiusTop<r*.8)
        .sort((a,b)=>b.geometry.parameters.radiusTop-a.geometry.parameters.radiusTop)[0];
      const face=hub??w;
      const x=face.position.x+side*(face.geometry.parameters.height/2+.004);
      disc(r*.40,[x,w.position.y,w.position.z],steel(),side);
      disc(r*.15,[x+side*.002,w.position.y,w.position.z],black(),side);
      for(let j=0;j<6;j++){
        const a=j*Math.PI/3;
        disc(r*.034,[x+side*.003,w.position.y+Math.sin(a)*r*.27,w.position.z+Math.cos(a)*r*.27],black(),side);
      }
    }
    // Tune only private surface materials; never recolor windows or lamps.
    const seen=new Set();parent.traverse(o=>{
      if(!o.isMesh)return;for(const m of (Array.isArray(o.material)?o.material:[o.material])){
        if(seen.has(m)||m.userData.urbanAssetShared)continue;seen.add(m);
        if(m.map&&m.bumpMap){m.roughness=Math.max(.55,m.roughness);m.metalness=Math.min(.35,m.metalness);m.bumpScale=Math.min(.004,m.bumpScale);}
      }
    });
    if(kind==='sedan'){
      const length=4.58;
      for(const side of [-1,1])label(spec.variant===3?'RC • 017':`RC • ${210+(spec.variant||0)*37}`,'RACCOON CITY',.40,.105,[0,.34,side*(length/2+.096)],side>0?0:Math.PI);
      for(let j=-3;j<=3;j++)box(.045,.13,.011,[j*.105,.53,-length/2-.117],steel());
    }else if(kind==='truck'){
      label(spec.variant?'CW 042':'CW 018','CITY SERVICES',.43,.115,[0,.40,-3.585],Math.PI);
      for(const side of [-1,1]){
        label(spec.variant?'UNIT 042':'UNIT 018','AUTHORIZED SERVICE',.64,.20,[side*1.285,.97,1.70],side*Math.PI/2,{bg:'#2c383b',fg:'#bfc3b6'});
        for(const z of [-.45,.1,.65,1.2,1.75,2.3,2.85])box(.012,.065,.22,[side*1.276,.45,z],z>.7?amber():steel());
      }
      for(const side of [-1,1])box(.055,.43,.035,[side*.36,1.30,3.488],steel());
    }else{
      label(spec.variant?'TRANSIT 07':'TRANSIT 14','KEEP CLEAR',.70,.19,[0,.69,4.578],0,{bg:'#273135',fg:'#d5cab0'});
      for(const side of [-1,1]){
        label('CITY TRANSIT',spec.variant?'EVACUATION UNIT 07':'EVACUATION UNIT 14',1.80,.24,[side*1.365,1.26,.15],side*Math.PI/2,{bg:'#603b30',fg:'#dbceb3',border:'#987852'});
        for(let j=0;j<7;j++)box(.012,.023,.66,[side*1.364,.59+j*.073,3.51],black());
      }
    }
  }else if(kind==='dumpster'){
    const body=parent.children.find(o=>o.geometry?.type==='BoxGeometry'&&Math.abs(o.geometry.parameters.width-2.38)<.01);
    if(body){const old=body.geometry;body.geometry=new RoundedBoxGeometry(2.38,.78,1.94,1,.025);old.dispose();}
    for(const side of [-1,1])label('CITY WASTE','NO HOT ASH / KEEP CLOSED',.88,.28,[0,.59,side*.974],side>0?0:Math.PI,{bg:'#d1c4a0',fg:'#2b3732'});
    for(const x of [-.82,.82]){
      box(.18,.055,.10,[x,1.015,.91],steel());
      box(.052,.43,.018,[x,.52,-.982],black());
    }
  }else if(kind==='jersey'){
    for(const side of [-1,1]){
      label('CITY WORKS','ROAD CLOSED',.73,.15,[0,.96,side*spec.d*.27+side*.004],side>0?0:Math.PI,{bg:'#686c67',fg:'#dbd3b6'});
      for(const x of [-spec.w*.37,spec.w*.37])box(.15,.085,.012,[x,.96,side*(spec.d*.27+.006)],amber());
    }
  }else if(kind==='kiosk'){
    // Ventilation/metal edging live on existing side panels, clear of the
    // service opening, countertop, products and the existing business sign.
    const sideZ=parent.children.find(o=>o.geometry?.parameters.height===2.28)?.position.z??0;
    for(const side of [-1,1]){
      for(let j=0;j<5;j++)box(.012,.017,spec.d*.24,[side*(spec.w/2+.003),.30+j*.065,sideZ],black());
      box(.025,.055,spec.d*.58,[side*(spec.w/2+.005),.16,sideZ],steel());
    }
    const counter=parent.children.find(o=>o.geometry?.parameters.height===.94);
    if(counter){
      const toward=Math.sign(counter.position.z),news=spec.decorLink?.includes('news');
      label(news?'DAILY PRESS':'MENU',news?'LOCAL NEWS / MAGAZINES':'HOT DOGS / COLD DRINKS',spec.w*.57,.34,
        [0,.60,counter.position.z+toward*.094],toward>0?0:Math.PI,
        {bg:news?'#c8bba0':'#4e3025',fg:news?'#293638':'#ebd2a5'});
      if(!news){
        // Small cooking tray behind the counter; it does not fill the opening.
        box(.38,.045,.23,[-.48,1.12,counter.position.z-toward*.08],steel());
        for(let i=0;i<4;i++)box(.014,.008,.17,[-.59+i*.07,1.148,counter.position.z-toward*.08],black());
      }
    }
  }else if(kind==='coffee'){
    for(const x of [-.46,.46])box(.07,.045,.07,[x,1.117,.21],steel());
    label('FRESH COFFEE','HOT DRINKS / TAKE AWAY',.76,.24,[0,.60,-.323],Math.PI,{bg:'#513729',fg:'#e1d2af'});
    for(let j=0;j<4;j++)box(.014,.022,.30,[.624,.35+j*.07,0],black());
  }else{
    // Imported meshes remain intact: clone materials before local refinements,
    // leaving the cache and original Calle unaffected. No invented sockets.
    const clones=new Map();parent.traverse(o=>{
      if(!o.isMesh)return;
      const tune=m=>{if(!clones.has(m)){
        const c=m.clone();c.userData={...m.userData,urbanAssetShared:false};
        if(c.isMeshStandardMaterial){c.roughness=kind==='suvMinivan'?.58:.70;c.metalness=kind==='suvMinivan'?.24:.28;}
        clones.set(m,c);
      }return clones.get(m);};
      o.material=Array.isArray(o.material)?o.material.map(tune):tune(o.material);
    });
  }
  for(const [material,geometries] of batches){
    const geometry=mergeGeometries(geometries);geometries.forEach(g=>g.dispose());
    const mesh=new T.Mesh(geometry,material);mesh.name='prop-hardware-batch';mesh.receiveShadow=true;root.add(mesh);
  }
  if(root.children.length)parent.add(root);
}
