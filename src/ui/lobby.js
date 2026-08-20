import { t } from '../core/i18n.js';
import { LIFE_OPTIONS, MAPS, ROUND_OPTIONS } from '../game/lobby-rules.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export class LobbyUI {
  constructor(actions) {
    this.actions = actions;
    this.root = document.getElementById('lobby-card');
    this.red = document.getElementById('lobby-red');
    this.blue = document.getElementById('lobby-blue');
    this.settings = document.getElementById('lobby-settings');
    this.summary = document.getElementById('lobby-summary');
    this.kicker = document.getElementById('lobby-kicker');
    this.start = document.getElementById('btn-lobby-start');
    document.getElementById('btn-lobby-leave').addEventListener('click', () => actions.leave());
    this.start.addEventListener('click', () => actions.start());
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
      const action = b.dataset.action, id = b.dataset.id, team = b.dataset.team;
      if (action === 'team') actions.team(team);
      if (action === 'add') actions.addBot(team);
      if (action === 'remove') actions.removeBot(id);
      if (action === 'move') actions.moveBot(id, team);
    });
    this.root.addEventListener('change', (e) => {
      if (!e.target.dataset.setting) return;
      const key = e.target.dataset.setting;
      const value = key === 'rounds' || key === 'lives' ? Number(e.target.value) : e.target.value;
      actions.settings({ [key]: value });
    });
  }

  show(state, localId, kind = 'local') {
    this.state = state; this.localId = localId; this.kind = kind;
    document.getElementById('main-card').style.display = 'none';
    document.getElementById('char-card').style.display = 'none';
    document.getElementById('controls-card').style.display = 'none';
    this.root.classList.remove('off');
    this.render();
  }

  hide() { this.root.classList.add('off'); }

  render(state = this.state) {
    if (!state) return;
    this.state = state;
    const slots = [...(state.players || []), ...(state.bots || [])];
    const me = slots.find((p) => p.id === this.localId);
    const host = state.hostId === this.localId;
    const cap = state.teamCapacity || 4;
    this.kicker.textContent = `${t(kindKey(this.kind))} // ${host ? t('lobby.host') : t('lobby.guest')}`;
    this.summary.textContent = `${t('mode.teamDeathmatch')} · ${slots.length}/${state.maxPlayers || 8} · ${t(`map.${state.settings.map}`)}`;
    this.red.innerHTML = this.teamMarkup('red', slots, cap, me, host);
    this.blue.innerHTML = this.teamMarkup('blue', slots, cap, me, host);
    this.settings.innerHTML = this.settingsMarkup(state.settings, host, state.validation);
    this.start.disabled = !host || !state.validation?.ok || state.phase !== 'lobby';
    this.start.textContent = host ? t('lobby.start') : t('lobby.waitingHost');
  }

  teamMarkup(team, slots, cap, me, host) {
    const members = slots.filter((p) => p.team === team);
    const other = team === 'red' ? 'blue' : 'red';
    let rows = members.map((p) => {
      const badges = [p.bot ? t('lobby.bot') : t('lobby.player')];
      if (p.id === this.localId) badges.push(t('lobby.you'));
      if (p.id === this.state.hostId) badges.push(t('lobby.host'));
      const botActions = host && p.bot
        ? `<div class="lobby-slot-actions"><button class="lobby-mini" data-action="move" data-id="${esc(p.id)}" data-team="${other}">${esc(t('lobby.move'))}</button><button class="lobby-mini" data-action="remove" data-id="${esc(p.id)}">×</button></div>` : '';
      return `<div class="lobby-slot"><div><div class="lobby-name">${esc(p.name)}</div><div class="lobby-badges">${badges.map((b, i) => `<span class="lobby-badge ${i && p.id === this.state.hostId ? 'host' : ''}">${esc(b)}</span>`).join('')}</div></div>${botActions}</div>`;
    }).join('');
    for (let i = members.length; i < cap; i++) rows += `<div class="lobby-slot empty"><span>${esc(t('lobby.openSlot'))}</span></div>`;
    const full = members.length >= cap;
    return `<div class="lobby-team-head"><span>${esc(t(team === 'red' ? 'lobby.teamRed' : 'lobby.teamBlue'))}</span><span>${members.length}/${cap}</span></div><div class="lobby-slots">${rows}</div><button class="lobby-mini lobby-add" data-action="team" data-team="${team}" ${me?.team === team || full ? 'disabled' : ''}>${esc(full ? t('lobby.teamFull') : t('lobby.joinTeam'))}</button>${host ? `<button class="lobby-mini lobby-add" data-action="add" data-team="${team}" ${full ? 'disabled' : ''}>+ ${esc(t('lobby.addBot'))}</button>` : ''}`;
  }

  settingsMarkup(s, host, validation) {
    const disabled = host ? '' : 'disabled';
    const opts = (values, selected, label) => values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
    const errors = validation?.errors || [];
    const status = errors.length ? errors.map((e) => t(`lobby.error.${e}`)).join(' · ') : t('lobby.ready');
    return `<div class="lobby-settings-head"><span>${esc(t('lobby.settings'))}</span><span>${esc(host ? t('lobby.hostControls') : t('lobby.readOnly'))}</span></div><div class="lobby-settings-body">
      <div class="lobby-field"><label>${esc(t('lobby.mode'))}</label><div class="lobby-value">${esc(t('mode.teamDeathmatch'))}</div></div>
      <div class="lobby-field"><label>${esc(t('lobby.map'))}</label><select data-setting="map" ${disabled}>${opts(MAPS, s.map, (v) => t(`map.${v}`))}</select></div>
      <div class="lobby-field"><label>${esc(t('lobby.rounds'))}</label><select data-setting="rounds" ${disabled}>${opts(ROUND_OPTIONS, s.rounds, String)}</select></div>
      <div class="lobby-field"><label>${esc(t('lobby.lives'))}</label><select data-setting="lives" ${disabled}>${opts(LIFE_OPTIONS, s.lives, String)}</select></div>
      <div class="lobby-field"><label>${esc(t('lobby.afterMatch'))}</label><select data-setting="postMatch" ${disabled}><option value="lobby" ${s.postMatch === 'lobby' ? 'selected' : ''}>${esc(t('lobby.returnLobby'))}</option><option value="next-map" ${s.postMatch === 'next-map' ? 'selected' : ''}>${esc(t('lobby.nextMap'))}</option></select></div>
      <div class="lobby-validation ${errors.length ? '' : 'ok'}">${esc(status)}</div>
    </div>`;
  }
}

function kindKey(kind) { return kind === 'online' ? 'lobby.onlineSession' : 'lobby.localSession'; }
