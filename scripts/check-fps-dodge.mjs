// Esquiva completa sin WebGL ni sockets. La red recibe los paquetes reales
// de NetClient, ordenados como TCP, con jitter y una pausa a medio impulso.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { attachBlenderSoldier } from '../src/player/blender-soldier.js';
import { Controller } from '../src/player/controller.js';
import { World } from '../src/world/world.js';
import { NetClient } from '../src/net/client.js';
import { ImagePipeline } from '../src/render/pipeline.js';
import { dodgeFX } from '../src/view/fp/dodge-fx.js';
import { Rig } from '../src/player/rig.js';
import { Audio } from '../src/fx/audio.js';
import { canFireInState, MOVE_GATES } from '../src/combat/fire-gates.js';
import { resolveShot } from '../src/combat/ballistics.js';
import { hitFields, hitPose, placeHitPose } from '../src/combat/hit-pose.js';
import { Weapons } from '../src/combat/weapons.js';
import { FirstPersonCamera, ShoulderCamera } from '../src/core/camera.js';
import { acceptMovement, acceptPosture, advanceCadenceClock, dodgeFireReady } from '../server/guards.js';
import { TUNING } from '../src/config/tuning.js';

const D = MOVE_GATES.dodge;
const near = (a,b,tol=1e-8) => assert.ok(Math.abs(a-b) <= tol, `${a} ≠ ${b} (±${tol})`);
function setup(boxes = [], ev = {}) {
  const w = Object.create(World.prototype);
  w.colliders = boxes; w.segmentColliders = []; w.faces = [];
  w.groundHeight = () => 0; w.ceilingHeight = () => Infinity;
  const cam = new THREE.PerspectiveCamera(72,16/9,0.03,200);
  const look = new ShoulderCamera(cam,w);
  const p = new Controller(w,look,ev); p.respawn({x:0,z:0,yaw:0});
  const input = { mv:{x:1,z:0}, moveVec() { return this.mv; } };
  const weapons = new Weapons(); p.bindWeapons(weapons);
  return {w,cam,look,p,input,weapons};
}

for (const hz of [30,60,144]) {
  for (const [x,z] of [[1,0],[-1,0],[0,-1],[0,1],[1,1],[0,0]]) {
    const events = [], audio = Object.create(Audio.prototype);
    audio._play = k => { events.push(k); return true; };
    audio.footstep = k => events.push(k);
    const {p,input,weapons} = setup([], {onDodgeStart:()=>audio.dodgeStart(),onDodgeEnd:()=>audio.dodgeEnd()});
    p.cam.yaw = Math.PI/2; input.mv = {x,z}; input.aimHeld = true;
    weapons.st.mag--; weapons.startReload();
    for (let i=0; i<Math.ceil(hz*D.duration); i++) {
      input.evadePressed = true; p.update(1/hz,input,true); p.settle();
      weapons.update(1/hz,false,false,p.fireAligned(),true);
      assert.ok(weapons.reloading);
      if (p.dodge) {
        assert.equal(p.aim,false); assert.equal(p.fireAligned(),false);
        assert.equal(p.animState(),'dodge');
        const fields = hitFields({st:'dodge'},p.pos.x,p.y,p.pos.z,p.yaw);
        const h = fields.hit;
        const hit = resolveShot({raycast:()=>null},[{id:'p',alive:true,...fields}],
          new THREE.Vector3(h.hx,h.hy,h.hz+8),new THREE.Vector3(0,0,-1),15);
        assert.equal(hit.part,'head');
      }
    }
    const len = Math.hypot(x,z);
    near(p.pos.x,len ? -3.3*z/len : 3.3);
    near(p.pos.z,len ? -3.3*x/len : 0);
    near(p.dodgeCd,D.minCycle - Math.ceil(hz*D.duration)/hz);
    assert.deepEqual(events,['dodge_air','cloth','run','shuffle']);
    input.evadePressed = false; input.aimHeld = false;
    for (let i=0; i<Math.ceil(0.15*hz)+1; i++) p.update(1/hz,input,false);
    assert.ok(p.fireAligned());
    input.evadePressed = true;
    while(p.dodgeCd > 1e-8) { p.update(1/hz,input,false); assert.ok(!p.dodge); }
    p.update(1/hz,input,false); assert.ok(p.dodge);
  }
  for (const height of [1.1,3]) {
    const {p,input} = setup([{minx:1,maxx:1.1,minz:-4,maxz:4,h:height}]);
    input.evadePressed = true;
    for(let i=0;i<hz*0.4;i++) { p.update(1/hz,input,false); p.settle(); assert.ok(p.headClear()); }
    near(p.pos.x,0.62,0.002);
  }
  const ledge = setup();
  ledge.w.groundHeight = pos => pos.x > 1 ? -2 : 0;
  ledge.input.evadePressed = true;
  for(let i=0;i<hz*D.duration;i++) ledge.p.update(1/hz,ledge.input,false);
  assert.ok(ledge.p.pos.x <= 1 && ledge.p.y === 0);
}
{
  const e = { fps:true };
  for (let i=0; i<=20; i++) acceptPosture(e,{st:'idle',ce:1,cl:i/20},i/60,i/60);
  assert.equal(acceptPosture(e,{st:'dodge',ce:1,cl:0},0.35,0.35).cl,0);
}
for (const w of Object.keys(TUNING.weapons)) assert.equal(canFireInState('dodge',w),false);
{
  const {p,input} = setup();
  p.dodgeCd = 0.10; input.evadePressed = true;
  p.update(0.02,input,false);
  input.evadePressed = false; input.mv = {x:-1,z:0};
  for (let i=0; i<6; i++) p.update(0.02,input,false);
  assert.ok(p.dodge && p.dodge.x === 1);
}
for (const block of ['air','crouch','slide','mantle','melee','throw']) {
  const {p,input,weapons} = setup();
  input.evadePressed = true;
  if (block === 'air') { p.grounded = false; p.y = 1; }
  if (block === 'crouch') { p.state = 'crouch'; p.crouch01 = 1; input.crouchHeld = true; }
  if (block === 'slide') p._beginSlide({mag:0});
  if (block === 'melee') p._beginMelee();
  if (block === 'mantle') { p.state = 'mantle'; p.mantle = {t:0,dur:1,fx:0,fz:0,tx2:1,tz2:0,fy:0,ty:1,n:{x:1,z:0}}; }
  if (block === 'throw') weapons._throw = {released:false};
  p.update(1/60,input,false); assert.ok(!p.dodge,block);
}

