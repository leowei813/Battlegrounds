import { escapeHtml } from '../utils/dom.js';
import { RARITIES } from '../config/equipment.js';
import { gainsHtml } from './components.js';

const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 未讀的消息數：新的探索報告＋據點遭襲紀錄 */
export function unreadCount(game) {
  const st = game.state;
  const seen = st.msgSeen || {};
  const reports = (st.reports || []).filter((r) => (r.at || 0) > (seen.reports || 0)).length;
  const defense = (st.defenseLog || []).filter((e) => (e.at || 0) > (seen.base || 0)).length;
  return reports + defense;
}

function reportsHtml(game, openId) {
  const list = (game.state.reports || []).map((r) => {
    const open = openId === r.id;
    return `<div class="card report ${r.success ? '' : 'fail'}">
      <div class="row-between" data-action="toggleReport" data-id="${r.id}">
        <b>${r.success ? '✅' : '⚠️'} ${escapeHtml(r.poiName)}</b><small class="muted">${hhmm(r.at)} ${open ? '▲' : '▼'}</small>
      </div>
      <div class="gains">${gainsHtml(r.resources)} ${r.items.map((it) => `<span class="rarity" style="--rc:${RARITIES[it.rarity].color}">${escapeHtml(it.name)}</span>`).join('')}${r.blueprints.length ? `<span class="tag">📜×${r.blueprints.length}</span>` : ''}</div>
      ${open ? `<ul class="event-list">${r.events.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul><small class="muted">隊員：${r.members.map(escapeHtml).join('、')}・擊殺 ${r.kills}</small>` : ''}
    </div>`;
  }).join('');
  return list || '<p class="muted">尚無探索報告。</p>';
}

function baseHtml(ui) {
  const logs = ui.game.state.log.slice(0, 30).map((l) => `<li class="log-${l.type}"><time>${hhmm(l.t)}</time>${escapeHtml(l.msg)}</li>`).join('');
  return `${ui.panels.shelter.defenseLogHtml()}<h4>📜 事件紀錄</h4><ul class="log-list">${logs || '<li class="muted">尚無紀錄</li>'}</ul>`;
}

/** 消息：整合探索報告與避難所紀錄；開啟的分頁視為已讀 */
export function openMessages(ui) {
  const g = ui.game;
  let tab = (g.state.reports || []).some((r) => (r.at || 0) > (g.state.msgSeen?.reports || 0)) || !(g.state.defenseLog || []).some((e) => (e.at || 0) > (g.state.msgSeen?.base || 0)) ? 'reports' : 'base';
  let openId = null;
  const markRead = () => {
    g.state.msgSeen = g.state.msgSeen || {};
    const items = tab === 'reports' ? g.state.reports || [] : g.state.defenseLog || [];
    g.state.msgSeen[tab] = Math.max(Date.now(), ...items.map((x) => x.at || 0));
  };
  const badge = (n) => (n ? ` <i class="msg-dot">${n}</i>` : '');
  const body = () => {
    const seen = g.state.msgSeen || {};
    const nr = (g.state.reports || []).filter((r) => (r.at || 0) > (seen.reports || 0)).length;
    const nb = (g.state.defenseLog || []).filter((e) => (e.at || 0) > (seen.base || 0)).length;
    markRead();
    const tabs = `<div class="seg">
      <button class="btn ${tab === 'reports' ? 'active' : ''}" data-action="msgTab" data-t="reports">🧭 探索報告${tab === 'reports' ? '' : badge(nr)}</button>
      <button class="btn ${tab === 'base' ? 'active' : ''}" data-action="msgTab" data-t="base">🏠 避難所紀錄${tab === 'base' ? '' : badge(nb)}</button></div>`;
    return `${tabs}${tab === 'reports' ? reportsHtml(g, openId) : baseHtml(ui)}`;
  };
  ui.modal.open({
    title: '💬 消息',
    wide: true,
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'msgTab') tab = data.t;
      if (action === 'toggleReport') openId = openId === data.id ? null : data.id;
      m.update(body());
    },
    onClose: () => ui.refresh(true),
  });
}
