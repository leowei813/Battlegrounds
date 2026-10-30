import { POI_TYPES } from '../../config/poiTypes.js';
import { RARITIES } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import { haversine, formatDuration } from '../../utils/math.js';
import { EXP_PHASES } from '../../systems/ExplorationSystem.js';
import { btn, timerBar, gainsHtml } from '../components.js';

/**
 * 探索分頁：進行中的隊伍、附近地點快速派遣、探索報告。
 */
export class ExplorePanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.openReport = null;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const now = Date.now();
    const phase = g.time.phase();
    const active = st.expeditions.map((ex) => {
      const poi = g.exploration.poi(ex.poiId);
      const names = ex.memberIds.map((id) => g.survivors.get(id)?.name).filter(Boolean).map(escapeHtml).join('、');
      return `<div class="card">
        <div class="row-between"><b>${poi ? POI_TYPES[poi.type].icon : '❔'} ${escapeHtml(poi?.name || '未知')}</b>${ex.auto ? '<span class="tag tag-blue">🔁 自動</span>' : ''}</div>
        <div class="muted">隊員：${names}・搜索 ${ex.durationMin} 分鐘</div>
        ${this.progressHtml(ex, now)}
        ${timerBar(ex.startAt, ex.endAt, now)}
        ${(ex.travelEvents || []).length ? `<ul class="event-list">${ex.travelEvents.slice(-3).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        <div class="btn-row">${btn('🗺️ 在地圖上追蹤', 'track', { id: ex.id }, { cls: 'btn-sm btn-primary' })}${btn(ex.auto ? '停止自動' : '🔁 自動探索', 'auto', { id: ex.id }, { cls: 'btn-sm btn-ghost', disabled: !g.research.hasUnlock('autoExplore') })}${btn('召回', 'recall', { id: ex.id }, { cls: 'btn-sm btn-ghost' })}</div>
      </div>`;
    }).join('');

    const nearby = this.nearby()
      .map(({ p, d }) => `<div class="poi-row">
        <span class="poi-pin sm" style="--c:${POI_TYPES[p.type].color}">${POI_TYPES[p.type].icon}</span>
        <div class="grow"><b>${escapeHtml(p.name)}</b><small class="muted block">${POI_TYPES[p.type].name}・${Math.round(d)}m・☠${g.zombies.areaDanger(p)}・殘量 ${Math.round((1 - (p.depletion || 0)) * 100)}%</small></div>
        ${btn('探索', 'explore', { id: p.id }, { cls: 'btn-sm btn-primary' })}
      </div>`).join('');

    const reports = (st.reports || []).map((r) => {
      const open = this.openReport === r.id;
      return `<div class="card report ${r.success ? '' : 'fail'}">
        <div class="row-between" data-action="toggleReport" data-id="${r.id}">
          <b>${r.success ? '✅' : '⚠️'} ${escapeHtml(r.poiName)}</b><small class="muted">${new Date(r.at).toLocaleTimeString().slice(0, 5)} ${open ? '▲' : '▼'}</small>
        </div>
        <div class="gains">${gainsHtml(r.resources)} ${r.items.map((it) => `<span class="rarity" style="--rc:${RARITIES[it.rarity].color}">${escapeHtml(it.name)}</span>`).join('')}${r.blueprints.length ? `<span class="tag">📜×${r.blueprints.length}</span>` : ''}</div>
        ${open ? `<ul class="event-list">${r.events.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul><small class="muted">隊員：${r.members.map(escapeHtml).join('、')}・擊殺 ${r.kills}</small>` : ''}
      </div>`;
    }).join('');

    return `<div class="panel-inner">
      <h2>🧭 探索</h2>
      <div class="phase-banner phase-${g.time.phaseId()}">${phase.icon} 目前時段：<b>${phase.name}</b>・${phase.desc}・探索速度 ×${g.time.exploreSpeedMul().toFixed(2)}・物資 ×${phase.lootMul}</div>
      <h3>進行中（${st.expeditions.length}）</h3>
      ${active || '<p class="muted">目前沒有隊伍在外。</p>'}
      <h3>附近地點</h3>
      <div class="poi-list">${nearby || '<p class="muted">請先建立避難所。</p>'}</div>
      <h3>探索報告</h3>
      ${reports || '<p class="muted">尚無報告。</p>'}
    </div>`;
  }

  /** 離主要據點最近的 30 個地點（建築可達數千棟，結果快取到據點或建築清單變動為止） */
  nearby() {
    const g = this.game;
    const sh = g.shelter.primary();
    if (!sh) return [];
    const key = `${sh.id}|${g.state.map.fetchedAt}|${g.state.map.pois.length}|${g.state.bases.length}`;
    if (key !== this.nearbyKey) {
      this.nearbyKey = key;
      this.nearbyList = g.state.map.pois
        .filter((p) => !g.shelter.baseAtPoi(p.id))
        .map((p) => ({ p, d: haversine(sh.lat, sh.lon, p.lat, p.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 30);
    }
    return this.nearbyList;
  }

  /** 行程三段（去程/搜索/返程）與移動距離 */
  progressHtml(ex, now) {
    const p = this.game.exploration.progress(ex, now);
    if (!p) return '';
    const km = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v} m`);
    const steps = Object.entries(EXP_PHASES).map(([id, ph]) => `<span class="step ${id === p.phase ? 'on' : ''}">${ph.icon} ${ph.name}</span>`).join('<span class="arrow">›</span>');
    return `<div class="exp-steps">${steps}</div>
      <div class="row-between exp-stats">
        <span>${p.totalM ? `📏 已移動 <b>${km(p.movedM)}</b> / ${km(p.totalM)}` : '📏 （更新前出發的隊伍，無路程資料）'}</span>
        <span>⏱ 剩餘 <b>${formatDuration(p.remainingMs)}</b>${p.phase !== 'returning' ? `<small class="muted">（本階段 ${formatDuration(p.phaseRemainingMs)}）</small>` : ''}</span>
      </div>
      ${p.phase !== 'searching' && this.game.state.map.zombieGroups.length ? '<div class="tag tag-red">🌙 夜間移動中：經過殭屍群附近可能遇襲</div>' : ''}`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'auto') this.ui.result(g.exploration.toggleAuto(data.id));
    if (action === 'recall' && confirm('召回隊伍將不會獲得任何收穫，確定？')) this.ui.result(g.exploration.recall(data.id));
    if (action === 'explore') {
      const poi = g.exploration.poi(data.id);
      if (poi) this.ui.panels.map.openExplore(poi);
    }
    if (action === 'track') {
      const ex = g.state.expeditions.find((e) => e.id === data.id);
      const p = ex && g.exploration.progress(ex);
      if (p) {
        this.ui.switchTab('map');
        this.ui.panels.map.service.focus(p.pos.lat, p.pos.lon, 17);
      }
    }
    if (action === 'toggleReport') {
      this.openReport = this.openReport === data.id ? null : data.id;
      this.ui.refresh(true);
    }
  }
}
