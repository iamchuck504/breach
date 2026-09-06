import * as THREE from 'three';

// Opaque illustrated interiors replace the existing glass plane, rather than
// layering geometry over a shutter. No new entrance or collision volume.
export function calleShopDisplay(style) {
  const c=document.createElement('canvas');c.width=512;c.height=384;
  const g=c.getContext('2d'),warm=style==='bakery';
  g.fillStyle=warm?'#473b2c':'#26383c';g.fillRect(0,0,512,384);
  g.fillStyle='#172126';g.beginPath();g.moveTo(0,384);g.lineTo(90,294);
  g.lineTo(422,294);g.lineTo(512,384);g.fill();
  g.fillStyle=warm?'#87724f':'#68807a';g.fillRect(74,40,364,12);
  for(const y of [130,235]){
    g.fillStyle='#111b20';g.fillRect(64,y+8,384,15);
    g.fillStyle=warm?'#766348':'#5c6c69';g.fillRect(64,y,384,8);
    for(let i=0;i<8;i++){
      const x=86+i*46;
      if(warm){
        g.fillStyle=i%2?'#bd955c':'#a97d47';g.beginPath();g.ellipse(x,y-16,18,12,-.3,0,Math.PI*2);g.fill();
        g.strokeStyle='#ddbb83';g.lineWidth=2;g.beginPath();g.moveTo(x-6,y-20);g.lineTo(x+3,y-11);g.stroke();
      } else if(style==='laundry') {
        g.fillStyle='#84958e';g.fillRect(x-20,y-66,40,63);
        g.fillStyle='#101d24';g.beginPath();g.arc(x,y-31,14,0,Math.PI*2);g.fill();
        g.strokeStyle='#597b89';g.lineWidth=4;g.stroke();
      } else {
        g.fillStyle=['#82917d','#b7af86','#72969c'][i%3];g.fillRect(x-12,y-40-(i%2)*15,24,38+(i%2)*15);
        g.fillStyle='#d4d3b5';g.fillRect(x-9,y-27,18,10);
      }
    }
  }
  g.fillStyle=warm?'#baa16c':'#96b3ae';g.fillRect(130,24,250,6);
  // Restrained reflections make this read as glazing, not an open doorway.
  g.fillStyle='rgba(137,180,194,.08)';g.beginPath();g.moveTo(0,0);g.lineTo(140,0);
  g.lineTo(350,384);g.lineTo(290,384);g.fill();
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  return new THREE.MeshStandardMaterial({map:texture,emissiveMap:texture,
    emissive:0xffffff,emissiveIntensity:.18,roughness:.48,metalness:.12});
}
