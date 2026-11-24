import * as T from 'three';
import {cloneUrbanAsset} from './urban-assets.js';
import {galleryThresholds, masonryBox, masonryBuffers, masonrySupports} from './fortaleza-masonry.js';
import {galleryBoxes,FORT_GALLERY as G} from './fortaleza-galleries.js';
// Prioridad del relieve frente a piezas decorativas de otros lotes.
export function finishFortStone(mesh, units) {
  if (!units) return;
  const material = mesh.material.clone();
  material.userData = {};
  material.polygonOffset = true;
  material.polygonOffsetFactor = 0;
  material.polygonOffsetUnits = units;
  mesh.material = material;
}
export function addFortalezaGalleries(world){
  const root=new T.Group();root.name='fortaleza-galleries';world.mapGroup.add(root);
  const asset=cloneUrbanAsset('fortaleza-galleries');
  if(asset){
    root.add(asset);root.userData.blender=true;
    const relief = { Aged_fortress_limestone: 2, Recessed_mortar: -2, Dressed_window_stone: -4 };
    asset.traverse(o=>{
      if(!o.isMesh)return;
      finishFortStone(o, relief[o.name]);
      // Las juntas y los rebordes no proyectan rayas sobre su propia piedra.
      o.castShadow = !['Recessed_mortar','Dressed_window_stone'].includes(o.name);
      if (o.name === 'Aged_fortress_limestone') o.material.shadowSide = T.BackSide;
      o.receiveShadow=true;
    });
  }
  else{
    const stone=new T.MeshStandardMaterial({color:0x938977,roughness:.85});
    const roof=new T.MeshStandardMaterial({color:0x683d24,roughness:.85});
    const boxes=galleryBoxes().map(b => masonryBox(
      [b.x-b.w/2,b.visualBase??b.minY??0,b.z-b.d/2],[b.x+b.w/2,b.h,b.z+b.d/2],b.roof?roof:stone));
    const buffers=masonryBuffers([...boxes,...galleryThresholds(stone),...masonrySupports(false)]);
    for(const [material,b] of buffers) {
      const g=new T.BufferGeometry();
      g.setAttribute('position',new T.Float32BufferAttribute(b.position,3));
      g.setAttribute('normal',new T.Float32BufferAttribute(b.normal,3));
      g.setIndex(b.index);
      const mesh=new T.Mesh(g,material);
      mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);
    }
  }
  const metal=new T.MeshStandardMaterial({color:0x262723,metalness:.5,roughness:.6});
  const lampMat=new T.MeshBasicMaterial({color:0xffc57e});
  // Los faroles de los extremos van junto a la llegada de cada escalera y
  // alcanzan más: con el muro cerrado sobre la puerta ya no entra sol al tramo.
  for(const side of [-1,1])for(const z of [-G.top+.9,G.liza.upperHalf+.45,G.top-.9]){
    const bracket=new T.Mesh(new T.BoxGeometry(.12,.30,.17),metal);
    bracket.position.set(side*(G.outer-.055),4.75,z);root.add(bracket);
    const lamp=new T.Mesh(new T.BoxGeometry(.08,.21,.11),lampMat);
    lamp.position.set(side*25.46,4.76,z);root.add(lamp);
    const light=Math.abs(z)>G.top/2?new T.PointLight(0xffc486,13,11,1.6):new T.PointLight(0xffc486,7,5,2);light.position.set(side*25.25,4.65,z);root.add(light);
  }
}
