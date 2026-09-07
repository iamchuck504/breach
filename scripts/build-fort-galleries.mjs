import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {galleryBoxes,FORT_GALLERY} from '../src/world/fortaleza-galleries.js';
await fs.mkdir('art/fortaleza-galleries',{recursive:true});
await fs.writeFile('art/fortaleza-galleries/layout.json',JSON.stringify({boxes:galleryBoxes(),dimensions:FORT_GALLERY},null,2));
const r=spawnSync(process.env.BLENDER_EXE||'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  ['-b','--python','art/fortaleza-galleries/build.py'],{stdio:'inherit'});
process.exit(r.status??1);
