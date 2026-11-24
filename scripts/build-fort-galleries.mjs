import {finishMasonry} from './finish-fort-masonry.mjs';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {galleryBoxes,FORT_GALLERY} from '../src/world/fortaleza-galleries.js';
await fs.mkdir('art/fortaleza-galleries',{recursive:true});
await fs.writeFile('art/fortaleza-galleries/layout.json',JSON.stringify({boxes:galleryBoxes(),dimensions:FORT_GALLERY},null,2));
const r=spawnSync(process.env.BLENDER_EXE||'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  ['-b','--python','art/fortaleza-galleries/build.py'],{stdio:'inherit'});
if (r.status === 0) finishMasonry('public/assets/calle/fortaleza-galleries.glb');
process.exit(r.status??1);
