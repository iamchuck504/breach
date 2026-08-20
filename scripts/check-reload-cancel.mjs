import assert from 'node:assert/strict';
import { Weapons } from '../src/combat/weapons.js';

function tacticalCancel(weapon) {
  const w = new Weapons();
  w.cur = weapon;
  const s = w.st;
  s.mag = weapon === 'shotgun' ? 4 : 17;
  s.reserve = weapon === 'shotgun' ? 16 : 80;
  const before = { mag: s.mag, reserve: s.reserve };
  assert.equal(w.startReload(), true, `${weapon}: debe iniciar recarga parcial`);
  w.update(0.35, false, false, true);
  assert.ok(w.reloading, `${weapon}: debe seguir recargando antes del disparo`);

  const fired = w.update(1 / 60, true, true, true);
  assert.equal(fired, true, `${weapon}: la nueva pulsación debe interrumpir y disparar`);
  assert.equal(w.reloading, false, `${weapon}: la recarga debe quedar cancelada`);
  assert.equal(w.reloadInterrupted, true, `${weapon}: debe reportar interrupción este frame`);
  assert.equal(s.mag, before.mag - 1, `${weapon}: debe consumir una bala del cargador anterior`);
  assert.equal(s.reserve, before.reserve, `${weapon}: no debe transferir reserva al cancelar`);
}

tacticalCancel('smg');
tacticalCancel('shotgun');

{
  const w = new Weapons();
  w.st.mag = 12; w.st.reserve = 60;
  w.startReload();
  w.update(0.2, true, false, true);
  assert.equal(w.reloading, true, 'mantener Fire no debe cancelar sin una nueva pulsación');
  assert.equal(w.st.mag, 12, 'mantener Fire no debe consumir munición durante recarga');
}

{
  const w = new Weapons();
  w.st.mag = 9; w.st.reserve = 60;
  w.startReload();
  const fired = w.update(0.2, false, true, false);
  assert.equal(fired, false, 'un tiro bloqueado no debe salir');
  assert.equal(w.reloading, false, 'la intención de disparar sí debe abandonar la recarga');
  assert.equal(w.st.mag, 9, 'el tiro bloqueado no debe gastar munición');
  assert.equal(w.update(1 / 60, false, true, true), true,
    'el tiro bufereado debe poder salir al recuperar una línea válida');
}

{
  const w = new Weapons();
  w.st.mag = 0; w.st.reserve = 30;
  w.startReload();
  const remaining = w.st.reload;
  assert.equal(w.update(0.1, true, true, true), false,
    'un cargador vacío no puede disparar antes de recibir munición');
  assert.equal(w.reloadInterrupted, false, 'la recarga vacía no debe cancelarse mágicamente');
  assert.ok(w.st.reload < remaining && w.st.reload > 0, 'la recarga vacía debe continuar');
  w.update(w.st.reload + 0.01, false, true, true);
  assert.ok(w.st.mag > 0, 'la recarga completa debe transferir munición');
  assert.equal(w.update(1 / 60, false, true, true), true,
    'el disparo bufereado debe salir cuando ya existe una bala válida');
}

console.log('RELOAD CANCEL OK · SMG/escopeta · parcial/bloqueado/vacío · sin munición mágica');
