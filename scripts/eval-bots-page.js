// Instrumentación de la evaluación de bots (se evalúa DENTRO de la página, ver
// scripts/eval-bots.mjs). Mide lo que un jugador vive en una partida contra
// bots: atascos (intención de moverse sin avanzar), tiempo ocioso, mirar la
// pared, contacto, tiro, cobertura, agrupamiento, reacción al flanqueo, y
// —con jugador guionizado— qué hacen los bots ante cada comportamiento humano.
// Todo con el reloj de simulación (dt), no con el de pared.
(function install(cfg) {
  const G = window.BREACH, M = G.botMatch, W = window.BREACH_WORLD, T = window.THREE;
  const R = window.BREACH_RENDERER, scene = W.mapGroup.parent;
  const human = cfg.mode === 'human';
  const ev = window.__ev = {
    cfg, playT: 0, totalT: 0, rounds: [], deaths: [], heat: {}, blockedHeat: {}, jitterHeat: {}, jitterBy: {}, jitterSamples: [], idleBy: {}, jitterT: 0, episodes: [], frames: [],
    bots: {}, shots: {}, kit: { smoke: 0, melee: 0, meleeHit: 0, special: 0, rocket: 0, frag: 0 },
    recover: {}, groupSamples: 0, group3: 0, pairsClose: 0, samples: 0,
    turnToHit: [], allyDeathTurn: [], segments: [], humanDeaths: [], cost: { n: 0, sum: 0, hist: new Array(60).fill(0), max: 0 },
    firstContact: [], intoCover: 0, stateTime: {}, idleT: 0, wallT: 0, backT: 0, aliveT: 0, intentT: 0, blockedT: 0, stuckT: 0,
    spawnWaitT: 0, doorwayDeaths: 0, trades: { humanDeaths: 0, traded: 0 }, allyNearHuman: { inContact: 0, withAlly: 0 },
  };
  const _o = new T.Vector3(), _d = new T.Vector3();
  const los = (ax, ay, az, bx, by, bz) => {
    _o.set(ax, ay, az); _d.set(bx - ax, by - ay, bz - az);
    const len = _d.length(); if (len < 0.01) return true;
    _d.multiplyScalar(1 / len);
    if (W.raycast(_o, _d, len - 0.3) !== null) return false;
    return !window.BREACH_SMOKE?.blocksSegment?.(ax, ay, az, bx, by, bz);
  };
  const cellKey = (x, z) => `${Math.floor(x)},${Math.floor(z)}`;
  const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  const yawTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));
  const playing = () => M.phase === 'playing';
  const roundT = () => 300 - M.timer;

  // ---------- jugador fuera (solo bots) o jugador guionizado ----------
  if (!human) {
    M.cb.player = () => ({ x: 0, z: 0, y: 0, alive: false });
    M.cb.damagePlayer = () => false;
    M.addExternalBot({ id: 'bot-sim', name: 'Sim', team: M.playerTeam, spawn: W.spawns[M.playerTeam][1] });
  }
  const P = () => G.player;
  const humanAlive = () => human && G.selfAlive && P() && !P().dead;
  const humanPos = () => ({ x: P().pos.x, z: P().pos.z, y: P().y });
  const enemyTeam = M.playerTeam === 'red' ? 'blue' : 'red';
  const all = () => M.bots;
  const statOf = (b) => (ev.bots[b.id] ??= { team: b.team, intentT: 0, blockedT: 0, stuckT: 0, aliveT: 0, idleT: 0, wallT: 0, episodes: 0 });

  // ---------- costo de la IA por paso ----------
  const mUpdate = M.update.bind(M);
  M.update = (dt) => {
    const was = M.phase;
    const t0 = performance.now();
    mUpdate(dt);
    const ms = performance.now() - t0;
    ev.totalT += dt;
    if (was === 'playing') {
      ev.playT += dt;
      const c = ev.cost; c.n++; c.sum += ms; c.max = Math.max(c.max, ms);
      c.hist[Math.min(59, Math.floor(ms / 0.05))]++;
      afterStep(dt);
    }
  };

  // ---------- ganchos de bots ----------
  const proto = Object.getPrototypeOf(M.bots[0]);
  const steer = proto._steer;
  proto._steer = function (...a) { this.__steer = true; const r = steer.apply(this, a); this.__sx = r?.x ?? 0; this.__sz = r?.z ?? 0; this.__sg = a[3] ? [+a[3].x.toFixed(1), +a[3].z.toFixed(1)] : null; return r; };
  const rec = proto._recoverFromStuck;
  proto._recoverFromStuck = function (match, contact, requested, goal, reason = 'blocked') {
    ev.recover[reason] = (ev.recover[reason] ?? 0) + 1;
    if (this.__ep) this.__ep.recoveries++;
    return rec.call(this, match, contact, requested, goal, reason);
  };
  const upd = proto.update;
  proto.update = function (dt, match) {
    if (match !== M || !playing() || !this.alive) { this.__steer = false; return upd.call(this, dt, match); }
    const bx = this.pos.x, bz = this.pos.z;
    // ¿algo fuera de update lo movió desde el paso anterior?
    if (this.__ax !== undefined) { const ext = Math.hypot(bx - this.__ax, bz - this.__az); this.__ext = Math.max(this.__ext ?? 0, ext); }
    this.__steer = false;
    upd.call(this, dt, match);
    this.__ax = this.pos.x; this.__az = this.pos.z;
    this.__inner = Math.hypot(this.pos.x - bx, this.pos.z - bz);
    if (!this.alive) return;
    measureBot(this, dt, Math.hypot(this.pos.x - bx, this.pos.z - bz));
  };
  const shoot = M.botShoot.bind(M);
  let curShot = null;
  M.botShoot = (bot, enemy) => {
    const d = Math.hypot(enemy.x - bot.pos.x, enemy.z - bot.pos.z);
    const band = d < 8 ? '0-8' : d < 18 ? '8-18' : d < 30 ? '18-30' : '30+';
    const key = `${bot.wep}:${band}`;
    const s = (ev.shots[key] ??= { shots: 0, hits: 0, dmg: 0, atHuman: 0, hitsHuman: 0 });
    // ¿la línea al pecho del blanco ya estaba tapada? (tiro contra cobertura)
    const covered = !los(bot.pos.x, bot.y + 1.35, bot.pos.z, enemy.x, (enemy.y ?? 0) + (enemy.crouch ? 0.7 : 1.1), enemy.z) &&
        !los(bot.pos.x, bot.y + 1.35, bot.pos.z, enemy.x, (enemy.y ?? 0) + (enemy.crouch ? 0.95 : 1.5), enemy.z);
    curShot = { s, bot, enemy, hit: false };
    const r = shoot(bot, enemy);
    curShot = null;
    // solo cuentan los tiros que SALIERON (botShoot puede declinar: línea
    // tapada, humo); antes se contaban los intentos e inflaban el denominador
    if (r === false) return r;
    s.shots++;
    if (enemy.id === 'player') s.atHuman++;
    if (covered) ev.intoCover++;
    if (enemy.id === 'player' && segment) { segment.shotsAt++; if (segment.firstShotAt == null) segment.firstShotAt = segment.t; }
    if (rnd && rnd.firstShot == null) rnd.firstShot = roundT();
    return r;
  };
  const dmgBot = M.damageBot.bind(M);
  M.damageBot = (id, dmg, from, gib, silent, ctx) => {
    const b = M.botById(id);
    const before = b?.hp;
    const r = dmgBot(id, dmg, from, gib, silent, ctx);
    if (b && before !== undefined && b.hp < before) {
      if (curShot && !curShot.hit) { curShot.hit = true; curShot.s.hits++; }
      if (curShot) curShot.s.dmg += before - b.hp;
      if (from === 'player' && segment) segment.dmgDealt += before - Math.max(0, b.hp);
      if (b.alive) watchHit(b, from);
      if (rnd && rnd.firstShot == null) rnd.firstShot = roundT();
    }
    return r;
  };
  if (human) {
    const dp = M.cb.damagePlayer;
    M.cb.damagePlayer = (dmg, name, shooter, ctx) => {
      if (lab.god) {
        if (curShot && !curShot.hit) { curShot.hit = true; curShot.s.hits++; curShot.s.hitsHuman++; }
        if (curShot) curShot.s.dmg += dmg;
        lab.onDamage?.(dmg);
        return false;
      }
      if (curShot && !curShot.hit) { curShot.hit = true; curShot.s.hits++; curShot.s.hitsHuman++; }
      if (curShot) curShot.s.dmg += dmg;
      if (segment) {
        segment.dmgTaken += dmg;
        // ¿de dónde vino? ángulo entre la mirada del humano y el tirador
        if (shooter) {
          const a = Math.abs(angDiff(P().cam.yaw, yawTo(P().pos.x, P().pos.z, shooter.x, shooter.z)));
          if (a > Math.PI / 2) segment.hitsFromBehind++;
          segment.hitsTaken++;
        }
      }
      return dp(dmg, name, shooter, ctx);
    };
  }
  const wrapKit = (name, key, after) => {
    const f = M[name].bind(M);
    M[name] = (...a) => { const r = f(...a); if (after ? after(r) : true) ev.kit[key]++; return r; };
  };
  wrapKit('botThrowSmoke', 'smoke', (r) => r);
  wrapKit('botMelee', 'melee');
  wrapKit('botFireRocket', 'rocket');
  const melee = M.botMelee;
  M.botMelee = (bot) => { const r = melee(bot); if (r.connected) ev.kit.meleeHit++; return r; };
  const take = M.botTakeSpecial.bind(M);
  M.botTakeSpecial = (bot) => { const had = bot.wep; const r = take(bot); if (bot.wep !== had) ev.kit.special++; return r; };

  // ---------- rondas, muertes ----------
  let rnd = null;
  const startRnd = () => { rnd = { t0: ev.playT, firstShot: null }; try { humanCtl.firedThisRound = false; } catch {} };
  const endRound = M._endRound.bind(M);
  M._endRound = (winner) => {
    const lives = { red: M.livesOf('red'), blue: M.livesOf('blue') };
    const secs = +roundT().toFixed(1);
    endRound(winner);
    ev.rounds.push({ winner, seconds: secs, timeout: M.timer <= 0.05, lives, firstShot: rnd?.firstShot ?? null });
    startRnd();
    if (M.phase === 'final') { M.phase = 'intermission'; M.phaseT = 2; M.matchWinner = null; }
    M.wins = { red: 0, blue: 0 };
  };
  startRnd();
  const onDeath = M._onDeath.bind(M);
  const recentDeaths = [];
  M._onDeath = (victimId, killerId, gib, ctx) => {
    if (playing()) {
      const v = victimId === 'player' ? (human ? { team: M.playerTeam, pos: P().pos, y: P().y } : null) : M.botById(victimId);
      const k = killerId === 'player' ? (human ? { team: M.playerTeam, pos: P().pos, id: 'player' } : null) : M.botById(killerId);
      if (v) {
        const d = { victim: victimId, team: v.team, t: +roundT().toFixed(1), x: +v.pos.x.toFixed(1), z: +v.pos.z.toFixed(1),
          range: k ? +Math.hypot(k.pos.x - v.pos.x, k.pos.z - v.pos.z).toFixed(1) : null, wep: k?.wep ?? (killerId === 'player' ? 'human' : null),
          state: v.state ?? 'human', killer: killerId };
        // "el mismo portal": otra baja del mismo equipo a <4 m en los últimos 8 s
        if (recentDeaths.some((o) => o.team === d.team && ev.playT - o.at < 8 && Math.hypot(o.x - d.x, o.z - d.z) < 4)) { ev.doorwayDeaths++; d.sameSpot = true; }
        recentDeaths.push({ team: d.team, x: d.x, z: d.z, at: ev.playT });
        if (recentDeaths.length > 30) recentDeaths.shift();
        ev.deaths.push(d);
        if (victimId === 'player') { ev.trades.humanDeaths++; pendingTrade = { killer: killerId, until: ev.playT + 5 }; if (segment) segment.deaths++; }
        if (pendingTrade && victimId === pendingTrade.killer && ev.playT < pendingTrade.until) { ev.trades.traded++; pendingTrade = null; }
        if (killerId === 'player' && segment) segment.kills++;
        // aliados del muerto que estaban cerca: ¿se vuelven hacia el asesino?
        if (k && k.pos) for (const a of all()) {
          if (!a.alive || a.team !== v.team || a.id === victimId) continue;
          if (Math.hypot(a.pos.x - v.pos.x, a.pos.z - v.pos.z) > 12) continue;
          allyWatch.push({ bot: a, kx: k.pos.x, kz: k.pos.z, killer: killerId, t: 0 });
        }
      }
    }
    return onDeath(victimId, killerId, gib, ctx);
  };
  let pendingTrade = null;
  const allyWatch = [];
  const hitWatch = [];
  function watchHit(b, from) {
    if (hitWatch.some((h) => h.bot === b)) return;
    const a = from === 'player' ? (human ? P().pos : null) : M.botById(from)?.pos;
    if (!a) return;
    // solo golpes desde fuera de su vista (más de 90° de su mirada)
    if (Math.abs(angDiff(b.yaw, yawTo(b.pos.x, b.pos.z, a.x, a.z))) < Math.PI / 2) return;
    hitWatch.push({ bot: b, from, t: 0 });
  }
  const posOf = (id) => id === 'player' ? (humanAlive() ? P().pos : null) : (() => { const o = M.botById(id); return o?.alive ? o.pos : null; })();

  // ---------- medición por bot y por paso ----------
  const TRAVEL = { advance: 1, rush: 1, perch: 1 };
  function measureBot(b, dt, moved) {
    const st = statOf(b);
    st.aliveT += dt; ev.aliveT += dt;
    ev.stateTime[b.state] = (ev.stateTime[b.state] ?? 0) + dt;
    b.__life = (b.__life ?? 0) + dt;
    const busy = b.meleeT > 0 || (b.dazeT ?? 0) > 0 || b.protoStunned || !b.grounded || b.__life < 0.6;
    const perchMove = b.state === 'perch' && b.perch && b.perch.phase !== 'hold';
    const intent = !busy && (b.__steer || perchMove);
    const travel = TRAVEL[b.state] || (b.state === 'cover' && b.coverPhase === 'go');
    const w = (b.__w ??= { t: 0, intent: 0, travel: 0, ring: [] });
    if (intent) {
      st.intentT += dt; ev.intentT += dt;
      if (moved / dt < 0.5) {
        st.blockedT += dt; ev.blockedT += dt;
        const k = cellKey(b.pos.x, b.pos.z); ev.blockedHeat[k] = (ev.blockedHeat[k] ?? 0) + dt;
      }
    }
    // vaivén: el desplazamiento cambia de sentido muchas veces por segundo
    // (rebote entre dos puntos, temblor sobre el destino, pelea con un compañero)
    const vx = (b.pos.x - (b.__px ?? b.pos.x)), vz = (b.pos.z - (b.__pz ?? b.pos.z));
    b.__px = b.pos.x; b.__pz = b.pos.z;
    const vl = Math.hypot(vx, vz);
    const jw = (b.__jw ??= { t: 0, rev: 0, lx: 0, lz: 0 });
    if (intent && vl > 0.01) {
      if ((vx * jw.lx + vz * jw.lz) / vl < -0.3) jw.rev++;
      jw.lx = vx / vl; jw.lz = vz / vl;
    }
    jw.t += dt;
    if (jw.t >= 1) {
      if (jw.rev >= 4) {
        st.jitterT = (st.jitterT ?? 0) + 1; ev.jitterT = (ev.jitterT ?? 0) + 1; const k = cellKey(b.pos.x, b.pos.z); ev.jitterHeat[k] = (ev.jitterHeat[k] ?? 0) + 1; ev.jitterBy[b.state] = (ev.jitterBy[b.state] ?? 0) + 1;
        if (ev.jitterSamples.length < 60) ev.jitterSamples.push({ st: b.state + (b.state === 'cover' ? ':' + b.coverPhase : ''), pos: [+b.pos.x.toFixed(2), +b.pos.z.toFixed(2), +b.y.toFixed(2)], wp: b.wp ? [+b.wp.x.toFixed(1), +b.wp.z.toFixed(1)] : null,
          goal: b.__sg ?? null, steer: [+(b.__sx ?? 0).toFixed(2), +(b.__sz ?? 0).toFixed(2)], tgt: b.targetId, rev: jw.rev, near: all().filter((o) => o !== b && o.alive && Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z) < 1.6).length });
      }
      jw.t = 0; jw.rev = 0;
    }
    w.t += dt; if (intent) w.intent += dt; if (intent && travel) w.travel += dt;
    if (w.t >= 0.5) {
      w.ring.push({ x: b.pos.x, z: b.pos.z, f: w.intent / w.t, tr: w.travel / w.t });
      if (w.ring.length > 5) w.ring.shift();
      w.t = 0; w.intent = 0; w.travel = 0;
      const r = w.ring;
      let stuck = false;
      if (r.length === 5) {
        let ok = true;
        for (let i = 1; i < 5; i++) if (r[i].f < 0.75 || r[i].tr < 0.5) { ok = false; break; }
        // 2 s queriendo ir a un sitio y menos de 1.2 m netos: empujando, girando en
        // círculo o rebotando entre dos puntos
        if (ok && Math.hypot(r[4].x - r[0].x, r[4].z - r[0].z) < 1.2) stuck = true;
      }
      if (stuck) {
        st.stuckT += 0.5; ev.stuckT += 0.5;
        const k = cellKey(b.pos.x, b.pos.z); ev.heat[k] = (ev.heat[k] ?? 0) + 0.5;
        if (!b.__ep) {
          b.__ep = { id: ev.episodes.length, bot: b.id, team: b.team, t0: ev.playT, x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2), y: +b.y.toFixed(2),
            state: b.state, role: b.role, coverPhase: b.coverPhase, perch: b.perch?.phase ?? null,
            wp: b.wp ? [+b.wp.x.toFixed(2), +b.wp.z.toFixed(2)] : null, recovery: b.recovery ? [+b.recovery.x.toFixed(2), +b.recovery.z.toFixed(2)] : null,
            navNext: null, trail: [], recoveries: 0, dur: 2, frames: [], human: humanAlive() ? +Math.hypot(P().pos.x - b.pos.x, P().pos.z - b.pos.z).toFixed(1) : null };
          const nv = W.navigation && b.wp ? W.navigation.next(b.pos, b.wp, { tmp: 1 }) : null;
          if (nv) b.__ep.navNext = [+nv.x.toFixed(2), +nv.z.toFixed(2), W.navigation.clear(b.pos, nv)];
          b.__ep.walkable = W.navigation ? W.navigation.walkable(b.pos) : null;
          // cuerpos pegados: ¿lo bloquea otro?
          b.__ep.near = all().filter((o) => o !== b && o.alive && Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z) < 2.2).map((o) => [o.id, o.team, +Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z).toFixed(2), o.state]);
          if (humanAlive() && Math.hypot(P().pos.x - b.pos.x, P().pos.z - b.pos.z) < 2.2) b.__ep.near.push(['player', M.playerTeam, +Math.hypot(P().pos.x - b.pos.x, P().pos.z - b.pos.z).toFixed(2), 'human']);
          ev.episodes.push(b.__ep); st.episodes++;
          for (const q of r) b.__ep.trail.push([+q.x.toFixed(2), +q.z.toFixed(2)]);
        } else { b.__ep.dur += 0.5; b.__ep.trail.push([+b.pos.x.toFixed(2), +b.pos.z.toFixed(2)]); }
        // diagnóstico: qué quería hacer el bot en cada medio segundo
        if (b.__ep.diag ??= [], b.__ep.diag.length < 10) b.__ep.diag.push({ st: b.state + (b.state === 'cover' ? ':' + b.coverPhase : ''), wp: b.wp ? [+b.wp.x.toFixed(1), +b.wp.z.toFixed(1)] : null,
          steer: [+(b.__sx ?? 0).toFixed(2), +(b.__sz ?? 0).toFixed(2)], goal: b.__sg ?? null, spd: +(b.speed ?? 0).toFixed(1), tgt: b.targetId, y: +b.y.toFixed(2), gr: b.grounded,
          rec: !!b.recovery, melee: b.meleeT > 0, daze: (b.dazeT ?? 0) > 0, perch: b.perch?.phase ?? null, yaw: +b.yaw.toFixed(2), cover: b.cover ? [+b.cover.x.toFixed(1), +b.cover.z.toFixed(1)] : null, ext: +(b.__ext ?? 0).toFixed(2), inner: +(b.__inner ?? 0).toFixed(3), pos: [+b.pos.x.toFixed(2), +b.pos.z.toFixed(2)] }); b.__ext = 0;
        const ep = b.__ep;
        // fotogramas: los primeros episodios de cada celda, 4 cuadros por episodio
        if (cfg.frames && ep.dur >= 2.5 && !ep.capturing && ev.capturedEps < cfg.frames && (capturedCells[cellKey(ep.x, ep.z)] ?? 0) < 1) {
          ep.capturing = true; ev.capturedEps++; capturedCells[cellKey(ep.x, ep.z)] = 1;
          captureQueue.push({ bot: b, ep, n: 0, next: 0 });
        }
      } else if (b.__ep) { b.__ep = null; }
    }
    // ocioso: sin intención de moverse, sin estado que lo justifique
    if (!intent && !busy) {
      const justified = b.state === 'hold' || (b.state === 'cover' && b.coverPhase !== 'go') || (b.state === 'perch' && b.perch?.phase === 'hold') || b.state === 'engage';
      if (!justified) { st.idleT += dt; ev.idleT += dt; const k = b.state + (b.targetId ? '+blanco' : '') + (b.reloadT > 0 ? '+recarga' : '') + (b.wp ? '' : '+sinDestino'); ev.idleBy[k] = (ev.idleBy[k] ?? 0) + dt; }
    }
  }
  ev.capturedEps = 0;
  const capturedCells = {};
  const captureQueue = [];

  let sampleT = 0;
  function afterStep(dt) {
    // reacción a un golpe: tiempo hasta mirar (±30°) al que le pegó
    for (let i = hitWatch.length - 1; i >= 0; i--) {
      const h = hitWatch[i]; h.t += dt;
      const a = posOf(h.from);
      if (!h.bot.alive || !a) { hitWatch.splice(i, 1); continue; }
      if (Math.abs(angDiff(h.bot.yaw, yawTo(h.bot.pos.x, h.bot.pos.z, a.x, a.z))) < 0.52) { ev.turnToHit.push(+h.t.toFixed(2)); hitWatch.splice(i, 1); }
      else if (h.t > 3) { ev.turnToHit.push(null); hitWatch.splice(i, 1); }
    }
    for (let i = allyWatch.length - 1; i >= 0; i--) {
      const h = allyWatch[i]; h.t += dt;
      if (!h.bot.alive) { allyWatch.splice(i, 1); continue; }
      if (Math.abs(angDiff(h.bot.yaw, yawTo(h.bot.pos.x, h.bot.pos.z, h.kx, h.kz))) < 0.61) { ev.allyDeathTurn.push(+h.t.toFixed(2)); allyWatch.splice(i, 1); }
      else if (h.t > 3) { ev.allyDeathTurn.push(null); allyWatch.splice(i, 1); }
    }
    sampleT += dt;
    if (sampleT >= 0.5) {
      sampleT = 0;
      ev.samples++;
      for (const team of ['red', 'blue']) {
        const sq = all().filter((b) => b.alive && b.team === team);
        for (let i = 0; i < sq.length; i++) for (let j = i + 1; j < sq.length; j++) {
          if (Math.hypot(sq[i].pos.x - sq[j].pos.x, sq[i].pos.z - sq[j].pos.z) < 2.5) ev.pairsClose++;
        }
        for (const b of sq) {
          let n = 0; for (const o of sq) if (Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z) < 5) n++;
          if (n >= 3) { ev.group3++; break; }
        }
        ev.groupSamples++;
      }
      for (const b of all()) {
        if (!b.alive) continue;
        // mirar la pared: quieto, sin enemigo a la vista, pared a <1.2 m al frente
        const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
        _o.set(b.pos.x, b.y + 1.5, b.pos.z); _d.set(fx, 0, fz);
        const wallAhead = W.raycast(_o, _d, 1.2) !== null;
        if (wallAhead && b.speed < 0.4 && b.state !== 'cover') { ev.wallT += 0.5; statOf(b).wallT += 0.5; }
        // esperar en el spawn: en su fondo, más de 6 s después de nacer
        const toward = b.team === 'red' ? 1 : -1;
        if ((b.pos.z * toward) / W.fz < -0.8 && (b.__life ?? 0) > 6) ev.spawnWaitT += 0.5;
        // espalda a una amenaza conocida: le pegaron hace <3 s y la tiene a la vista
        const lt = b.lastThreat;
        if (lt && lt.age < 3 && los(b.pos.x, b.y + 1.3, b.pos.z, lt.x, 1.3, lt.z) &&
            Math.abs(angDiff(b.yaw, yawTo(b.pos.x, b.pos.z, lt.x, lt.z))) > 1.75) ev.backT += 0.5;
      }
      if (human && humanAlive() && segment) {
        segment.samples++;
        const h = humanPos();
        let nearest = Infinity, seen = 0;
        for (const b of all()) {
          if (!b.alive || b.team !== enemyTeam) continue;
          const d = Math.hypot(b.pos.x - h.x, b.pos.z - h.z);
          nearest = Math.min(nearest, d);
          if (d < 40 && los(b.pos.x, b.y + 1.3, b.pos.z, h.x, h.y + 1.3, h.z)) seen++;
        }
        segment.nearestSum += Math.min(nearest, 80);
        if (seen) segment.exposedT += 0.5;
        // compañeros: ¿hay un aliado a <15 m mientras el humano pelea?
        if (humanCtl.fighting) {
          ev.allyNearHuman.inContact++;
          if (all().some((b) => b.alive && b.team === M.playerTeam && Math.hypot(b.pos.x - h.x, b.pos.z - h.z) < 15)) ev.allyNearHuman.withAlly++;
        }
        let allyD = 0, allyN = 0;
        for (const b of all()) if (b.alive && b.team === M.playerTeam) { allyD += Math.hypot(b.pos.x - h.x, b.pos.z - h.z); allyN++; }
        if (allyN) { segment.allyDistSum += allyD / allyN; segment.allySamples++; }
      }
    }
    if (rnd && rnd.firstShot == null && human && humanCtl.firedThisRound && playing()) rnd.firstShot = roundT();
    pumpCapture(dt);
    if (human && !lab.active) humanStep(dt);
  }

  // ---------- capturas: cenital + vista del bot ----------
  const markMat = { red: new T.MeshBasicMaterial({ color: 0xff3020 }), blue: new T.MeshBasicMaterial({ color: 0x20a0ff }),
    wp: new T.MeshBasicMaterial({ color: 0xffee00 }), nav: new T.MeshBasicMaterial({ color: 0x00ffaa }), rec: new T.MeshBasicMaterial({ color: 0xff00ff }) };
  const ringGeo = new T.RingGeometry(0.55, 0.85, 24); ringGeo.rotateX(-Math.PI / 2);
  const ballGeo = new T.SphereGeometry(0.35, 12, 8);
  const lineMat = new T.LineBasicMaterial({ color: 0xffffff });
  function pumpCapture(dt) {
    for (let i = captureQueue.length - 1; i >= 0; i--) {
      const c = captureQueue[i];
      c.next -= dt;
      if (c.next > 0) continue;
      if (!c.bot.alive || c.n >= 4) { captureQueue.splice(i, 1); continue; }
      captureFrames(c.bot, c.ep, c.n);
      c.n++; c.next = 0.8;
    }
  }
  function captureFrames(b, ep, n) {
    const grp = new T.Group();
    const ring = new T.Mesh(ringGeo, markMat[b.team]); ring.position.set(b.pos.x, b.y + 0.08, b.pos.z); grp.add(ring);
    const add = (p, m, y = 0.6) => { if (!p) return; const s = new T.Mesh(ballGeo, m); s.position.set(p.x ?? p[0], y, p.z ?? p[1]); grp.add(s); };
    add(b.wp, markMat.wp, b.y + 0.6);
    add(b.recovery, markMat.rec, b.y + 0.9);
    const nv = W.navigation && b.wp ? W.navigation.next(b.pos, b.wp, { tmp: 1 }) : null;
    add(nv, markMat.nav, b.y + 1.2);
    const pts = ep.trail.map(([x, z]) => new T.Vector3(x, b.y + 0.15, z));
    if (pts.length > 1) grp.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), lineMat));
    scene.add(grp);
    const fog = scene.fog; scene.fog = null;
    const cv = R.domElement, asp = cv.width / cv.height;
    // cenital cortada a 2.4 m sobre los pies: se ve bajo techos y galerías
    const top = new T.OrthographicCamera(-7 * asp, 7 * asp, 7, -7, 0.01, 40);
    top.position.set(b.pos.x, b.y + 2.4, b.pos.z); top.up.set(0, 0, -1); top.lookAt(b.pos.x, b.y, b.pos.z);
    R.setRenderTarget(null);
    R.render(scene, top);
    const a = cv.toDataURL('image/jpeg', 0.82);
    scene.fog = fog;
    grp.visible = false; // la vista del bot sin marcadores
    const eye = new T.PerspectiveCamera(72, asp, 0.1, 300);
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
    b.rig.setVisible?.(false);
    eye.position.set(b.pos.x + fx * 0.15, b.y + 1.55, b.pos.z + fz * 0.15);
    eye.lookAt(b.pos.x + fx * 10, b.y + 1.2, b.pos.z + fz * 10);
    R.render(scene, eye);
    const e = cv.toDataURL('image/jpeg', 0.82);
    b.rig.setVisible?.(true);
    scene.remove(grp);
    for (const o of grp.children) if (o.isLine) o.geometry.dispose();
    ev.frames.push({ ep: ep.id, n, top: a, eye: e, state: b.state, x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2) });
  }

  // ---------- jugador guionizado ----------
  const I = window.BREACH_INPUT;
  const navOwner = { human: 1 };
  const humanCtl = { fighting: false, firedThisRound: false, target: null, reactT: 0, aimErr: 0, peekT: 0, coverTries: 0 };
  const BEHAVIOURS = ['spawn', 'open', 'cover', 'push', 'flank', 'corner'];
  let segment = null, segIndex = 0;
  const toward = M.playerTeam === 'red' ? 1 : -1;
  const lab = { god: false };
  ev.lab = [];
  const keys = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
  const setKeys = (w, s, a, d) => { const v = [w, s, a, d]; for (let i = 0; i < 4; i++) v[i] ? I.keys.add(keys[i]) : I.keys.delete(keys[i]); };
  const rng = (() => { let s = 12345 + segIndex; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  function pickGoal(kind) {
    const fx = W.fx, fz = W.fz, side = segIndex % 2 ? 1 : -1;
    const snap = (p) => W.navigation?.nearest(p) ?? p;
    if (kind === 'spawn') return null;
    if (kind === 'open') {
      // el punto transitable más despejado de la franja central propia
      let best = null, bestS = -1;
      for (const n of W.navigation.nodes) {
        if (n.z * toward > -2 || n.z * toward < -fz * 0.45) continue;
        let clear = 99;
        for (const c of W.colliders) { if (c.walkSurface) continue; const dx = Math.max(c.minx - n.x, 0, n.x - c.maxx), dz = Math.max(c.minz - n.z, 0, n.z - c.maxz); clear = Math.min(clear, Math.hypot(dx, dz)); }
        const s = clear - Math.abs(n.x) * 0.05 + rng() * 0.5;
        if (s > bestS) { bestS = s; best = n; }
      }
      return best;
    }
    if (kind === 'cover') {
      const cands = W.faces.filter((f) => f.h <= 2.6 && f.h >= 0.9 && !(f.baseY > 0.2) && f.n.z * toward < -0.6 &&
        ((f.a.z + f.b.z) / 2) * toward < -2 && ((f.a.z + f.b.z) / 2) * toward > -fz * 0.5);
      const f = cands[Math.floor(rng() * cands.length)];
      if (!f) return snap({ x: 0, z: -toward * 6 });
      return { x: (f.a.x + f.b.x) / 2 + f.n.x * 0.6, z: (f.a.z + f.b.z) / 2 + f.n.z * 0.6, face: f };
    }
    if (kind === 'push') return snap({ x: W.spawns[enemyTeam][0].x, z: W.spawns[enemyTeam][0].z });
    if (kind === 'flank') return snap({ x: side * fx * 0.85, z: toward * fz * 0.55 });
    if (kind === 'corner') return snap({ x: side * fx * 0.75, z: toward * fz * 0.2 });
    return null;
  }
  function newSegment() {
    if (segment) ev.segments.push(finishSeg(segment));
    const kind = BEHAVIOURS[segIndex % BEHAVIOURS.length];
    segment = { kind, i: segIndex, t: 0, goal: pickGoal(kind), shotsAt: 0, firstShotAt: null, dmgTaken: 0, dmgDealt: 0, deaths: 0, kills: 0,
      hitsTaken: 0, hitsFromBehind: 0, samples: 0, nearestSum: 0, exposedT: 0, allyDistSum: 0, allySamples: 0, firstSeenAt: null };
    segIndex++;
    humanCtl.coverTries = 0;
  }
  function finishSeg(s) {
    const { goal, ...o } = s;
    o.goal = goal ? [+goal.x.toFixed(1), +goal.z.toFixed(1)] : null;
    o.nearestEnemy = s.samples ? +(s.nearestSum / s.samples).toFixed(1) : null;
    o.allyDist = s.allySamples ? +(s.allyDistSum / s.allySamples).toFixed(1) : null;
    delete o.nearestSum; delete o.allyDistSum; delete o.allySamples;
    return o;
  }
  ev.finish = () => {
    if (segment) { ev.segments.push(finishSeg(segment)); segment = null; }
    // munición real: segundos de bot sin nada que disparar (smg y escopeta vacías)
    ev.botDryS = +all().reduce((a, b) => a + (b.dryT || 0), 0).toFixed(1);
  };
  function visibleEnemyForHuman() {
    const h = humanPos();
    let best = null, bd = Infinity;
    for (const b of all()) {
      if (!b.alive || b.team !== enemyTeam) continue;
      const d = Math.hypot(b.pos.x - h.x, b.pos.z - h.z);
      if (d > 45 || d >= bd) continue;
      if (!los(h.x, h.y + 1.55, h.z, b.pos.x, b.y + 1.2, b.pos.z)) continue;
      best = b; bd = d;
    }
    return best;
  }
  function humanStep(dt) {
    if (!segment || segment.t > cfg.segment) newSegment();
    segment.t += dt;
    const p = P();
    if (!humanAlive()) { setKeys(0, 0, 0, 0); I._mouseFire = false; I._mouseAim = false; humanCtl.fighting = false; return; }
    // puntería de una persona: reacción ~0.3 s, giro limitado, error que se corrige
    const e = visibleEnemyForHuman();
    if (e !== humanCtl.target) { humanCtl.target = e; humanCtl.reactT = 0.28; humanCtl.aimErr = (rng() - 0.5) * 0.3; }
    humanCtl.reactT -= dt;
    humanCtl.fighting = !!e;
    if (e && segment.firstSeenAt == null) segment.firstSeenAt = segment.t;
    const kind = segment.kind;
    const ray = p.cam.aimRay?.();
    if (e && humanCtl.reactT <= 0) {
      const ox = ray?.origin?.x ?? p.pos.x, oy = ray?.origin?.y ?? p.y + 1.6, oz = ray?.origin?.z ?? p.pos.z;
      const want = yawTo(ox, oz, e.pos.x, e.pos.z) + humanCtl.aimErr;
      const wantP = Math.atan2(e.y + 1.15 - oy, Math.hypot(e.pos.x - ox, e.pos.z - oz));
      const step = 5.2 * dt; // ~300°/s
      const dy = angDiff(p.cam.yaw, want);
      p.cam.yaw += Math.max(-step, Math.min(step, dy));
      p.cam.pitch += Math.max(-step, Math.min(step, wantP - p.cam.pitch));
      humanCtl.aimErr *= Math.exp(-3 * dt);
      I._mouseAim = kind !== 'push';
      const onTarget = Math.abs(dy) < 0.05;
      I._mouseFire = onTarget && (kind !== 'cover' || humanCtl.peekT > 0);
      if (I._mouseFire) humanCtl.firedThisRound = true;
    } else { I._mouseFire = false; I._mouseAim = false; }
    // movimiento hacia el objetivo del comportamiento
    let goal = segment.goal;
    if (kind === 'push' || kind === 'flank') {
      if (goal && Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 2) segment.goal = goal = pickGoal('push');
    }
    const stay = kind === 'spawn' || !goal || (Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 0.9) ||
      (kind === 'open' && e) || (kind === 'corner' && e && Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 3);
    if (kind === 'cover' && goal && Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 1.2) {
      if (p.state !== 'cover' && humanCtl.coverTries < 8) {
        // de cara a la cobertura y evadir: el juego pega al jugador al bloque
        if (!e) p.cam.yaw = yawTo(p.pos.x, p.pos.z, goal.x - goal.face.n.x, goal.z - goal.face.n.z);
        I.evadePressed = true; humanCtl.coverTries++;
      }
      humanCtl.peekT -= dt;
      if (humanCtl.peekT < -2.2) humanCtl.peekT = 1.4;
      setKeys(0, 0, 0, 0);
      return;
    }
    if (stay) { setKeys(0, 0, 0, 0); return; }
    const nx = W.navigation.next(p.pos, goal, navOwner) ?? goal;
    const mx = nx.x - p.pos.x, mz = nx.z - p.pos.z, ml = Math.hypot(mx, mz) || 1;
    if (!e) {
      p.cam.yaw += Math.max(-6 * dt, Math.min(6 * dt, angDiff(p.cam.yaw, yawTo(p.pos.x, p.pos.z, nx.x, nx.z))));
      p.cam.pitch *= 0.9;
    }
    const y = p.cam.yaw, fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
    const fw = (mx * fx + mz * fz) / ml, rt = (mx * rx + mz * rz) / ml;
    setKeys(fw > 0.38, fw < -0.38, rt < -0.38, rt > 0.38);
  }

  // ---------- laboratorio de duelo (reacción, TTK, precisión) ----------
  ev.runLab = async (dists, trials, facings) => {
    const step = () => new Promise((r) => requestAnimationFrame(() => r()));
    lab.god = true; lab.active = true;
    ev.finish();
    I._mouseFire = false; I._mouseAim = false;
    const p = P();
    const out = [];
    const bot = all().find((b) => b.team === enemyTeam);
    const others = all().filter((b) => b !== bot);
    let r = 777;
    const rr = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
    for (const d of dists) for (const moving of [false, true]) for (const facing of facings) for (let k = 0; k < trials; k++) {
      if (!G.selfAlive) M.cb.respawnPlayer(W.spawns[M.playerTeam][0], false);
      M.respawnQueue = M.respawnQueue.filter((q) => q.id !== 'player');
      // posiciones con línea de visión y pasillo lateral libre
      let spot = null;
      for (let tries = 0; tries < 400 && !spot; tries++) {
        const n = W.navigation.nodes[Math.floor(rr() * W.navigation.nodes.length)];
        const ang = rr() * Math.PI * 2;
        const hx = n.x + Math.sin(ang) * d, hz = n.z + Math.cos(ang) * d;
        if (!W.navigation.walkable({ x: hx, z: hz })) continue;
        const by = W.navigation.heightAt(n), hy = W.navigation.heightAt({ x: hx, z: hz });
        if (Math.abs(by) > 0.05 || Math.abs(hy) > 0.05) continue;
        if (!los(n.x, 1.3, n.z, hx, 1.3, hz) || !los(n.x, 1.3, n.z, hx, 0.5, hz)) continue;
        const px = Math.cos(ang), pz = -Math.sin(ang);
        if (moving && (!W.navigation.clear({ x: hx, z: hz }, { x: hx + px * 2.2, z: hz + pz * 2.2 }) || !W.navigation.clear({ x: hx, z: hz }, { x: hx - px * 2.2, z: hz - pz * 2.2 }))) continue;
        spot = { bx: n.x, bz: n.z, hx, hz, ang };
      }
      if (!spot) continue;
      for (const o of others) { o.alive = false; o.rig.setVisible(false); }
      M.timer = 300;
      const trial = { d, moving, facing, firstShot: null, dmg: 0, ttk: null, shots: 0, hits: 0, wep: null, t: 0 };
      // el humano aparece de golpe (sale de detrás de una esquina)
      p.pos.x = spot.hx; p.pos.z = spot.hz; p.y = 0; p.vel.x = 0; p.vel.z = 0;
      const toBot = yawTo(spot.hx, spot.hz, spot.bx, spot.bz);
      p.cam.yaw = toBot; p.yaw = toBot; p.cam.pitch = 0;
      // el humano vivo y sin cola de reaparición; el bot sin la pausa de nacer
      bot.respawn({ x: spot.bx, z: spot.bz, yaw: 0 }); bot.protT = 0; bot.nadeCd = 99; bot.perchCd = 99; bot.role = 'advance'; bot.pauseT = 0;
      bot.pos.x = spot.bx; bot.pos.z = spot.bz; bot.y = 0;
      bot.yaw = facing === 'front' ? yawTo(spot.bx, spot.bz, spot.hx, spot.hz) : facing === 'side' ? yawTo(spot.bx, spot.bz, spot.hx, spot.hz) + Math.PI / 2 : yawTo(spot.bx, spot.bz, spot.hx, spot.hz) + Math.PI;
      M.perchClaims.clear(); bot.perchCd = 99;
      bot.wep = 'smg'; bot.rig.setWeapon('smg'); bot.swapCd = 0; bot.specialAmmo = 0;
      const shots0 = Object.values(ev.shots).reduce((a, s) => a + s.atHuman, 0);
      const hits0 = Object.values(ev.shots).reduce((a, s) => a + s.hitsHuman, 0);
      lab.onDamage = (dmg) => { trial.dmg += dmg; if (trial.ttk == null && trial.dmg >= 100) trial.ttk = +trial.t.toFixed(2); };
      const t0 = ev.playT;
      let flip = 0;
      while (ev.playT - t0 < 8 && trial.ttk == null) {
        await step();
        trial.t = ev.playT - t0;
        const s = Object.values(ev.shots).reduce((a, x) => a + x.atHuman, 0);
        if (trial.firstShot == null && s > shots0) trial.firstShot = +trial.t.toFixed(2);
        if (moving) { flip += 1; const ph = Math.floor(trial.t / 0.7) % 2; setKeys(0, 0, ph === 0, ph === 1); } else setKeys(0, 0, 0, 0);
        p.cam.yaw = yawTo(p.pos.x, p.pos.z, bot.pos.x, bot.pos.z);
        if (!bot.alive) break;
      }
      setKeys(0, 0, 0, 0);
      trial.shots = Object.values(ev.shots).reduce((a, s) => a + s.atHuman, 0) - shots0;
      trial.hits = Object.values(ev.shots).reduce((a, s) => a + s.hitsHuman, 0) - hits0;
      trial.wep = bot.wep;
      out.push(trial);
    }
    lab.god = false; lab.active = false;
    ev.lab = out;
    return out.length;
  };

  // ---------- reproducción de un episodio de atasco (antes/después) ----------
  // Un bot solo en el mapa, en la posición y con el destino del episodio
  // original; 4 cuadros en los mismos instantes y su trayectoria.
  ev.repro = async (list) => {
    const step = () => new Promise((r) => requestAnimationFrame(() => r()));
    lab.active = true;
    M.cb.player = () => ({ x: 0, z: 0, y: 0, alive: false });
    const out = [];
    for (const e of list) {
      for (const o of all()) { o.alive = false; o.rig.setVisible(false); }
      // el MISMO bot (su personalidad sale de su id) y en su equipo
      const b = all().find((o) => o.id === e.bot) ?? all().find((o) => o.team === e.team) ?? all()[0];
      b.respawn({ x: e.x, z: e.z, yaw: 0 }); b.protT = 0; b.y = e.y; b.exitPending = false; b.perchCd = 99; b.nadeCd = 99;
      // fixed: mismo destino todo el rato (casos de destino mal elegido)
      b.role = e.role; b.roleT = 99; b.decisionT = e.fixed ? 99 : 0; b.repathT = e.fixed ? 99 : 2;
      b.tacticalGoal = e.wp ? { x: e.wp[0], z: e.wp[1], role: e.role } : null; b.wp = b.tacticalGoal; b.commitMove = true;
      M.timer = 300;
      const ep = { id: 'r' + e.id, trail: [[e.x, e.z]] };
      const t0 = ev.playT; let k = 0, len = 0, px = b.pos.x, pz = b.pos.z;
      while (ev.playT - t0 < 4 && b.alive) {
        await step();
        len += Math.hypot(b.pos.x - px, b.pos.z - pz); px = b.pos.x; pz = b.pos.z;
        const t = ev.playT - t0;
        if (ep.trail.length < t / 0.25) ep.trail.push([+b.pos.x.toFixed(2), +b.pos.z.toFixed(2)]);
        if (k < 4 && t >= 0.6 + k * 0.8) { captureFrames(b, { id: 'r' + e.id, trail: ep.trail }, k); k++; }
      }
      out.push({ id: e.id, from: [e.x, e.z], to: [+b.pos.x.toFixed(2), +b.pos.z.toFixed(2)], net4s: +Math.hypot(b.pos.x - e.x, b.pos.z - e.z).toFixed(2), path4s: +len.toFixed(2), wpAfter: b.wp ? [+b.wp.x.toFixed(1), +b.wp.z.toFixed(1)] : null, state: b.state });
    }
    lab.active = false;
    return out;
  };

  if (human) {
    // el humano no se mueve solo al final de la ronda
    newSegment();
  }
  return true;
})
