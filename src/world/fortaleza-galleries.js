// Shared dimensions for art, stairs, collision and server ballistics.
// The original courtyard remains x ±21, z ±26.6. Only side annexes expand.
export const FORT_GALLERY=Object.freeze({x:23.7,inner:21.8,outer:25.6,width:3.8,
  start:15.8,top:8.0,end:18.0,entry:16.4,windowRadius:2,height:3,wallTop:6.0,roofTop:7.19,steps:26});

export function galleryHeight(p,r=0){
  const g=FORT_GALLERY,ax=Math.abs(p.x),az=Math.abs(p.z);
  if(ax+r<g.inner||ax-r>g.outer||az>g.start)return 0;
  return az<=g.top?g.height:g.height*(g.start-az)/(g.start-g.top);
}

export function galleryBoxes(){
  const g=FORT_GALLERY,out=[];
  const add=(x,z,w,d,h,extra={})=>out.push({x,z,w,d,h,style:'high',mirror:false,visual:false,
    cover:false,gallery:true,...extra});
  for(const side of [-1,1]){
    const x=side*g.x;
    // Solid raised gallery foundations; smooth locomotion over physical treads.
    add(x,0,g.width,g.top*2,3,{walkSurface:true,deck:true});
    for(const end of [-1,1]){
      for(let i=0;i<g.steps;i++){
        const d=(g.start-g.top)/g.steps;
        add(x,end*(g.start-(i+.5)*d),g.width,d,3*(i+1)/g.steps,{walkSurface:true});
      }
      // Short annexes stop well before the spawns at z ±23.4.
      add(x,end*(g.end+.2),g.width+.8,.4,6);
      // Closed upper end walls prevent direct fire into the protected spawns.
      add(x,end*(g.top+.2),g.width,.4,6,{minY:4.95});
    }
    add(side*(g.outer+.2),0,.4,g.end*2,6);
    // Inner lower wall ends at the two ground entrances.
    // Continuous sill: 1.1 m cover above the 3 m gallery deck.
    add(side*21.4,0,.8,g.top*2,4.1,{cover:true,coverBase:3,visualBase:3});
    // Open windows remain full human scale, not squeezed to fit the shorter wing.
    for(let i=-g.windowRadius;i<=g.windowRadius;i++){
      const z=i*3;
      add(side*21.4,z-1.35,.8,.3,5.6,{minY:4.1});
      add(side*21.4,z+1.35,.8,.3,5.6,{minY:4.1});
    }
    const lastEdge=g.windowRadius*3+1.5;
    for(const end of [-1,1])add(side*21.4,end*(g.top+lastEdge)/2,.8,g.top-lastEdge,5.6,{minY:4.1});
    add(side*21.4,0,.8,g.top*2,6,{minY:5.6});
    // Opaque stairwell sides (no unfair spawn sightlines).
    for(const end of [-1,1])add(side*21.4,end*(g.start+g.top)/2,.8,g.start-g.top,6,{minY:3});
    // Weatherproof roof uses horizontal bands matching a pitched silhouette.
    const bands=12;
    for(let i=0;i<bands;i++){
      const w=(g.width+.8)/bands,local=-((g.width+.8)/2)+(i+.5)*w;
      const bottom=6.03+1.02*(1-Math.abs(local)/((g.width+.8)/2));
      add(x+local,0,w,g.end*2+.4,bottom+.22,{minY:bottom,roof:true});
    }
  }
  return out;
}

// Split the existing long walls solely at four stair entrance openings.
export function galleryCourtyardWalls(){
  const out=[];
  const g=FORT_GALLERY,stub=(27.6+g.end)/2,depth=27.6-g.end;
  for(const side of [-1,1])for(const [z,d] of [[0,g.start*2],[-stub,depth],[stub,depth]])
    out.push({x:side*21.4,z,w:.8,d,h:3,style:'wall',mirror:false});
  return out;
}
