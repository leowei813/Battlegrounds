import { POI_TYPES } from '../../config/poiTypes.js';
import { MAX_EXPEDITIONS } from '../../config/constants.js';
import { VEHICLES } from '../../config/vehicles.js';
import { escapeHtml } from '../../utils/dom.js';
import { formatDuration } from '../../utils/math.js';
import {
  btn, timerBar, metaOf,
} from '../components.js';

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
        ${this.checkpointHtml(ex)}
        ${(ex.travelEvents || []).length ? `<ul class="event-list">${ex.travelEvents.slice(-3).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        <div class="btn-row">${btn('🗺️ 在地圖上追蹤', 'track', { id: ex.id }, { cls: 'btn-sm btn-primary' })}${btn(ex.auto ? '停止自動' : '🔁 自動探索', 'auto', { id: ex.id }, { cls: 'btn-sm btn-ghost', disabled: !g.research.hasUnlock('autoExplore') })}${g.exploration.canRecall(ex, now) ? btn('召回', 'recall', { id: ex.id }, { cls: 'btn-sm btn-ghost' }) : ''}</div>
      </div>`;
    }).join('');

    return `<div class="panel-inner">
      <h2>🧭 探索</h2>
      <div class="phase-banner phase-${g.time.phaseId()}">${phase.icon} 目前時段：<b>${phase.name}</b>・${phase.desc}・探索速度 ×${g.time.exploreSpeedMul().toFixed(2)}・物資 ×${phase.lootMul}</div>
      <h3>進行中（${st.expeditions.length}/${MAX_EXPEDITIONS}）</h3>
      ${active || '<p class="muted">目前沒有隊伍在外。</p>'}
      <p class="muted">要派遣探索，請到「地圖」點選建築。</p>
      <p class="muted">💬 探索報告移到地圖右上方的「消息」按鈕。</p>
    </div>`;
  }

  /** 行程三段（去程/搜索/返程）與移動距離 */
  progressHtml(ex, now) {
    const p = this.game.exploration.progress(ex, now);
    if (!p) return '';
    const km = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v} m`);
    // 只顯示整體進度（不顯示前往／搜索／返程階段）
    return `<div class="row-between exp-stats">
        <span>${p.totalM ? `📏 已移動 <b>${km(p.movedM)}</b> / ${km(p.totalM)}` : ''}</span>
        <span>⏱ 剩餘 <b>${formatDuration(p.remainingMs)}</b></span>
      </div>
      ${p.phase !== 'searching' && this.game.state.map.zombieGroups.length ? '<div class="tag tag-red">🌙 夜間移動中：經過殭屍群附近可能遇襲</div>' : ''}`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'auto') this.ui.result(g.exploration.toggleAuto(data.id));
    if (action === 'recall' && confirm('召回後隊伍會從目前位置走回避難所（需要移動時間），只會帶回已經到過的檢核點找到的物資，確定？')) this.ui.result(g.exploration.recall(data.id));
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

  /** 搜索檢核點：進度（完成時不顯示）與目前找到的東西 */
  checkpointHtml(ex) {
    if (ex.kind !== 'explore' || ex.defeated) return '';
    const g = this.game;
    const cp = ex.cp;
    const poi = g.exploration.poi(ex.poiId);
    const total = cp?.total || (poi ? g.exploration.checkpointCount(poi) : 1);
    const done = cp?.done || 0;
    const phase = g.exploration.progress(ex)?.phase;
    // 進度：搜索中顯示已完成的檢核點比例；完成後不顯示
    let prog = '';
    if (phase === 'outbound' && !ex.recalled) prog = `<div class="muted">🔍 抵達後開始搜索（${total > 1 ? `${total} 個檢核點` : '搜索完成時結算'}）</div>`;
    else if (phase === 'searching' && done < total && !cp?.stopped) prog = `<div class="pos">🔍 搜索進度 ${Math.round((done / total) * 100)}%${total > 1 ? `（檢核點 ${done}/${total}）` : ''}</div>`;
    const found = Object.entries(cp?.gained || {}).map(([k, v]) => [k, Math.floor(v + 1e-9)]).filter(([, v]) => v > 0)
      .map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name} ${v}`);
    (cp?.items || []).forEach((it) => found.push(`🎁「${escapeHtml(it.name)}」`));
    if (cp?.blueprints?.length) found.push(`📜×${cp.blueprints.length}`);
    const got = found.length
      ? `<small class="block">🎒 已取得：${found.join('、')}</small>`
      : phase === 'searching' || done ? '<small class="muted block">🎒 已取得：還沒找到物資</small>' : '';
    return `${prog}${got}`;
  }
}
