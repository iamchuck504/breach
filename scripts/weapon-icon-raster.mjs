// Proyección ortográfica lateral con profundidad por píxel. Los huecos de
// culata, guardamonte y anilla conservan el alfa del fondo.
import { deflateSync, crc32 } from 'node:zlib';
import { Color } from 'three';
import { weaponSurface } from '../src/player/weapon-surface.js';

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function renderWeaponIcon(key, json, chunks) {
  const width = 480, height = 160, stride = width * 4 + 1;
  const image = Buffer.alloc(height * stride);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const primitives = [];
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const node of json.nodes.filter(n => n.mesh != null)) {
    const [ox, oy, oz] = node.translation ?? [0, 0, 0];
    for (const p of json.meshes[node.mesh].primitives) {
      const positions = chunks[p.attributes.POSITION].data;
      const vertices = [];
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
        const u = -z, v = -y - x * 0.12;
        left = Math.min(left, u); right = Math.max(right, u);
        top = Math.min(top, v); bottom = Math.max(bottom, v);
        vertices.push([u, v, -x + y * 0.12]);
      }
      const material = json.materials[p.material], pbr = material.pbrMetallicRoughness ?? {};
      const surf = weaponSurface({ name: material.name, color: new Color().fromArray(pbr.baseColorFactor ?? [1, 1, 1]),
        roughness: pbr.roughnessFactor ?? 1, metalness: pbr.metallicFactor ?? 1,
        emissiveIntensity: material.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1 }, key);
      primitives.push({ vertices, indices: chunks[p.indices].data, color: surf.color });
    }
  }
  const zoom = Math.min((width - 12) / (right - left), (height - 8) / (bottom - top));
  for (const { vertices, indices, color } of primitives) {
    for (const v of vertices) {
      v[0] = width / 2 + (v[0] - (left + right) / 2) * zoom;
      v[1] = height / 2 + (v[1] - (top + bottom) / 2) * zoom;
      v[2] *= zoom;
    }
    for (let i = 0; i < indices.length; i += 3) {
      const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]];
      const bx = b[0]-a[0], by = b[1]-a[1], bz = b[2]-a[2];
      const cx = c[0]-a[0], cy = c[1]-a[1], cz = c[2]-a[2];
      const nz = bx*cy-by*cx;
      if (Math.abs(nz) < 1e-8) continue;
      const nx = by*cz-bz*cy, ny = bz*cx-bx*cz;
      const light = 0.75 + 0.65 * Math.max(0, Math.sign(nz) * (nz-ny*0.7-nx*0.3) / Math.hypot(nx,ny,nz));
      const rgb = color.clone().multiplyScalar(light).convertLinearToSRGB().toArray().map(x => Math.min(255, Math.round(255*x)));
      for (let y = Math.floor(Math.min(a[1],b[1],c[1])); y <= Math.ceil(Math.max(a[1],b[1],c[1])); y++) {
        for (let x = Math.floor(Math.min(a[0],b[0],c[0])); x <= Math.ceil(Math.max(a[0],b[0],c[0])); x++) {
          const dx = x+0.5-a[0], dy = y+0.5-a[1];
          const u = (dx*cy-dy*cx)/nz, v = (bx*dy-by*dx)/nz;
          if (u < 0 || v < 0 || u+v > 1) continue;
          const z = a[2] + u*bz + v*cz, j = y*width+x;
          if (z < depth[j]) continue;
          depth[j] = z;
          const offset = y*stride + 1 + x*4;
          image[offset] = rgb[0]; image[offset+1] = rgb[1]; image[offset+2] = rgb[2]; image[offset+3] = 255;
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(image)), pngChunk('IEND', Buffer.alloc(0))]);
}
