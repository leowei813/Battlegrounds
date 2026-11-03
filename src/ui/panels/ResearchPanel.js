import {
  RESEARCH, RESEARCH_BRANCHES, labLevelFor, effectText,
} from '../../config/research.js';
import {
  btn, needHtml, timerBar, affordable,
} from '../components.js';
import { formatDuration } from '../../utils/math.js';

const TIER_NAMES = { 1: '基礎', 2: '進階', 3: '高階', 4: '頂尖', 5: '傳說' };
const FILTERS = [['all', '全部'], ['ok', '可研究'], ['lack', '材料不足'], ['lock', '未解鎖'], ['max', '已滿級']];

/**
 * 研究頁：網頁版左側為研究中心資訊與 10 個科技分支，中間依階段（T1→T4）排列科技卡片，右側為研究中與下一個可研究；
 * 手機版分支改為上方可左右滑動的標籤，研究中固定在上方。
 */
export class ResearchPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.branch = 'weapons';
    this.filter = 'all';
  }

  /** 科技狀態：max 已滿級／active 研究中／lock 未解鎖／lack 材料不足／ok 可研究 */
  stateOf(id) {
    const g = this.game;
    const r = RESEARCH[id];
    const lv = g.research.level(id);
    if (lv >= r.maxLevel) return { state: 'max' };
    if (g.state.research.active?.id === id) return { state: 'active' };
    const next = lv + 1;
    const lab = labLevelFor(id, next);
    if (g.research.labLevel() < lab) return { state: 'lock', reason: `需要研究中心 Lv${lab}（目前 Lv${g.research.labLevel()}）` };
    const missing = r.requires.find(([rid, need]) => g.research.level(rid) < need);
    if (missing) return { state: 'lock', reason: `前置：${RESEARCH[missing[0]].name} Lv${missing[1]}（目前 Lv${g.research.level(missing[0])}）` };
    if (!affordable(g.state, g.research.cost(id))) return { state: 'lack' };
    return { state: 'ok' };
  }

  card(id, r) {
    const g = this.game;
    const st = g.state;
    const active = st.research.active;
    const lv = g.research.level(id);
    const { state, reason } = this.stateOf(id);
    const req = r.requires.map(([rid, need]) => `${RESEARCH[rid].name} Lv${need}${g.research.level(rid) >= need ? ' ✓' : ''}`).join('、');
    const pct = Math.round((lv / r.maxLevel) * 100);
    let action = '';
    if (state === 'max') action = '<span class="tag tag-amber">MAX</span>';
    else if (state === 'active') {
      const p = Math.min(100, Math.round(((Date.now() - active.startAt) / Math.max(1, active.endAt - active.startAt)) * 100));
      action = `<span class="tag tag-amber">⏳ 研究中 ${p}%</span>`;
    } else if (state === 'lock') action = '<span class="tag">🔒 未解鎖</span>';
    else if (state === 'lack') action = btn('材料不足', 'start', { id }, { cls: 'btn-sm btn-lack', disabled: true });
    else {
      const busy = !!active;
      action = btn(`${lv ? `升到 Lv${lv + 1}` : '研究'}`, 'start', { id }, { cls: `btn-sm ${busy ? '' : 'btn-primary'}`, disabled: busy, title: busy ? '已有研究進行中' : '' });
    }
    return `<div class="fac-card2 rs-card ${state === 'lock' ? 'unbuilt' : ''} ${state === 'active' ? 'rs-active' : ''}">
      <div class="fac2-head"><b>${r.name}</b><span class="rs-lv ${lv ? 'on' : ''}">Lv ${lv}/${r.maxLevel}</span></div>
      <span class="rs-bar"><i style="width:${pct}%"></i></span>
      <small class="muted">${r.desc}${r.unlock.length ? '（第 1 級解鎖）' : ''}</small>
      <div class="fac2-effect">${lv ? effectText(id, lv) : '尚未研究'}${state === 'max' ? '' : ` <span class="pos">→ ${effectText(id, lv + 1)}</span>`}</div>
      ${state === 'lock' ? `<small class="neg">🔒 ${reason}</small>` : req ? `<small class="muted">前置：${req}</small>` : ''}
      ${state === 'max' ? '' : `<div class="fac2-cost">
        ${state === 'active' ? timerBar(active.startAt, active.endAt) : `<div class="needs">${needHtml(st, g.research.cost(id))}</div>`}
        <div class="row-between"><small class="muted">${state === 'active' || state === 'lock' ? '' : `⏱ ${formatDuration(g.research.researchTime(id) * 1000)}・研究中心 Lv${labLevelFor(id, lv + 1)}`}</small>${action}</div>
      </div>`}
      ${state === 'max' ? `<div class="row-between"><small class="muted"></small>${action}</div>` : ''}
    </div>`;
  }

  /** 右側：研究中、研究規則、下一個可研究 */
  side() {
    const g = this.game;
    const active = g.state.research.active;
    let cur = '';
    if (active) {
      const r = RESEARCH[active.id];
      const done = Math.min(1, (Date.now() - active.startAt) / Math.max(1, active.endAt - active.startAt));
      cur = `<section class="sh-card rs-now">
        <h3>⏳ 研究中</h3>
        <b>${r.name} Lv${active.level - 1} → Lv${active.level}</b>
        <small>${active.level > 1 ? effectText(active.id, active.level - 1) : '尚未研究'} <span class="pos">→ ${effectText(active.id, active.level)}</span></small>
        ${timerBar(active.startAt, active.endAt)}
        ${btn(`取消（退還 ${Math.round(90 * (1 - done))}%）`, 'cancelResearch', {}, { cls: 'btn-sm' })}
      </section>`;
    } else {
      cur = '<section class="sh-card rs-now"><h3>💤 沒有進行中的研究</h3><small class="muted">選一項科技開始研究吧。</small></section>';
    }
    const nexts = Object.entries(RESEARCH)
      .map(([id, r]) => ({ id, r, s: this.stateOf(id).state }))
      .filter((x) => x.s === 'ok' || x.s === 'lack')
      .sort((a, b) => (a.s === b.s ? a.r.tier - b.r.tier : a.s === 'ok' ? -1 : 1))
      .slice(0, 6);
    return `<aside class="sh-fac-side">
      ${cur}
      <section class="sh-card sh-rates"><h3>研究規則</h3>
        <ul class="rs-rules"><li>同時只能進行 1 項研究</li><li>科技第 L 級需要研究中心 Lv L</li><li>取消研究依完成度退還材料</li></ul></section>
      <section class="sh-card sh-rates"><h3>下一個可研究</h3>${nexts.map((x) => `
        <button class="rs-next" data-action="branch" data-b="${x.r.branch}"><span>${RESEARCH_BRANCHES[x.r.branch].icon} ${x.r.name} Lv${g.research.level(x.id) + 1}</span><small class="${x.s === 'ok' ? 'pos' : 'neg'}">${x.s === 'ok' ? '可研究' : '材料不足'}</small></button>`).join('') || '<small class="muted">目前沒有可研究的科技。</small>'}</section>
    </aside>`;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const lab = g.research.labLevel();
    const total = Object.values(RESEARCH).reduce((s, r) => s + r.maxLevel, 0);
    const done = Object.values(st.research.levels).reduce((s, v) => s + v, 0);
    if (!RESEARCH_BRANCHES[this.branch]) this.branch = 'weapons';
    const items = Object.entries(RESEARCH).filter(([, r]) => r.branch === this.branch);
    const branchNav = Object.entries(RESEARCH_BRANCHES).map(([bid, b]) => {
      const n = Object.values(RESEARCH).filter((r) => r.branch === bid);
      const lv = Object.entries(RESEARCH).filter(([, r]) => r.branch === bid).reduce((s, [id]) => s + g.research.level(id), 0);
      const max = n.reduce((s, r) => s + r.maxLevel, 0);
      return `<button class="sh-nav-item rs-branch ${this.branch === bid ? 'active' : ''}" data-action="branch" data-b="${bid}">
        <span>${b.icon} ${b.name}</span><small>${lv}/${max}</small><i class="rs-bar desk-only"><i style="width:${Math.round((lv / Math.max(1, max)) * 100)}%"></i></i></button>`;
    }).join('');
    const nav = `<nav class="sh-nav" aria-label="科技分支">
      <div class="sh-base"><b>🔬 研究中心 Lv ${lab}</b><small class="muted">${lab ? `研究速度 +${lab * 10}%・可研究到各項 Lv${lab}` : '尚未建造'}</small><small class="muted">總等級 ${done}/${total}</small></div>
      <small class="muted nav-label2 desk-only">科技分支（已研究等級）</small>
      <div class="sh-nav-list">${branchNav}</div>
    </nav>`;
    const b = RESEARCH_BRANCHES[this.branch];
    const lvSum = items.reduce((s, [id]) => s + g.research.level(id), 0);
    const maxSum = items.reduce((s, [, r]) => s + r.maxLevel, 0);
    const tiers = [...new Set(items.map(([, r]) => r.tier))].sort((a, c) => a - c);
    const groups = tiers.map((t) => {
      const cards = items.filter(([, r]) => r.tier === t)
        .filter(([id]) => {
          if (this.filter === 'all') return true;
          const s = this.stateOf(id).state;
          return this.filter === 'ok' ? s === 'ok' || s === 'active' : s === this.filter;
        })
        .map(([id, r]) => this.card(id, r)).join('');
      return cards ? `<h4 class="rs-tier">T${t}・${TIER_NAMES[t] || ''}</h4><div class="fac-grid">${cards}</div>` : '';
    }).join('');
    const main = `<div class="sh-fac"><div class="sh-fac-main">
      ${lab < 1 ? `<div class="card warn">需要先在避難所建造「研究中心」。${btn('前往避難所', 'gotoShelter', {}, { cls: 'btn-sm' })}</div>` : ''}
      <h3 class="sh-title">${b.icon} ${b.name} <small>${items.length} 項・已研究 ${lvSum}/${maxSum}</small></h3>
      <div class="chips fac-filter">${FILTERS.map(([k, l]) => `<button class="chip ${this.filter === k ? 'active' : ''}" data-action="rsFilter" data-f="${k}">${l}</button>`).join('')}</div>
      <small class="muted desk-only">依階段排列，前置科技達到等級後解鎖下一階段。</small>
      ${groups || '<p class="muted">沒有符合的科技。</p>'}
    </div>${this.side()}</div>`;
    return `<div class="sh-layout rs-layout">${nav}<div class="sh-main">${main}</div></div>`;
  }

  onAction(action, data) {
    if (action === 'start') this.ui.result(this.game.research.start(data.id));
    if (action === 'cancelResearch' && confirm('取消研究？依完成度退還材料，完成度越高退得越少。')) this.ui.result(this.game.research.cancel());
    if (action === 'branch') {
      this.branch = data.b;
      this.ui.panelEl.scrollTop = 0;
    }
    if (action === 'rsFilter') this.filter = data.f;
    if (action === 'gotoShelter') this.ui.switchTab('shelter');
  }
}
