import {finishMasonry} from './finish-fort-masonry.mjs';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {collisionBoxesFor} from '../src/world/collision-layouts.js';
await fs.writeFile('art/fortress-kit/layout.json',JSON.stringify(collisionBoxesFor('fortaleza'),null,2));
const r=spawnSync(process.env.BLENDER_EXE||'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
 ['-b','--python','art/fortress-kit/build.py'],{stdio:'inherit'});
if (r.status === 0) finishMasonry('public/assets/calle/fortress-kit.glb');
process.exit(r.status??1);
