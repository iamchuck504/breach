import * as T from 'three';
import {evaluateBlast} from './blast.js';
// Created only by the Vite-development gate; never enabled by production URLs.
export class BlastDebug {
 constructor(scene){this.scene=scene;this.group=new T.Group();scene.add(this.group);this.ttl=0;this.label=document.createElement('pre');Object.assign(this.label.style,{position:'fixed',left:'12px',top:'85px',padding:'10px',background:'#081018df',color:'#fff',font:'12px monospace',pointerEvents:'none',zIndex:'100'});document.body.append(this.label);this.label.hidden=true;}
 clear(){for(const o of [...this.group.children]){o.geometry?.dispose();o.material?.dispose();this.group.remove(o);}this.label.hidden=true;}
 show(origin,def,actors,blocked){
  this.clear();this.ttl=2;this.label.hidden=false;
  for(const [r,color]of [[def.blastCore,0xff4433],[def.splashRadius*.55,0xffbd40],[def.splashRadius,0x73bfff]]){
   const mesh=new T.Mesh(new T.SphereGeometry(r,16,8),new T.MeshBasicMaterial({color,wireframe:true,transparent:true,opacity:.22,depthWrite:false}));mesh.position.set(origin.x,origin.y,origin.z);this.group.add(mesh);
  }
  const rows=['BLAST DEBUG · core / high / outer'];
  for(const a of actors){if(!a.alive)continue;const result=evaluateBlast(def,origin,a,blocked);if(result.distance>def.splashRadius)continue;
   const color=result.exposure===0?0xff4433:result.exposure<.99?0xffbd40:0x66ff99;
   const line=new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(origin.x,origin.y,origin.z),new T.Vector3(a.x,(a.y??0)+.85,a.z)]),new T.LineBasicMaterial({color}));this.group.add(line);
   rows.push(`${a.id}: exposure ${(result.exposure*100).toFixed(0)}% · raw damage ${result.damage.toFixed(1)}`);
  }
  this.label.textContent=rows.join('\n');
 }
 update(dt){if(this.ttl>0&&(this.ttl-=dt)<=0)this.clear();}
 dispose(){this.clear();this.scene.remove(this.group);this.label.remove();}
}
