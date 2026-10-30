import { POI_TYPES } from '../../config/poiTypes.js';
import { RARITIES } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import { haversine } from '../../utils/math.js';
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
        <div class="muted">隊員：${names}・預定 ${ex.durationMin} 分鐘</div>
        ${timerBar(ex.startAt, ex.endAt, now)}
        <div class="btn-row">${btn(ex.auto ? '停止自動' : '🔁 自動探索', 'auto', { id: ex.id }, { cls: 'btn-sm btn-ghost', disabled: !g.research.hasUnlock('autoExplore') })}${btn('召回', 'recall', { id: ex.id }, { cls: 'btn-sm btn-ghost' })}</div>
      </div>`;
    }).join('');

    const sh = g.shelter.primary();
    const nearby = !sh ? [] : st.map.pois
      .filter((p) => !g.shelter.baseAtPoi(p.id))
      .map((p) => ({ p, d: haversine(sh.lat, sh.lon, p.lat, p.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 30)
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

  onAction(action, data) {
    const g = this.game;
    if (action === 'auto') this.ui.result(g.exploration.toggleAuto(data.id));
    if (action === 'recall' && confirm('召回隊伍將不會獲得任何收穫，確定？')) this.ui.result(g.exploration.recall(data.id));
    if (action === 'explore') {
      const poi = g.exploration.poi(data.id);
      if (poi) this.ui.panels.map.openExplore(poi);
    }
    if (action === 'toggleReport') {
      this.openReport = this.openReport === data.id ? null : data.id;
      this.ui.refresh(true);
    }
  }
}
