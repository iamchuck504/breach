import * as T from 'three';
import {buildFrag,buildStun} from '../player/rig.js';

// Vista de pickups y proyectiles de los prototipos de combate. Pool acotado,
// geometría compartida y sin luces por proyectil.
//
// La granada explosiva en vuelo usa el MISMO modelo que se lleva en la mano
// (no una esfera genérica), gira al volar y lleva una baliza que late más
// rápido conforme se acerca la detonación: debe poder seguirse con la vista.
//
// Online el estado llega a 20 Hz. Dibujar la posición cruda hacía que la
// granada avanzara a saltos; aquí cada proyectil se extrapola con la velocidad
// medida entre estados y se sigue con un filtro corto, así el vuelo es
// continuo a cualquier tasa de cuadros.
const FRAG_SCALE=1.35,FUSE=2.4,MAX_EXTRAPOLATION=.12,FOLLOW_RATE=26;

export class PrototypeView {
 constructor(scene){
  this.scene=scene;this.items=new Map();this.geo=new T.SphereGeometry(.09,8,6);
  this.stun=new T.MeshBasicMaterial({color:0x67dfff});
  this.beacon=new T.MeshBasicMaterial({color:0xffa52f,transparent:true,opacity:.55,
   blending:T.AdditiveBlending,depthWrite:false});
  this.arcGeo=new T.BufferGeometry();
  const points=[];for(let i=0;i<20;i++){const a=i*.85,y=.25+i*.065;points.push(Math.cos(a)*.33,y,Math.sin(a)*.33,Math.cos(a+.6)*.42,y+.055,Math.sin(a+.6)*.42);}
  this.arcGeo.setAttribute('position',new T.Float32BufferAttribute(points,3));
  this.arcMat=new T.LineBasicMaterial({color:0x62daff,transparent:true,opacity:.8,depthWrite:false});
  this.lastTime=null;
 }
 _makeProjectile(kind){
  if(kind!=='frag')return new T.Mesh(this.geo,this.stun);
  const root=new T.Group(),body=buildFrag(0xffb34e),beacon=new T.Mesh(this.geo,this.beacon);
  body.scale.setScalar(FRAG_SCALE);root.add(body,beacon);
  root.userData={body,beacon};
  return root;
 }
 update(snapshot,actors,time){
  const dt=this.lastTime===null?0:Math.max(0,Math.min(.1,time-this.lastTime));this.lastTime=time;
  const keep=new Set();
  const show=(id,kind,p,scale=1)=>{
   keep.add(id);let mesh=this.items.get(id);
   if(!mesh){mesh=kind==='frag'?buildFrag(0xffb34e):buildStun(0x67dfff);this.items.set(id,mesh);this.scene.add(mesh);}
   mesh.visible=true;mesh.position.set(p.x,p.y,p.z);mesh.scale.setScalar(scale);
  };
  if(snapshot?.active){
   for(const p of snapshot.pickups??[])if(p.count){
    show(`pickup:${p.id}`,p.kind,{...p,y:p.y+.32},2.2);
    if(p.kind==='frag'&&p.count>1)show(`pair:${p.id}`,p.kind,{...p,x:p.x+.35,y:p.y+.32},1.6);
   }
   for(const p of snapshot.projectiles??[]){
    const id=`projectile:${p.id}`;keep.add(id);
    let mesh=this.items.get(id);
    if(!mesh){
     mesh=this._makeProjectile(p.kind);this.items.set(id,mesh);this.scene.add(mesh);
     mesh.position.set(p.x,p.y,p.z);
     mesh.userData.track={x:p.x,y:p.y,z:p.z,vx:0,vy:0,vz:0,at:time,t:p.t??0};
    }
    const track=mesh.userData.track;
    // estado nuevo del servidor/motor: medir la velocidad real entre estados
    if(p.x!==track.x||p.y!==track.y||p.z!==track.z){
     const span=time-track.at;
     if(span>.001&&span<.5){track.vx=(p.x-track.x)/span;track.vy=(p.y-track.y)/span;track.vz=(p.z-track.z)/span;}
     track.x=p.x;track.y=p.y;track.z=p.z;track.at=time;track.t=p.t??track.t;
    }else if(time-track.at>.2){track.vx=track.vy=track.vz=0;} // en reposo: no derivar
    const ahead=Math.min(MAX_EXTRAPOLATION,time-track.at),follow=1-Math.exp(-FOLLOW_RATE*dt);
    mesh.position.x+=(track.x+track.vx*ahead-mesh.position.x)*follow;
    mesh.position.y+=(track.y+track.vy*ahead-mesh.position.y)*follow;
    mesh.position.z+=(track.z+track.vz*ahead-mesh.position.z)*follow;
    mesh.visible=true;
    if(p.kind==='frag'){
     const {body,beacon}=mesh.userData,speed=Math.hypot(track.vx,track.vy,track.vz);
     // gira mientras vuela o rueda; quieta en el suelo deja de girar
     body.rotation.x+=Math.min(14,speed*1.6)*dt;body.rotation.z+=Math.min(9,speed)*dt;
     const fuse=Math.min(1,(track.t+ahead)/FUSE),rate=5+fuse*fuse*22;
     const pulse=.5+.5*Math.sin((track.t+ahead)*rate*Math.PI);
     beacon.scale.setScalar(1.25+.9*pulse+fuse*.7); // radio ~0.11–0.26 m
    }else mesh.scale.setScalar(.7);
   }
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
 clear(){for(const o of this.items.values())this.scene.remove(o);this.items.clear();this.lastTime=null;}
}
