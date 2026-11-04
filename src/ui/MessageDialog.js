import { escapeHtml } from '../utils/dom.js';
import { RARITIES } from '../config/equipment.js';
import { gainsHtml, btn } from './components.js';
import { ZONES } from '../config/zones.js';
import { shareBtn, openShareDialog } from './ShareDialog.js';

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

function reportsHtml(game, openId, since) {
  const list = (game.state.reports || []).map((r) => {
    const open = openId === r.id;
    const fresh = (r.at || 0) > since;
    return `<div class="card report ${r.success ? '' : 'fail'} ${fresh ? 'unread' : ''}">
      <div class="row-between" data-action="toggleReport" data-id="${r.id}">
        <b>${fresh ? NEW : ''}${r.success ? '✅' : '⚠️'} ${escapeHtml(r.poiName)}${zoneTag(r.zone)}</b><span class="row-gap">${shareBtn(game, 'report', r.id)}<small class="muted">${hhmm(r.at)} ${open ? '▲' : '▼'}</small></span>
      </div>
      <div class="gains">${r.emptied && !Object.values(r.resources || {}).some((v) => v > 0) && !r.items.length ? `<span class="tag empty-tag">🕸️ 已被搜空・${escapeHtml(r.emptied)}</span>` : gainsHtml(r.resources)} ${r.items.map((it) => `<span class="rarity" style="--rc:${RARITIES[it.rarity].color}">${escapeHtml(it.name)}</span>`).join('')}${r.blueprints.length ? `<span class="tag">📜×${r.blueprints.length}</span>` : ''}</div>
      ${open ? `<ul class="event-list">${r.events.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul><small class="muted">隊員：${r.members.map(escapeHtml).join('、')}・擊殺 ${r.kills}</small>` : ''}
    </div>`;
  }).join('');
  return list || '<p class="muted">尚無探索報告。</p>';
}

/** 戰鬥紀錄：每場戰鬥可展開，依序顯示誰對誰造成多少傷害、是否暴擊，並列出每人傷害統計 */
function battlesHtml(game, openId) {
  const list = (game.state.battles || []).map((b) => {
    const open = openId === b.id;
    const row = (u) => `<tr class="${u.down ? 'neg' : ''}"><td>${escapeHtml(u.name)}${u.weapon ? `<small class="muted">（${u.weapon === 'ranged' ? '遠程' : '近戰'}）</small>` : ''}</td><td>${u.dealt}</td><td>${u.hits}</td><td>${u.crits}</td><td>${u.kills}</td><td>${u.taken}</td><td>${u.healed ? `<span class="pos">+${u.healed}</span>` : ''}</td><td>${u.maxHp ? `${u.hpStart}→<b class="${u.hpEnd < u.hpStart ? 'neg' : ''}">${u.hpEnd}</b><small class="muted">/${u.maxHp}</small>` : ''}</td><td>${u.meds || ''}</td><td>${u.down ? '倒下' : ''}</td></tr>`;
    const table = (units, label) => `<h5>${label}</h5><div class="bt-wrap"><table class="battle-table"><tr><th>名稱</th><th>造成傷害</th><th>命中</th><th>暴擊</th><th>擊倒</th><th>承受傷害</th><th title="醫生急救、吸血、藥品欄用藥">回復</th><th>生命（戰前→戰後）</th><th>用藥</th><th></th></tr>${units.map(row).join('')}</table></div>`;
    return `<div class="card report ${b.victory ? '' : 'fail'}">
      <div class="row-between" data-action="toggleBattle" data-id="${b.id}">
        <b>${b.victory ? '🏆' : '💀'} ${escapeHtml(b.title)}</b><small class="muted">${hhmm(b.at)}・${b.duration} 秒 ${open ? '▲' : '▼'}</small>
      </div>
      <small class="muted">我方：${b.team.map((u) => `${escapeHtml(u.name)} ${u.dealt}`).join('、')}</small>
      ${open ? `${table(b.team, '📊 我方傷害統計')}${table(b.foes, '📊 敵方')}
        <small class="muted block">承受傷害是整場戰鬥被打的總量；醫生急救、吸血與藥品會在戰鬥中補回生命，所以戰後生命可能比「戰前 − 承受傷害」高。守城時的傷勢另計。</small>
        <h5>📜 戰鬥過程</h5><ol class="battle-log">${b.log.map((l) => `<li class="bl-${l.type}">${l.t >= 0 ? `<time>${l.t}s</time>` : ''}${escapeHtml(l.msg)}</li>`).join('')}</ol>` : ''}
    </div>`;
  }).join('');
  return list || '<p class="muted">尚無戰鬥紀錄。探索、攻打、防守時的戰鬥會記錄在這裡（保留最近 10 場）。</p>';
}

function baseHtml(ui, since) {
  return ui.panels.shelter.defenseLogHtml(since) || '<p class="muted">尚無避難所遭襲紀錄。</p>';
}

/** 事件紀錄：遊戲中發生的各種事件（最近 80 筆） */
function eventsHtml(ui, since) {
  const logs = ui.game.state.log.slice(0, 80).map((l) => `<li class="log-${l.type} ${(l.t || 0) > since && IMPORTANT.has(l.type) ? 'unread' : ''}"><time>${hhmm(l.t)}</time>${(l.t || 0) > since && IMPORTANT.has(l.type) ? NEW : ''}${escapeHtml(l.msg)}</li>`).join('');
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
      <button class="btn ${tab === 'events' ? 'active' : ''}" data-action="msgTab" data-t="events">📜 事件紀錄${badge(c.events)}</button>
      <button class="btn ${tab === 'battles' ? 'active' : ''}" data-action="msgTab" data-t="battles">⚔️ 戰鬥紀錄</button></div>
      ${tab !== 'battles' && c[tab] ? `<div class="btn-row">${btn('✓ 這頁全部標為已讀', 'markRead', {}, { cls: 'btn-xs btn-ghost' })}</div>` : ''}`;
    return `${tabs}${tab === 'reports' ? reportsHtml(g, openId, since.reports) : tab === 'battles' ? battlesHtml(g, openId) : tab === 'events' ? eventsHtml(ui, since.events) : baseHtml(ui, since.base)}`;
  };
  ui.modal.open({
    title: '💬 消息',
    wide: true,
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'msgTab' && data.t !== tab) {
        if (tab !== 'battles') markRead(tab);
        tab = data.t;
      }
      if (action === 'shareReport' || action === 'shareDefense') {
        if (tab !== 'battles') markRead(tab);
        openShareDialog(ui, action === 'shareReport' ? 'report' : 'defense', data.id);
        return;
      }
      if (action === 'markRead') markRead(tab);
      if (action === 'toggleReport' || action === 'toggleBattle') openId = openId === data.id ? null : data.id;
      m.update(body());
    },
    onClose: () => {
      if (tab !== 'battles') markRead(tab);
      ui.refresh(true);
    },
  });
}
