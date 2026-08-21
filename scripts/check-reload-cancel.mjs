import assert from 'node:assert/strict';
import { Weapons } from '../src/combat/weapons.js';

// La recarga activa no forma parte de Breach: el estado y la API deben seguir
// ausentes para evitar que un segundo toque otorgue bonus o atasque el arma.
{
  const w = new Weapons();
  w.state.smg.mag = 5;
  assert.equal(w.startReload(), true);
  const remaining = w.st.reload;
  assert.equal(w.startReload(), false);
  assert.equal(w.st.reload, remaining);
  assert.equal(typeof w.tryActiveReload, 'undefined');
  assert.equal('bonusT' in w, false);
  assert.equal('active' in w.st || 'jammed' in w.st, false);
}

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

function insertShell(w) {
  assert.equal(w.cur, 'shotgun');
  assert.ok(w.reloading, 'la escopeta debe estar recargando');
  const before = w.st.mag;
  w.update(w.st.reload + 0.001, false, false, true);
  assert.equal(w.st.mag, before + 1, 'cada ciclo debe confirmar exactamente un cartucho');
  assert.equal(w.reloadInserted, 1, 'debe emitir el evento físico de inserción');
}

for (const start of [7, 4, 1]) {
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = start; w.st.reserve = 24;
  w.startReload();
  const reserve = w.st.reserve;
  assert.equal(w.update(0.18, false, true, true), true,
    `${start}→fire debe cancelar y disparar la munición existente`);
  assert.equal(w.st.mag, start - 1);
  assert.equal(w.st.reserve, reserve, 'cancelar antes de insertar no puede tomar reserva');
}

{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 8;
  w.startReload();
  const firstCycle = w.st.reload;
  assert.equal(w.update(firstCycle * 0.45, false, true, true), false,
    'disparar antes de insertar el primer cartucho no puede producir un tiro');
  assert.equal(w.st.mag, 0, 'iniciar/avanzar parcialmente no puede regalar un cartucho');
  assert.equal(w.reloadInterrupted, false, 'la recarga desde 0 debe continuar');
  insertShell(w);
  assert.equal(w.st.mag, 1);
  assert.equal(w.st.reserve, 7);
  assert.equal(w.update(1 / 60, false, true, true), true,
    '0→insertar 1→fire debe interrumpir y disparar inmediatamente');
  assert.equal(w.st.mag, 0);
  assert.equal(w.reloading, false);
}

{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 8;
  w.startReload();
  insertShell(w); insertShell(w);
  assert.equal(w.st.mag, 2, 'dos ciclos deben dejar dos cartuchos utilizables');
  assert.equal(w.update(1 / 60, false, true, true), true);
  assert.equal(w.st.mag, 1, 'interrumpir después de dos inserciones consume solo el disparo');
}

{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 8;
  w.startReload();
  for (let i = 0; i < 8; i++) insertShell(w);
  assert.equal(w.st.mag, 8, '0→8 debe completar el tubo cartucho por cartucho');
  assert.equal(w.st.reserve, 0);
  assert.equal(w.reloading, false);
}

{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 8;
  w.startReload();
  for (let i = 0; i < 5; i++) {
    assert.equal(w.update(w.def.reloadTime / 6, false, true, true), false,
      'spam durante la primera inserción no debe disparar');
    assert.equal(w.st.mag, 0, 'spam temprano no debe conceder munición');
  }
  insertShell(w);
  assert.equal(w.update(1 / 60, false, true, true), true,
    'el siguiente click tras la inserción sí debe disparar');
}

{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 8;
  w.startReload(); insertShell(w);
  assert.equal(w.startSwap(), true, 'cambiar de arma debe cancelar la recarga por cartucho');
  assert.equal(w.state.shotgun.mag, 1, 'el cartucho ya insertado debe conservarse al cambiar');
  assert.equal(w.state.shotgun.reload, 0);
}

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

console.log('RELOAD CANCEL OK · SMG por cargador · escopeta 0→8 por cartucho · cancel/swap/spam');
