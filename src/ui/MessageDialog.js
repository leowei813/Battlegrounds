import { escapeHtml } from '../utils/dom.js';
import { RARITIES } from '../config/equipment.js';
import { gainsHtml, btn } from './components.js';
import { ZONES } from '../config/zones.js';
import { shareBtn, openShareDialog } from './ShareDialog.js';
import { battlesSectionHtml, battleHtml } from './BattleLog.js';

const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 重要的避難所事件（計入未讀）：不含一般資訊訊息 */
const IMPORTANT = new Set(['danger', 'success', 'loot', 'legendary']);

/** 事件紀錄上次已讀的時間（舊存檔沿用避難所紀錄的已讀時間） */
const eventsSeen = (seen) => seen.events ?? seen.base ?? 0;

/** 各分頁的未讀數：探索報告、避難所紀錄（遭襲紀錄）、事件紀錄（重要事件） */
export function unreadCounts(game) {
  const st = game.state;
  const seen = st.msgSeen || {};
  const reports = (st.reports || []).filter((r) => (r.at || 0) > (seen.reports || 0)).length;
  const base = (st.defenseLog || []).filter((e) => (e.at || 0) > (seen.base || 0)).length;
  const events = (st.log || []).filter((l) => IMPORTANT.has(l.type) && (l.t || 0) > eventsSeen(seen)).length;
  return { reports, base, events };
}

export function unreadCount(game) {
  const c = unreadCounts(game);
  return c.reports + c.base + c.events;
}

const NEW = '<span class="tag tag-blue new-tag">未讀</span>';

/** 探索地點的危險等級標籤（依區域顏色） */
function zoneTag(id) {
  const z = ZONES.find((x) => x.id === id);
  if (!z) return '';
  const color = z.id === 'abyss' ? '#9e9e9e' : z.color;
  return ` <span class="zone-tag" style="--zc:${color}">${z.danger >= 2 ? '☠️' : z.danger >= 1 ? '⚠️' : '🟢'} ${z.name}</span>`;
}