for (const hz of [30,60,144]) {
  const {p,input,weapons} = setup(), net = new NetClient();
  const entity = {fps:true,x:0,y:0,z:0,st:'idle'};
  let clock=0, arrival=0, n=0, starts=0;
  net.connected = true;
  p.poseClock = () => clock;
  net.send = m => {
    const jitter = 0.065 * Math.sin(++n*1.7);
    const pause = m.ct > 0.66 ? 0.45 : 0;
    const retenido = m.ct >= 2.08 && m.ct <= 2.26 ? 2.26 : m.ct;
    arrival = Math.max(arrival, retenido + 0.08 + jitter + pause);
    advanceCadenceClock(entity,m.ct,arrival);
    assert.ok(acceptMovement(entity,m,arrival), 'paquete honesto '+JSON.stringify(m));
    if (m.st === 'dodge' && entity.st !== 'dodge') starts++;
    Object.assign(entity,{x:m.x,y:m.y,z:m.z,st:m.st});
    if (m.st === 'dodge') assert.equal(dodgeFireReady(entity,'smg'),false);
  };
  for (let i=0;i<hz*4;i++) {
    clock = (i+1)/hz;
    input.evadePressed = i===Math.floor(hz/2) || i===Math.floor(hz/2)+Math.ceil(hz*D.minCycle);
    p.update(1/hz,input,false); net.tickState(1/hz,p,weapons,clock);
  }
  assert.equal(starts,2); assert.ok(dodgeFireReady(entity,'smg'));
}
{
  const e = {fps:true,st:'idle',x:0,y:0,z:0};
  function sample(ct,st,dg,x=0) {
    advanceCadenceClock(e,ct,ct);
    const ok = acceptMovement(e,{x,y:0,z:0,st,ct,dg},ct);
    if(ok) Object.assign(e,{st,x});
    return ok;
  }
  assert.ok(sample(0,'idle'));
  e.motionGuard.throwReleaseCt = 0.28;
  assert.ok(!sample(0.01,'dodge',0.01));
  delete e.motionGuard.throwReleaseCt;
  assert.ok(sample(0.02,'dodge',0.02));
  assert.ok(!sample(0.12,'dodge',0.12,2.8));
  assert.ok(!sample(0.14,'idle') && !sample(0.15,'dodge',0.02));
  assert.ok(!sample(0.32,'dodge',0.32) && !sample(0.33,'dodge',0.29));
  assert.ok(sample(0.34,'idle')); assert.equal(dodgeFireReady(e,'smg'),false);
  assert.ok(!sample(0.6,'dodge',0.02));
  assert.ok(sample(1.52,'dodge',0.02));
}

