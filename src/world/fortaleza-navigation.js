import { CalleNavigation } from './calle-navigation.js';
import { galleryHeight,FORT_GALLERY as G } from './fortaleza-galleries.js';

// The courtyard and upper galleries are connected only through the four stairs.
export class FortalezaNavigation extends CalleNavigation {
  constructor(world){
    super(world);
    this.nodes=[];
    for(let x=-18;x<=18;x+=3)for(let z=-24;z<=24;z+=3)
      if(this.walkable({x,z}))this.nodes.push({x,z});
    for(const side of [-1,1])for(const end of [-1,1]){
      for(const x of [18.8,20.1,21.4,G.x]){
        const p={x:side*x,z:end*22.85};
        if(this.walkable(p))this.nodes.push(p);
      }
      for(const z of [21.7,19,16,14,10,5,0])this.nodes.push({x:side*G.x,z:end*z});
    }
    this.edges=this.nodes.map(()=>[]);
    for(let i=0;i<this.nodes.length;i++)for(let j=i+1;j<this.nodes.length;j++){
      const d=this.distance(this.nodes[i],this.nodes[j]);
      if(d<11&&this.clear(this.nodes[i],this.nodes[j])){
        this.edges[i].push([j,d]);this.edges[j].push([i,d]);
      }
    }
  }
  walkable(p){
    const r=this.radius,y=galleryHeight(p);
    if(Math.abs(p.x)>=26-r||Math.abs(p.z)>=26.6-r)return false;
    return !this.world.colliders.some(b=>!b.walkSurface&&y<b.h-.05&&y+1.63>(b.minY??0)+.02&&
      p.x>b.minx-r&&p.x<b.maxx+r&&p.z>b.minz-r&&p.z<b.maxz+r);
  }
  clear(a,b){
    // Exact padded slab sweep: point sampling alone can miss a thin doorway
    // corner and later invalidate the same segment after moving a few cm.
    for(const box of this.world.colliders){
      if(box.walkSurface)continue;
      let enter=0,leave=1,hit=true;
      for(const [axis,lo,hi] of [['x',box.minx-this.radius,box.maxx+this.radius],['z',box.minz-this.radius,box.maxz+this.radius]]){
        const delta=b[axis]-a[axis];
        if(Math.abs(delta)<1e-9){if(a[axis]<lo||a[axis]>hi){hit=false;break;}continue;}
        let t0=(lo-a[axis])/delta,t1=(hi-a[axis])/delta;if(t0>t1)[t0,t1]=[t1,t0];
        enter=Math.max(enter,t0);leave=Math.min(leave,t1);
        if(enter>leave){hit=false;break;}
      }
      if(hit)for(const t of [enter,(enter+leave)/2,leave]){
        const y=galleryHeight({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
        if(y<box.h-.05&&y+1.63>(box.minY??0)+.02)return false;
      }
    }
    const n=Math.max(1,Math.ceil(this.distance(a,b)/.25));let last=galleryHeight(a);
    for(let i=0;i<=n;i++){
      const p={x:a.x+(b.x-a.x)*i/n,z:a.z+(b.z-a.z)*i/n},h=galleryHeight(p);
      if(!this.walkable(p)||Math.abs(h-last)>.16)return false;
      last=h;
    }
    return true;
  }
  next(from,goal,owner){
    const saved=this.cache.get(owner);
    if(saved?.path.length&&!this.clear(from,saved.path[0]))this.cache.delete(owner);
    return super.next(from,goal,owner);
  }
}
