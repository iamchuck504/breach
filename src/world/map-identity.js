import * as T from 'three';

// Attached relief, architectural graphics and floor markings only. Never adds
// collision, cover, pickups, animated lights or another navigation surface.
export function addMapIdentity(world,layout){
  if(!['fortaleza','azoteas','calle2'].includes(layout))return;
  const root=new T.Group();root.name=`map-identity:${layout}`;world.mapGroup.add(root);
  const metal=new T.MeshStandardMaterial({color:0x343638,roughness:.7,metalness:.4});
  const stone=new T.MeshStandardMaterial({color:0xb8a27b,roughness:.88});
  const batches=new Map();
  const box=(name,x,y,z,w,h,d,mat=metal)=>{
    if(!batches.has(mat))batches.set(mat,[]);
    batches.get(mat).push(new T.Matrix4().compose(new T.Vector3(x,y,z),new T.Quaternion(),new T.Vector3(w,h,d)));
  };
  const textures=new Map();
  const graphic=(key,paint)=>{
    if(textures.has(key))return textures.get(key);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
    paint(canvas.getContext('2d'));
    const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;tex.anisotropy=4;
    textures.set(key,tex);return tex;
  };
  const plaque=(name,tex,x,y,z,w,h,ry=0,floor=false)=>{
    const mat=new T.MeshStandardMaterial({map:tex,transparent:true,alphaTest:.08,
      roughness:.88,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    const mesh=new T.Mesh(new T.PlaneGeometry(w,h),mat);mesh.name=name;
    mesh.position.set(x,y,z);mesh.rotation.set(floor?-Math.PI/2:0, floor?0:ry, floor?ry:0);
    mesh.receiveShadow=true;root.add(mesh);return mesh;
  };
  const sign=(text,x,y,z,ry,w,subtitle,style='industrial')=>world._addMapSign(text,x,y,z,ry,
    {w,h:.48,parent:root,style,subtitle,bg:layout==='fortaleza'?'#302d25':'#1c3038',border:'#b7a078'});
  const shield=graphic('fortress-seal',c=>{
    c.fillStyle='#3e4946';c.beginPath();c.moveTo(94,64);c.lineTo(418,64);c.lineTo(398,308);c.quadraticCurveTo(356,405,256,465);c.quadraticCurveTo(156,405,114,308);c.closePath();c.fill();
    c.strokeStyle='#c1a472';c.lineWidth=16;c.stroke();
    c.fillStyle='#c1a472';c.fillRect(184,185,144,160);
    for(const x of [164,226,288])c.fillRect(x,141,58,64);
    c.fillStyle='#3e4946';c.beginPath();c.arc(256,292,27,Math.PI,0);c.lineTo(283,347);c.lineTo(229,347);c.fill();
  });
  if(layout==='fortaleza'){
    root.userData.zones=['COURT OF THE KEEP','ARMOURY','GUARD GALLERY'];
    // Preserve the central pillar's authored banner; reinforce it with the inlaid court ring.
    for(const s of [-1,1]){
      // Identity belongs to the solid outer wall, never across firing windows.
      sign(s<0?'ARMOURY':'GUARD GALLERY',s*25.565,4.42,0,-s*Math.PI/2,3,
        'KEEP / UPPER WALK','heritage');
      for(const z of [-5.2,5.2]){
        plaque('gallery-heraldic-banner',shield,s*25.575,4.45,z,1.18,1.8,-s*Math.PI/2);
        box('banner-rail',s*25.57,5.39,z,.06,.06,1.3);
        // Thin wall-mounted rack: decorative backing and equipment silhouettes.
        box('equipment-rack',s*25.575,3.83,z+s*2,.045,1.45,1.05);
        for(const u of [-.32,0,.32]){
          box('stored-pole',s*25.545,3.91,z+s*2+u,.025,1.15,.028,stone);
          box('rack-crossbar',s*25.52,4.08,z+s*2+u,.023,.035,.16,stone);
        }
      }
      for(const end of [-1,1]){
        // Ground entrance identifiers below the stairwell, on masonry outside the opening.
        sign('UPPER WALK',s*20.95,2.1,end*14.5,-s*Math.PI/2,1.8,'STAIRS AT GATE','heritage');
      }
    }
    const paving=graphic('court-medallion',c=>{
      c.strokeStyle='#82745d';c.lineWidth=10;c.beginPath();c.arc(256,256,216,0,Math.PI*2);c.stroke();
      c.lineWidth=4;c.beginPath();c.arc(256,256,191,0,Math.PI*2);c.stroke();
      for(let i=0;i<8;i++){const a=i*Math.PI/4;c.beginPath();c.moveTo(256+Math.cos(a)*195,256+Math.sin(a)*195);c.lineTo(256+Math.cos(a)*216,256+Math.sin(a)*216);c.stroke();}
    });
    plaque('courtyard-inlaid-medallion',paving,0,.018,0,5.4,5.4,0,true);
  }else if(layout==='azoteas'){
    root.userData.zones=['LANDING DECK','AIR HANDLING','ROOF ACCESS'];
    const marking=graphic('landing-sector',c=>{
      c.fillStyle='#a5c2c4';c.font='bold 78px sans-serif';c.textAlign='center';c.fillText('LANDING',256,195);c.fillText('DECK',256,278);
      c.fillStyle='#c4a572';c.fillRect(80,322,352,12);
      c.font='bold 32px monospace';c.fillText('KEEP APPROACH CLEAR',256,385);
    });
    for(const s of [-1,1]){
      plaque('landing-approach-stencil',marking,0,.032,s*12.3,4.3,2.7,s<0?Math.PI:0,true);
      // Existing ROOFTOP ACCESS signage already identifies the stair core.
      // A maintenance diagram on the reverse face of existing tall water housing.
      sign('AIR HANDLING',s*20.25,2.32,s*17.18,s>0?0:Math.PI,2.1,'WATER / VENTILATION');
    }
    // Repeated inset markers identify the octagonal deck without new lights or glare.
    const lamps=new T.MeshBasicMaterial({color:0x9cbbbb});
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4+Math.PI/8;
      box('deck-inset-marker',Math.cos(a)*5.05,1.106,Math.sin(a)*5.05,.18,.01,.18,lamps);
    }
  }else{
    root.userData.zones=['POLICE CORDON','MOTOR WORKS','SERVICE ALLEY'];
    const evacuation=graphic('evacuation-stencil',c=>{
      c.fillStyle='#b5aa7a';c.globalAlpha=.78;c.font='bold 64px sans-serif';c.textAlign='center';c.fillText('EVACUATION',256,354);
      c.fillRect(237,175,38,90);c.beginPath();c.moveTo(175,184);c.lineTo(256,96);c.lineTo(337,184);c.fill();
      c.font='28px monospace';c.fillText('FOLLOW POLICE DIRECTIONS',256,410);
    });
    for(const s of [-1,1]){
      plaque('evacuation-road-stencil',evacuation,10.5,.035,s*29.5,3.2,4,s<0?Math.PI:0,true);
      // Cordon signs are authored on the existing end wall in calle-expansion-art.
    }
    // Repair/service routes differ through wall graphics, not extra physical cover.
    const service=graphic('loading-bay',c=>{
      c.strokeStyle='#a0936a';c.lineWidth=9;c.strokeRect(32,32,448,448);
      c.fillStyle='#a0936a';c.font='bold 84px sans-serif';c.textAlign='center';c.fillText('LOADING',256,230);c.fillText('ONLY',256,325);
    });
    for(const z of [-10.5,10.5])plaque('service-loading-stencil',service,-24.7,.036,z,2,2,Math.PI/2,true);
  }
  for(const [mat,matrices]of batches){
    const mesh=new T.InstancedMesh(new T.BoxGeometry(1,1,1),mat,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;
    mesh.name='identity-attached-details';mesh.receiveShadow=true;root.add(mesh);
  }
  // No generated texture/material is kept alive when unused by this map.
  for(const mat of [metal,stone])if(!batches.has(mat))mat.dispose();
  if(layout!=='fortaleza')shield.dispose();
}