function reportsHtml(game, openId, since, openBattle) {
  const list = (game.state.reports || []).map((r) => {
    const open = openId === r.id;
    const fresh = (r.at || 0) > since;
    return `<div class="card report ${r.success ? '' : 'fail'} ${fresh ? 'unread' : ''}">
      <div class="row-between" data-action="toggleReport" data-id="${r.id}">
        <b>${fresh ? NEW : ''}${r.success ? '✅' : '⚠️'} ${escapeHtml(r.poiName)}${zoneTag(r.zone)}</b><span class="row-gap">${shareBtn(game, 'report', r.id)}<small class="muted">${hhmm(r.at)} ${open ? '▲' : '▼'}</small></span>
      </div>
      <div class="gains">${r.emptied && !Object.values(r.resources || {}).some((v) => v > 0) && !r.items.length ? `<span class="tag empty-tag">🕸️ 已被搜空・${escapeHtml(r.emptied)}</span>` : gainsHtml(r.resources)} ${r.items.map((it) => `<span class="rarity" style="--rc:${RARITIES[it.rarity].color}">${escapeHtml(it.name)}</span>`).join('')}${r.carried && (r.items.length || Object.keys(r.resources || {}).length) ? '<span class="tag">🎒 背在身上，回到避難所才入庫</span>' : ''}${r.blueprints.length ? `<span class="tag">📜×${r.blueprints.length}</span>` : ''}</div>
      ${open ? `<ul class="event-list">${r.events.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul><small class="muted">隊員：${r.members.map(escapeHtml).join('、')}・擊殺 ${r.kills}</small>${battlesSectionHtml(game, r.battleIds, openBattle)}` : (r.battleIds?.length ? `<small class="muted block">⚔️ ${r.battleIds.length} 場戰鬥・點開查看</small>` : '')}
    </div>`;
  }).join('');
  return list || '<p class="muted">尚無探索報告。</p>';
}

function baseHtml(ui, since, openBattle) {
  return ui.panels.shelter.defenseLogHtml(since, openBattle) || '<p class="muted">尚無避難所遭襲紀錄。</p>';
}

/** 事件紀錄：遊戲中發生的各種事件（最近 80 筆） */
function eventsHtml(ui, since, openBattle) {
  const logs = ui.game.state.log.slice(0, 80).map((l) => {
    const b = l.battleId ? ui.game.combat.battle(l.battleId) : null;
    const open = b && openBattle === b.id;
    return `<li class="log-${l.type} ${(l.t || 0) > since && IMPORTANT.has(l.type) ? 'unread' : ''}"><time>${hhmm(l.t)}</time>${(l.t || 0) > since && IMPORTANT.has(l.type) ? NEW : ''}${escapeHtml(l.msg)}${b ? ` ${btn(open ? '收起戰鬥' : '⚔️ 戰鬥明細', 'toggleBattle', { id: b.id }, { cls: 'btn-xs btn-ghost' })}${open ? battleHtml(b, true) : ''}` : ''}</li>`;
  }).join('');
  return `<ul class="log-list">${logs || '<li class="muted">尚無紀錄</li>'}</ul>`;
}

/**
 * 消息：整合探索報告與避難所紀錄。
 * 每個分頁顯示未讀數；未讀的項目標示「未讀」，離開分頁或關閉視窗後才算已讀。
 */
export function openMessages(ui) {
  const g = ui.game;
  const first = unreadCounts(g);
  let tab = first.reports ? 'reports' : first.base ? 'base' : first.events ? 'events' : 'reports';
  let openId = null;
  let openBattle = null;
  g.state.msgSeen = g.state.msgSeen || {};
  // 開啟分頁時記下上次已讀的時間，用來標示這次看到的未讀項目
  const since = { reports: g.state.msgSeen.reports || 0, base: g.state.msgSeen.base || 0, events: eventsSeen(g.state.msgSeen) };
  const markRead = (t) => { g.state.msgSeen[t] = Date.now(); };
  const badge = (n) => (n ? ` <i class="msg-dot">${n}</i>` : '');
  const body = () => {
    const c = unreadCounts(g);
    const tabs = `<div class="seg">
      <button class="btn ${tab === 'reports' ? 'active' : ''}" data-action="msgTab" data-t="reports">🧭 探索報告${badge(c.reports)}</button>
      <button class="btn ${tab === 'base' ? 'active' : ''}" data-action="msgTab" data-t="base">🏠 避難所紀錄${badge(c.base)}</button>
      <button class="btn ${tab === 'events' ? 'active' : ''}" data-action="msgTab" data-t="events">📜 事件紀錄${badge(c.events)}</button></div>
      ${c[tab] ? `<div class="btn-row">${btn('✓ 這頁全部標為已讀', 'markRead', {}, { cls: 'btn-xs btn-ghost' })}</div>` : ''}`;
    return `${tabs}${tab === 'reports' ? reportsHtml(g, openId, since.reports, openBattle) : tab === 'events' ? eventsHtml(ui, since.events, openBattle) : baseHtml(ui, since.base, openBattle)}`;
  };
  ui.modal.open({
    title: '💬 消息',
    wide: true,
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'msgTab' && data.t !== tab) {
        markRead(tab);
        tab = data.t;
        openBattle = null;
      }
      if (action === 'shareReport' || action === 'shareDefense') {
        markRead(tab);
        openShareDialog(ui, action === 'shareReport' ? 'report' : 'defense', data.id);
        return;
      }
      if (action === 'markRead') markRead(tab);
      if (action === 'toggleReport') { openId = openId === data.id ? null : data.id; openBattle = null; }
      if (action === 'toggleBattle') openBattle = openBattle === data.id ? null : data.id;
      m.update(body());
    },
    onClose: () => {
      markRead(tab);
      ui.refresh(true);
    },
  });
}
