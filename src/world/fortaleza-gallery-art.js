import * as T from 'three';
import {cloneUrbanAsset} from './urban-assets.js';
import {galleryBoxes,FORT_GALLERY as G} from './fortaleza-galleries.js';
export function addFortalezaGalleries(world){
  const root=new T.Group();root.name='fortaleza-galleries';world.mapGroup.add(root);
  const asset=cloneUrbanAsset('fortaleza-galleries');
  if(asset){root.add(asset);root.userData.blender=true;asset.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});}
  else{
    const stone=new T.MeshStandardMaterial({color:0x938977,roughness:.85});
    const roof=new T.MeshStandardMaterial({color:0x683d24,roughness:.85});
    for(const b of galleryBoxes()){
      const low=b.visualBase??b.minY??0;
      const m=new T.Mesh(new T.BoxGeometry(b.w,b.h-low,b.d),b.roof?roof:stone);
      m.position.set(b.x,(b.h+low)/2,b.z);m.castShadow=true;m.receiveShadow=true;root.add(m);
    }
  }
  const metal=new T.MeshStandardMaterial({color:0x262723,metalness:.5,roughness:.6});
  const lampMat=new T.MeshBasicMaterial({color:0xffc57e});
  for(const side of [-1,1])for(const z of [-G.top+2,0,G.top-2]){
    const bracket=new T.Mesh(new T.BoxGeometry(.08,.30,.17),metal);
    bracket.position.set(side*25.52,4.75,z);root.add(bracket);
    const lamp=new T.Mesh(new T.BoxGeometry(.08,.21,.11),lampMat);
    lamp.position.set(side*25.46,4.76,z);root.add(lamp);
    const light=new T.PointLight(0xffc486,7,5,2);light.position.set(side*25.25,4.65,z);root.add(light);
  }
}
