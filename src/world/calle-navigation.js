import * as THREE from 'three';

// Small visibility graph for the new side loops. Existing maps keep their
// steering unchanged. Every edge is swept against the actual world colliders.
export class CalleNavigation {
  constructor(world) {
    this.world=world;this.radius=.48;
    this.origin=new THREE.Vector3();this.direction=new THREE.Vector3();
    this.cache=new WeakMap();
    this.nodes=[];
    for(const x of [-14,-10,-5,0,5,10,14])
      for(const z of [-38,-30,-24,-18,-10,0,10,18,24,30,38])
        if(this.walkable({x,z}))this.nodes.push({x,z});
    for(const side of [-1,1])for(const z of [-18,-10,0,10,18])
      this.nodes.push({x:side*25,z});
    this.edges=this.nodes.map(()=>[]);
    for(let i=0;i<this.nodes.length;i++)for(let j=i+1;j<this.nodes.length;j++){
      const d=this.distance(this.nodes[i],this.nodes[j]);
      if(d<31&&this.clear(this.nodes[i],this.nodes[j])){
        this.edges[i].push([j,d]);this.edges[j].push([i,d]);
      }
    }
  }
  distance(a,b){return Math.hypot(a.x-b.x,a.z-b.z);}
  walkable(p){
    return Math.abs(p.x)<this.world.fx-this.radius&&Math.abs(p.z)<this.world.fz-this.radius&&
      !this.world.colliders.some(b=>p.x>b.minx-this.radius&&p.x<b.maxx+this.radius&&
        p.z>b.minz-this.radius&&p.z<b.maxz+this.radius);
  }
  clear(a,b){
    const d=this.distance(a,b);if(d<.001)return true;
    this.origin.set(a.x,.6,a.z);this.direction.set((b.x-a.x)/d,0,(b.z-a.z)/d);
    return this.world.raycast(this.origin,this.direction,d,this.radius)===null;
  }
  path(from,goal){
    if(!this.walkable(goal))return [];
    if(this.clear(from,goal))return [goal];
    const n=this.nodes.length,dist=Array(n).fill(Infinity),prev=Array(n).fill(-1),seen=new Set();
    for(let i=0;i<n;i++)if(this.clear(from,this.nodes[i]))dist[i]=this.distance(from,this.nodes[i]);
    let end=-1,best=Infinity;
    for(let k=0;k<n;k++){
      let i=-1;for(let j=0;j<n;j++)if(!seen.has(j)&&(i<0||dist[j]<dist[i]))i=j;
      if(i<0||!Number.isFinite(dist[i])||dist[i]>=best)break;
      seen.add(i);
      if(this.clear(this.nodes[i],goal)){
        const total=dist[i]+this.distance(this.nodes[i],goal);
        if(total<best){best=total;end=i;}
      }
      for(const [j,cost] of this.edges[i])if(dist[i]+cost<dist[j]){
        dist[j]=dist[i]+cost;prev[j]=i;
      }
    }
    if(end<0)return [];
    const result=[{...goal}];
    for(let i=end;i>=0;i=prev[i])result.unshift(this.nodes[i]);
    return result;
  }
  next(from,goal,owner){
    let saved=this.cache.get(owner);
    if(!saved||this.distance(saved.goal,goal)>1.5||!saved.path.length){
      saved={goal:{...goal},path:this.path(from,goal)};this.cache.set(owner,saved);
    }
    while(saved.path.length>1&&this.distance(from,saved.path[0])<.8&&this.clear(from,saved.path[1]))saved.path.shift();
    return saved.path[0]??null;
  }
}
