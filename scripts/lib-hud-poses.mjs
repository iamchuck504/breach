// Recorre la entrada, la postura sostenida y la recuperación a 60 Hz.
// El cambio recorre la pista común de guardar y sacar para cada arma.
import { TUNING } from '../src/config/tuning.js';
import { SWAP_TIME } from '../src/combat/weapons.js';

export function sampleHudPose(vm, pose, sample) {
  const state = { bob: 1, shake: 1, aim01: 0, speed: 0, sprint: false, crouch01: 0 };
  const dt = 1 / 60, key = vm.key, prof = vm.weapons[key].prof;
  const step = () => {
    const scoped = prof.scope && vm.scopeIn01() >= 0.98 && state.aim01 > 0;
    vm.update(dt, state, scoped ? 'step' : true);
    if (vm.key === key) sample(vm.hudZones());
  };
  // Permite terminar los fundidos de la muestra anterior.
  for (let i = 0; i < 100; i++) vm.update(dt, state);
  if (pose === 'hip') { step(); return; }
  if (pose === 'swap') {
    // Igual que FpAdapter: el modelo cambia a mitad de la pista. A la
    // vuelta se mide cómo aparece el arma original desde el perfil entrante.
    for (const next of [key === 'smg' ? 'pistol' : 'smg', key]) {
      vm.event('swapStart', { total: SWAP_TIME });
      for (let i = 1; i <= Math.ceil(SWAP_TIME * 60); i++) {
        state.swapping = Math.min(1, i * dt / SWAP_TIME);
        if (state.swapping >= 0.5 && vm.key !== next) {
          vm.setWeapon(next);
          vm.event('swapStart', { total: SWAP_TIME, draw: true });
        }
        step();
      }
      vm.event('swapEnd');
    }
    state.swapping = 0;
  } else if (pose === 'reload') {
    const def = TUNING.weapons[vm.key], frames = Math.ceil(def.reloadTime * 60);
    const shells = def.perShell ? 2 : 1;
    vm.event('reloadStart', { total: def.reloadTime * shells });
    for (let shell = 0; shell < shells; shell++) {
      for (let i = 1; i <= frames; i++) {
        state.reloadT = i / frames;
        for (const event of prof.reload.steps ?? []) {
          if (event.t > (i - 1) / frames && event.t <= state.reloadT) vm.event('reloadStep', { name: event.step });
        }
        step();
      }
      if (def.perShell) vm.event('reloadStep', { name: 'shellIn' });
    }
    if (def.perShell) vm.event('reloadStep', { name: 'pump' });
    vm.event('reloadEnd');
    state.reloadT = 0;
  } else {
    state.aim01 = +(pose === 'ads');
    state.sprint = pose === 'sprint';
    state.speed = state.sprint ? 6 : 0;
    state.crouch01 = +(pose === 'crouch');
    for (let i = 0; i < 60; i++) step();
    state.aim01 = state.crouch01 = state.speed = 0;
    state.sprint = false;
  }
  for (let i = 0; i < 45; i++) step();
}
