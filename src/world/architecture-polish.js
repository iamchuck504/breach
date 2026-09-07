import * as T from 'three';
import {cloneUrbanAsset} from './urban-assets.js';
import {collisionBoxesFor} from './collision-layouts.js';

// Surface dressing only. No new walkable volumes, cover faces or occluders.
// Every placement derives from the same box manifest used by the server.
export function polishArchitecture(world, layout) {
  if (!['fortaleza','azoteas'].includes(layout)) return;
  const roof=layout==='azoteas', root=new T.Group();root.name=`${layout}-architectural-polish`;
  world.mapGroup.add(root);
  const batches=new Map(), models=new Map(), boxGeometry=new T.BoxGeometry(1,1,1);
  const stone=new T.MeshStandardMaterial({color:0xa89b80,roughness:.88});
  const trim=new T.MeshStandardMaterial({color:roof?0x738692:0x645b4d,roughness:.67,metalness:roof?.5:.08});
  const seam=new T.MeshStandardMaterial({color:roof?0x273943:0x746a56,roughness:.92});
  const skin=new T.MeshStandardMaterial({color:0x4e626c,metalness:.42,roughness:.6});
  const glow=new T.MeshBasicMaterial({color:roof?0xffdfa8:0xffbe6f});
  const matrix=new T.Matrix4(), q=new T.Quaternion(), v=new T.Vector3(), s=new T.Vector3();
  const pose=(x,y,z,ry=0,sx=1,sy=1,sz=1)=>new T.Matrix4().compose(new T.Vector3(x,y,z),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),ry),new T.Vector3(sx,sy,sz));
  function add(geo,mat,m,key){
    const id=key??`${geo.uuid}:${mat.uuid}`;
    if(!batches.has(id))batches.set(id,{geo,mat,matrices:[]});
    batches.get(id).matrices.push(m.clone());
  }
  function box(parent,x,y,z,w,h,d,mat){
    matrix.compose(v.set(x,y,z),q.identity(),s.set(w,h,d));
    add(boxGeometry,mat,new T.Matrix4().multiplyMatrices(parent,matrix));
  }
  function asset(id,parent){
    if(!models.has(id)){
      const model=cloneUrbanAsset(id);model?.updateMatrixWorld(true);models.set(id,model);
    }
    const model=models.get(id);if(!model)return;
    model.traverse(o=>{if(o.isMesh)add(o.geometry,o.material,new T.Matrix4().multiplyMatrices(parent,o.matrixWorld),`${id}:${o.geometry.uuid}`);});
  }
  const specs=[];
  for(const b of collisionBoxesFor(layout)){
    if(b.visual===false)continue;
    specs.push(b);
    if(b.mirror!==false&&(b.x||b.z))specs.push({...b,x:-b.x,z:-b.z});
  }
  for(const b of specs){
    const {x,z,w,d,h,style}=b;
    if(style==='glass')continue;
    const perimeter=style==='wall';
    const faces=[pose(x,0,z+d/2),pose(x,0,z-d/2,Math.PI),pose(x+w/2,0,z,Math.PI/2),pose(x-w/2,0,z,-Math.PI/2)];
    faces.forEach((p,i)=>{
      const width=i<2?w:d;
      if(roof){
        if(perimeter){
          box(p,0,2.78,.009,width,.13,.018,trim);
          return;
        }
        // Sheet-metal casing overlays replace the concrete-grid reading.
        box(p,0,h/2,.006,Math.max(.1,width-.06),h-.04,.012,skin);
        box(p,0,.10,.016,width-.03,.12,.02,seam);
        box(p,0,h-.07,.015,width-.03,.08,.018,trim);
        for(let a=-width/2+.09;a<width/2;a+=1.4)
          box(p,a,h/2,.015,.018,h-.15,.012,trim);
        if(style==='ac'||style==='vent'){
          const count=Math.max(1,Math.floor(width/1.35));
          for(let j=0;j<count;j++){
            const local=pose((j-(count-1)/2)*(width/count),.20,.022,0,Math.min(1,width-.18),.90,.45);
            asset('roof-grille',new T.Matrix4().multiplyMatrices(p,local));
          }
        }else if(style==='hut'&&width>2.4&&h>=1.9){
          const spawn= Math.abs(z)===31.35&&i<2;
          if(spawn)asset('roof-access',new T.Matrix4().multiplyMatrices(p,pose(0,0,.024,0,1,1,.45)));
          else if(i<2)asset('roof-cabinet',new T.Matrix4().multiplyMatrices(p,pose(0,.18,.025,0,1,h<2?.82:1,.45)));
        }
      }else{
        // Caps stay below the defined cover height. Quoins never grow the
        // footprint: only a 2 cm dressed surface, not imaginary pillars.
        box(p,0,h-.095,.012,width,.15,.024,stone);
        box(p,0,.11,.009,width,.16,.018,trim);
        if(width>.8){
          for(const side of [-1,1]){
            for(let y=.32;y<h-.22;y+=.42)
              box(p,side*(width/2-.105),y,.009,.18,.39,.018,stone);
          }
        }
        if(!perimeter&&width>2&&h>1.6&&Math.abs(z)!==20.9){
          for(let a=-width/2+.65;a<width/2-.4;a+=1.2){
            box(p,a,1.20,.010,.10,.58,.020,seam);
            box(p,a,1.48,.014,.24,.06,.016,stone);
          }
        }
      }
    });
  }
  if(!roof){
    if(models.get('fort-gate')||cloneUrbanAsset('fort-gate')){
      const old=world.mapGroup.getObjectByName('fortaleza-procedural-gates');
      if(old)old.visible=false;
    }
    for(const sign of [-1,1]){
      const p=pose(0,0,sign*(20.9-.516),sign<0?0:Math.PI);
      asset('fort-gate',p);
    }
    // Masonry bands articulate the existing round towers, outside play.
    const ring=new T.CylinderGeometry(2.17,2.19,.18,12,1,true);
    for(const x of (world.mapGroup.getObjectByName('fortaleza-blender-castle')?[]:[-23.6,23.6]))for(const z of [-world.fz-2.6,world.fz+2.6]){
      for(const y of [1.2,4.5,7.4])add(ring,stone,pose(x,y,z));
    }
    // The four existing braziers get an iron cage, not extra floor props.
    const ironRing=new T.TorusGeometry(.245,.022,5,12);
    for(const [x,z] of (world.mapGroup.getObjectByName('fortaleza-blender-castle')?[]:[[7,-6],[-7,6],[-11,-5],[11,5]])){
      for(const y of [3.12,3.31]){
        const m=pose(x,y,z);m.multiply(new T.Matrix4().makeRotationX(Math.PI/2));add(ironRing,trim,m);
      }
      for(let j=0;j<6;j++){
        const a=j*Math.PI/3;
        box(pose(x,0,z),Math.cos(a)*.23,3.23,Math.sin(a)*.23,.027,.29,.027,trim);
      }
    }
  }else{
    // Labels sit above the cabinet/louvres, on their supporting faces.
    for(const [text,x,z,w,h] of [['AIR HANDLING',-12.2,-21.507,2.45,.30],['POWER / 02',26,-30.157,2.10,.28],['WATER RESERVE',-20.25,-14.307,2.25,.32]]){
      for(const sign of [1,-1])world._addMapSign(text,sign*x,h===.32?2.62:1.62,sign*z,sign===1?0:Math.PI,{w,h,parent:root,bg:'#263a46',fg:'#d9e3df',border:'#ab9370',style:'industrial',subtitle:text==='WATER RESERVE'?'SERVICE ACCESS':'AUTHORIZED MAINTENANCE'});
    }
  }
  // Two mounted task lights per map, with no shadow maps or flicker.
  for(const sign of [-1,1]){
    const z=sign*(roof?31.35:20.9),faceZ=z-sign*(roof?.638:.532),ry=sign<0?0:Math.PI;
    const x=roof?1.9:1.5,y=roof?2.38:2.25;
    const p=pose(x,y,faceZ,ry);
    box(p,0,0,0,.22,.28,.038,trim);box(p,0,0,.023,.15,.19,.012,glow);
    const lamp=new T.SpotLight(roof?0xffe1ac:0xffc487,roof?18:8,6,Math.PI*.34,.85,2);
    lamp.position.set(x,y,faceZ-sign*.07);lamp.target.position.set(x,.15,faceZ-sign*2.5);
    root.add(lamp,lamp.target);
  }
  for(const {geo,mat,matrices} of batches.values()){
    const mesh=new T.InstancedMesh(geo,mat,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;
    // Millimetre relief does not need a shadow-map pass; this avoids acne
    // against its supporting wall and preserves existing silhouette shadows.
    mesh.name=`${layout}-polish-batch`;mesh.castShadow=false;mesh.receiveShadow=true;
    root.add(mesh);
  }
  // Dispose only materials never used by a batch; GLB resources remain shared.
  for(const m of [stone,trim,seam,skin,glow])if(![...batches.values()].some(b=>b.mat===m))m.dispose();
}
