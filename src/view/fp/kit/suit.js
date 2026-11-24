// Guante articulado de buildHand (kit de CRASHTERRA). Las secciones de cuero
// comparten normales; cada falange conserva el pivote y la longitud del soldado.
import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { Builder, T, cbox } from './geometry.js';

const rubber = 'rubber seals', cloth = 'flexible undersuit', plate = 'graphite';
const team = 'painted red';
const v = a => new Vector3(...a);

// Secciones de la bocamanga a los nudillos, o de la articulación a la yema.
function leather(sections) {
  const pos = [], faces = [], sides = 12;
  const curve = u => Math.sign(u) * Math.pow(Math.abs(u), .76);
  for (const [z, width, height, x = 0, y = 0] of sections) {
    for (let i = 0; i < sides; i++) {
      const a = 2 * Math.PI * i / sides;
      pos.push(x + width * 0.5 * curve(Math.cos(a)), y + height * 0.5 * curve(Math.sin(a)), z);
    }
  }
  for (let k = 0; k < sections.length - 1; k++) for (let i = 0; i < sides; i++) {
    const a = k * sides + i, b = k * sides + (i + 1) % sides;
    faces.push(a, a + sides, b, b, a + sides, b + sides);
  }
  const last = pos.length / 3 - sides;
  for (let i = 1; i < sides - 1; i++) faces.push(0, i, i + 1, last, last + i + 1, last + i);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo.toNonIndexed();
}

function digit(w, h, l) {
  return leather([[0.005, w * .76, h * .77], [0, w, h], [-l * .35, w, h],
    [-l * .75, w * .94, h * .94], [-l + .003, w * .86, h * .88], [-l - .003, w * .6, h * .68]]);
}

function palm(hand, finish) {
  const b = new Builder(), trim = new Builder(), web = new Builder();
  const knuckles = v([-.01812, -.0912, .01031]);
  const cuff = v([.01923, -.0665, .02009]);
  const x = v([-.56946, .80436, .16946]).normalize();
  const direction = cuff.clone().sub(knuckles);
  const z = direction.clone().addScaledVector(x, -direction.dot(x)).normalize();
  const y = z.clone().cross(x);
  // Los hitos están en la superficie del dorso. El espesor crece hacia la palma.
  knuckles.addScaledVector(y, -.022);
  cuff.addScaledVector(y, -.022);
  const frame = new Matrix4().makeBasis(x, y, z).setPosition(knuckles);
  b.push(frame);
  const length = direction.dot(z), shift = direction.dot(x);
  const ring = (t, width, height) => [t * length, width, height, t * shift];
  b.add(leather([ring(1.18, .098, .047), ring(1, .112, .056), ring(.68, .131, .060),
    ring(.38, .143, .057), ring(0, .140, .044), ring(-.10, .122, .032)]), null, rubber);
  trim.push(frame);
  trim.add(leather([ring(1.00, .108, .060), ring(.95, .118, .069), ring(.85, .126, .072),
    ring(.80, .124, .069)]), null, plate);
  b.add(cbox(.118, .011, .022, .0045, true), T(shift * .13, .026, length * .13), plate);
  b.add(cbox(.042, .006, .014, .0025, true), T(shift * .56, .0305, length * .56), team);
  b.pop();
  // El acolchado palmar llega hasta los cuatro metacarpos bajo el guardamanos.
  const line = v([-.61, .725, .317]).normalize();
  const near = v([-.127, -.711, .692]);
  near.addScaledVector(line, -line.dot(near)).normalize();
  b.push(new Matrix4().makeBasis(line, near, line.clone().cross(near)).setPosition(.0176, -.111, -.029));
  b.add(leather([[.046, .118, .042], [.029, .143, .036], [.010, .151, .030],
    [-.003, .139, .023]]), null, rubber);
  b.pop();
  // Eminencia tenar: el pulgar nace del dorso por una base de cuero continua.
  const along = v([-.598, .611, .519]).normalize();
  const height = v([-.791, -.348, -.503]).normalize();
  web.push(new Matrix4().makeBasis(height, along.clone().cross(height), along).setPosition(-.0387, -.100, -.0624));
  web.add(leather([[.012, .029, .027, -.006], [-.005, .044, .033, -.014],
    [-.045, .047, .026, -.016, -.003], [-.079, .032, .021, -.029, .001],
    [-.105, .021, .016, -.039, .006]]), null, rubber);
  // El interior de la bocamanga penetra en el brazal incluso al recogerlo en ADS.
  const wrist = v(hand.extras.grip.wrist), joint = cuff.clone().sub(wrist).normalize();
  const cross = x.clone().addScaledVector(joint, -x.dot(joint)).normalize();
  trim.pop().push(new Matrix4().makeBasis(cross, joint.clone().cross(cross), joint).setPosition(cuff));
  trim.add(leather([[.012, .10, .048], [0, .105, .057], [-.033, .084, .047],
    [-cuff.distanceTo(wrist), .047, .043]]), null, cloth);
  return [
    { name: 'smg_hand_L', prims: finish(b), extras: { dorsal: y.toArray(), palmCenter: knuckles.clone().lerp(cuff, .5).toArray() } },
    { name: 'smg_cuff_L', prims: finish(trim) },
    { name: 'smg_web_L', prims: finish(web) },
  ];
}

export function buildHand(hand, finish) {
  const nodes = palm(hand, finish);
  function add(name, b) { nodes.push({ name: 'smg_' + name, prims: finish(b) }); }
  for (const base of hand.children.filter(n => n.name.endsWith('_1'))) {
    const thumb = base.name.includes('thumb');
    const knuckle = new Builder().push(T(...base.translation));
    knuckle.add(leather([[.010, .027, .021], [.004, .037, .030], [-.003, .034, .028],
      [-.010, .025, .021]]), null, thumb ? rubber : plate);
    add(base.name.replace(/_1$/, '_meta'), knuckle);
    for (let joint = base, i = 0; joint; joint = joint.children?.[0], i++) {
      const b = new Builder(), l = -joint.extras.tip[2];
      const w = (thumb ? .040 : .033) - .002 * i, h = (thumb ? .040 : .032) - .0015 * i;
      b.add(digit(w, h, l), null, cloth);
      if (!i && !thumb) {
        // Remate acanalado que acompaña la falange al cerrar la mano.
        b.add(leather([[.002, w * .90, h], [-.004, w * 1.04, h * 1.07],
          [-.017, w, h * 1.05], [-.020, w * .92, h]]), null, plate);
      }
      if (!i || thumb) b.add(digit(w * .82, h * .32, l * .63), T(0, h * .44, -l * .13), cloth);
      add(joint.name, b);
    }
  }
  // Distintivo pintado sobre la placa original del antebrazo.
  const badge = new Builder(), normal = v([.782, -.3707, .501]).normalize();
  const across = v([.541, 0, -.841]).normalize();
  const center = v([.0406, -.2108, .1087]).lerp(v([.0668, -.3089, -.0048]), .49)
    .addScaledVector(normal, .0018);
  badge.push(new Matrix4().makeBasis(across, normal.clone().cross(across).normalize(), normal).setPosition(center));
  badge.add(cbox(.057, .023, .004, .0015, true), null, team);
  add('badge_L', badge);
  return nodes;
}
