import * as T from 'three';
import {buildFrag,buildStun} from '../player/rig.js';
// Small bounded shared-geometry visual pool; no per-projectile lights.
export class PrototypeView {
 constructor(scene){
  this.scene=scene;this.items=new Map();this.geo=new T.SphereGeometry(.09,8,6);
  this.frag=new T.MeshStandardMaterial({color:0x405538,emissive:0xe68b17,emissiveIntensity:.3});
  this.stun=new T.MeshBasicMaterial({color:0x67dfff});
  this.arcGeo=new T.BufferGeometry();
  const points=[];for(let i=0;i<20;i++){const a=i*.85,y=.25+i*.065;points.push(Math.cos(a)*.33,y,Math.sin(a)*.33,Math.cos(a+.6)*.42,y+.055,Math.sin(a+.6)*.42);}
  this.arcGeo.setAttribute('position',new T.Float32BufferAttribute(points,3));
  this.arcMat=new T.LineBasicMaterial({color:0x62daff,transparent:true,opacity:.8,depthWrite:false});
 }
 update(snapshot,actors,time){
  const keep=new Set();
  const show=(id,kind,p,scale=1)=>{
   keep.add(id);let mesh=this.items.get(id);
   if(!mesh){mesh=id.startsWith('pickup:')||id.startsWith('pair:')?(kind==='frag'?buildFrag(0xffb34e):buildStun(0x67dfff)):new T.Mesh(this.geo,kind==='frag'?this.frag:this.stun);this.items.set(id,mesh);this.scene.add(mesh);}
   mesh.visible=true;mesh.position.set(p.x,p.y,p.z);mesh.scale.setScalar(scale);
  };
  if(snapshot?.active){
   for(const p of snapshot.pickups??[])if(p.count){
    show(`pickup:${p.id}`,p.kind,{...p,y:p.y+.32},2.2);
    if(p.kind==='frag'&&p.count>1)show(`pair:${p.id}`,p.kind,{...p,x:p.x+.35,y:p.y+.32},1.6);
   }
   for(const p of snapshot.projectiles??[])show(`projectile:${p.id}`,p.kind,p,p.kind==='stun'?.7:1+.25*Math.max(0,Math.sin((p.t??0)*24)));
   for(const s of snapshot.states??[])if(s.remaining>0){
    const a=actors.find(a=>a.id===s.id);if(!a?.alive)continue;
    const id=`electric:${s.id}`;keep.add(id);let mesh=this.items.get(id);
    if(!mesh){mesh=new T.LineSegments(this.arcGeo,this.arcMat);this.scene.add(mesh);this.items.set(id,mesh);}
    mesh.position.set(a.x,a.y??0,a.z);mesh.rotation.y=time*1.2;mesh.visible=Math.sin(time*18)>.05;
   }
  }
  for(const [id,o]of this.items)if(!keep.has(id)){
   if(id.startsWith('pickup:')||id.startsWith('pair:')){o.visible=false;continue;}
   this.scene.remove(o);this.items.delete(id);
  }
 }
 clear(){for(const o of this.items.values())this.scene.remove(o);this.items.clear();}
}