{
  const {cam,look,p,w} = setup();
  const fp = new FirstPersonCamera(cam,w,look);
  p.state = 'dodge';
  const pose = {st:'dodge'};
  const axis = new THREE.Vector3(0,0,-1).applyAxisAngle(new THREE.Vector3(1,0,0),look.pitch);
  for (const dt of [1/144,1/30,0.1]) for (const reduceMotion of [false,true]) {
    const settings = {fov:72,bob:1,shake:1,reduceMotion};
    for(let i=0;i<=30;i++) {
      p.dodge = {t:i/100,x:1,z:0};
      fp.update(dt,p,{pose,settings});
      near(cam.getWorldDirection(new THREE.Vector3()).distanceTo(axis),0);
      near(cam.position.distanceTo(new THREE.Vector3(...p.eyeWorld())),0);
      const fx = cam.userData.dodgeFX;
      if (reduceMotion) { near(fx.blur,0); near(fx.roll,0); assert.ok(cam.fov<=72.5); }
      else assert.ok(cam.fov<=81.01 && cam.fov>=70.89);
      const fov = cam.fov, q = cam.quaternion.clone();
      fp.update(0,p,{pose,settings}); near(cam.fov,fov); near(cam.quaternion.angleTo(q),0,1e-7);
    }
  }
}

// El pase gráfico solo se dibuja con impulso periférico. La intensidad
// a media aceleración se comprueba también para los ajustes de comodidad.
{
  const targets = [], draws = [];
  const renderer = { getDrawingBufferSize: v => v.set(1280,720), setRenderTarget: rt => targets.push(rt),
    render: scene => draws.push(scene) };
  const pipe = new ImagePipeline(renderer), scene = new THREE.Scene(), {cam} = setup();
  for (const reduceMotion of [true,false]) {
    for (const side of [-1,1]) {
      const fx = dodgeFX({t:0.054,x:side,z:0},0,{reduceMotion,bob:1,shake:1});
      near(fx.roll,reduceMotion ? 0 : -7*side); near(fx.fov,reduceMotion ? 0.5 : 9);
      cam.userData.dodgeFX = fx; draws.length=0; targets.length=0;
      pipe.render(scene,cam);
      assert.equal(draws.length,reduceMotion ? 1 : 2);
      assert.equal(targets.at(-1),null);
      if (!reduceMotion) assert.equal(pipe.quad.material,pipe.mDodge);
    }
  }
  cam.userData.dodgeFX = null; draws.length=0; pipe.render(scene,cam); assert.equal(draws.length,1);
}

// Calibración relativa al reposo, como calibrate-hit-pose. Se mide el centro
// del casco sobre el esqueleto dibujado, no una segunda evaluación de hitPose.
{
  const rig = new Rig(new THREE.Scene(),'red'), v = new THREE.Vector3();
  GLTFLoader.prototype.loadAsync = async function (url) {
    const bytes = await readFile(new URL('../public' + url, import.meta.url));
    return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  };
  await attachBlenderSoldier(rig);
  const mesh = rig._bodyMesh, bones = mesh.skeleton.bones;
  const head = mesh.geometry.attributes.skinIndex, indices = [];
  for (let i = 0; i < head.count; i++) {
    const bone = bones[head.getX(i)];
    if (bone === rig.head || bone.userData.runtimeTarget === 'head') indices.push(i);
  }
  assert.ok(indices.length);
  const sample = () => {
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3(), visor = new THREE.Vector3();
    let count = 0;
    for (const i of indices) {
      mesh.getVertexPosition(i,v).applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(v);
      if (bones[head.getX(i)] === rig.head) { visor.add(v); count++; }
    }
    return box.getCenter(new THREE.Vector3()).lerp(visor.divideScalar(count),0.5);
  };
  const idle = {state:'idle',speed:0,aim:false,aimPitch:0,interpolated:true};
  for(let i=0;i<60;i++) rig.update(1/60,idle);
  const zero = sample(), origin = hitPose({st:'idle'}).h;
  for(const [side,front] of [[-1,0],[1,0],[0,-1],[0,1]]) for(let i=0;i<=18;i++) {
    const since=i/60, pose={st:'dodge',from:{st:'idle'},fromTo:{st:'dodge'},since};
    if (!i) for(let k=0;k<60;k++) rig.update(1/60,idle);
    rig.update(1/60,{...idle,state:'dodge',moveSide:side,moveForward:front,evadePhase:i/18,poseTr:pose});
    const delta=sample().sub(zero), target=placeHitPose(hitPose(pose),0,0,0,0);
    assert.ok(Math.hypot(delta.x+origin[1]-target.hx,delta.y+origin[2]-target.hy,delta.z-origin[0]-target.hz)<0.025);
    if (side) {
      const l = rig.legL.ankle.getWorldPosition(new THREE.Vector3());
      const r = rig.legR.ankle.getWorldPosition(new THREE.Vector3());
      assert.ok(r.x-l.x > 0.30, 'las botas se cruzaron');
      const lift = (r.y-l.y)*side;
      if (i === 6) assert.ok(lift > 0.08, 'el pie que abre el paso debe despegar');
      if (i === 15) assert.ok(lift < -0.08, 'el pie que frenó debe recibir el peso');
    }
  }
}
console.log('ESQUIVA FPS OK · cuatro rumbos, diagonal, 30/60/144 Hz, geometría, acciones, red, casco, cámara y sonido');
