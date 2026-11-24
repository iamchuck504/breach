// Construcción local con los GLB publicados y el mismo decodificador Draco del juego.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import * as T from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { World } from '../src/world/world.js';
import { ensureMapAssets } from '../src/world/urban-assets.js';
const pixels = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
globalThis.document = { createElement() {
  const canvas = {};
  const ink = createHash('sha256');
  canvas.paintDigest = () => ink.copy().digest('hex');
  const record = (name,args) => {
    ink.update(name+'|');
    for(const arg of args) {
      if(ArrayBuffer.isView(arg?.data)) ink.update(arg.data);
      else if(typeof arg!=='object') ink.update(String(arg)+',');
    }
  };
  const gradient = (...args) => {
    record('gradiente',args);
    return { addColorStop: (...stop) => record('color',stop) };
  };
  const context = new Proxy({
    canvas, measureText: t => ({ width: t.length * 8 }), createImageData: pixels,
    getImageData: (x, y, w, h) => pixels(w, h), createLinearGradient: gradient, createRadialGradient: gradient,
  }, {
    get(target,key) { return target[key] ?? ((...args)=>record(String(key),args)); },
    set(target,key,value) { record(String(key),[value]); target[key]=value; return true; },
  });
  canvas.getContext = () => context;
  return canvas;
} };
globalThis.location = { search: '', href: 'http://local.invalid/' };
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 1;

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
const blobFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const path = typeof input === 'string' ? input : input.url;
  if (path.startsWith('blob:')) return blobFetch(input);
  assert.match(path, /^\/assets\/calle\/[\w-]+\.glb$/);
  return new Response(await readFile(new URL('../public' + path, import.meta.url)));
};
DRACOLoader.prototype._loadLibrary = async (name, type) => {
  const bytes = await readFile(new URL('../public/draco/' + name, import.meta.url));
  return type === 'text' ? bytes.toString() : Uint8Array.from(bytes).buffer;
};
// Three crea el código del worker en un Blob. El puente únicamente adapta su transporte.
globalThis.Worker = class {
  constructor(url) {
    this.ready = resolveObjectURL(url).text().then(source => {
      const bootstrap = `const { parentPort } = require('node:worker_threads');
        globalThis.self = globalThis;
        self.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
        parentPort.on('message', data => self.onmessage({data}));`;
      const worker = new Worker(bootstrap + '\n' + source, { eval: true, execArgv: [] });
      worker.on('message', data => this.onmessage({data}));
      return worker;
    });
  }
  postMessage(data, transfer) { this.ready.then(w => w.postMessage(data, transfer)); }
  terminate() { this.ready.then(w => w.terminate()); }
};

export async function buildMap(layout) {
  assert.equal((await ensureMapAssets(layout)).failed, 0, layout + ': faltan GLB');
  const world = new World(new T.Scene(), layout);
  world.look.setQuality('high');
  world.scene.updateMatrixWorld(true);
  return world;
}
