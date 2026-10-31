import { POI_TYPES } from '../../config/poiTypes.js';
import { MAX_EXPEDITIONS } from '../../config/constants.js';
import { VEHICLES } from '../../config/vehicles.js';
import { RARITIES } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import { formatDuration } from '../../utils/math.js';
import { EXP_PHASES } from '../../systems/ExplorationSystem.js';
import { btn, timerBar, gainsHtml } from '../components.js';

/**
 * 探索分頁：進行中的隊伍與探索報告（派遣探索請在地圖上點選建築）。
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
        <div class="row-between"><b>${poi ? poi.icon || POI_TYPES[poi.type].icon : '❔'} ${escapeHtml(poi?.name || '未知')}</b>${ex.kind === 'raid' ? '<span class="tag tag-red">⚔️ 攻打</span>' : ex.kind === 'intercept' ? '<span class="tag tag-red">⚔️ 攔截</span>' : ex.kind === 'hunt' ? '<span class="tag tag-red">🧟 獵殺</span>' : ex.kind === 'trade' ? `<span class="tag tag-green">🤝 交易・已收入 💰${ex.trade?.earned || 0}</span>` : ''}${ex.defeated ? '<span class="tag tag-red">🏳️ 撤回中</span>' : ex.recalled ? '<span class="tag">↩️ 召回中</span>' : ''}${(ex.vehicleIds || []).length ? `<span class="tag">${ex.vehicleIds.map((id) => { const v = g.vehicles.get(id); return v ? VEHICLES[v.type].icon : ''; }).join('')}</span>` : ''}${ex.auto ? '<span class="tag tag-blue">🔁 自動</span>' : ''}</div>
        <div class="muted">隊員：${names}・搜索 ${ex.durationMin} 分鐘</div>
        ${this.progressHtml(ex, now)}
        ${timerBar(ex.startAt, ex.endAt, now)}
        ${(ex.travelEvents || []).length ? `<ul class="event-list">${ex.travelEvents.slice(-3).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        <div class="btn-row">${btn('🗺️ 在地圖上追蹤', 'track', { id: ex.id }, { cls: 'btn-sm btn-primary' })}${btn(ex.auto ? '停止自動' : '🔁 自動探索', 'auto', { id: ex.id }, { cls: 'btn-sm btn-ghost', disabled: !g.research.hasUnlock('autoExplore') })}${g.exploration.canRecall(ex, now) ? btn('召回', 'recall', { id: ex.id }, { cls: 'btn-sm btn-ghost' }) : ''}</div>
      </div>`;
    }).join('');

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
      <h3>進行中（${st.expeditions.length}/${MAX_EXPEDITIONS}）</h3>
      ${active || '<p class="muted">目前沒有隊伍在外。</p>'}
      <p class="muted">要派遣探索，請到「地圖」點選建築。</p>
      <h3>探索報告</h3>
      ${reports || '<p class="muted">尚無報告。</p>'}
    </div>`;
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
    if (action === 'recall' && confirm('召回後隊伍會從目前位置走回避難所（需要移動時間），這趟不會有任何收穫，確定？')) this.ui.result(g.exploration.recall(data.id));
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
