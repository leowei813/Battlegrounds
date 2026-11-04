import {
  RESEARCH, RESEARCH_BRANCHES, labLevelFor, effectText,
} from '../../config/research.js';
import {
  btn, needHtml, timerBar, affordable, metaOf,
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
    /** 這次瀏覽看過的剛完成科技（離開分支或研究頁時清除 NEW） */
    this.seen = new Set();
    this.seenBranch = null;
  }

  fresh() {
    return this.game.state.research.fresh || {};
  }

  /** 離開分支或研究頁：看過的 NEW 標示消失 */
  clearSeen() {
    const f = this.game.state.research.fresh;
    if (f && this.seen.size) {
      this.seen.forEach((id) => { delete f[id]; });
      this.game.requestSave();
    }
    this.seen.clear();
  }

  onLeave() {
    this.clearSeen();
    this.seenBranch = null;
  }

  /**
   * 科技狀態（以研究佇列全部完成後的等級判斷）：
   * max 已滿級／planned 已排到最高級／lock 未解鎖／lack 材料不足／ok 可研究或加入佇列
   */
  stateOf(id) {
    const g = this.game;
    const r = RESEARCH[id];
    const planned = g.research.plannedLevels();
    const lv = planned[id] || 0;
    if (g.research.level(id) >= r.maxLevel) return { state: 'max' };
    if (lv >= r.maxLevel) return { state: 'planned' };
    const next = lv + 1;
    const lab = labLevelFor(id, next);
    if (g.research.labLevel() < lab) return { state: 'lock', reason: `Lv${next} 需要研究中心 Lv${lab}（目前 Lv${g.research.labLevel()}）` };
    const missing = r.requires.find(([rid, need]) => (planned[rid] || 0) < need);
    if (missing) return { state: 'lock', reason: `前置：${RESEARCH[missing[0]].name} Lv${missing[1]}（目前 Lv${g.research.level(missing[0])}）` };
    if (!affordable(g.state, g.research.cost(id, next))) return { state: 'lack' };
    return { state: 'ok' };
  }

  card(id, r) {
    const g = this.game;
    const st = g.state;
    const active = st.research.active;
    const lv = g.research.level(id);
    const planned = g.research.plannedLevel(id);
    const next = planned + 1;
    const { state, reason } = this.stateOf(id);
    const req = r.requires.map(([rid, need]) => `${RESEARCH[rid].name} Lv${need}${g.research.level(rid) >= need ? ' ✓' : ''}`).join('、');
    const running = active?.id === id;
    const queuedHere = g.research.queue.map((q, i) => ({ q, n: i + 2 })).filter((x) => x.q.id === id);
    const full = g.research.used() >= g.research.slots();
    let action = '';
    if (state === 'max') action = '<span class="tag tag-amber">MAX</span>';
    else if (state === 'planned') action = '<span class="tag tag-amber">已排到 MAX</span>';
    else if (state === 'lock') action = '<span class="tag">🔒 未解鎖</span>';
    else if (state === 'lack') action = btn('材料不足', 'start', { id }, { cls: 'btn-sm btn-lack', disabled: true });
    else if (active && full) action = btn(`佇列已滿（${g.research.used()}/${g.research.slots()}）`, 'start', { id }, { cls: 'btn-sm', disabled: true });
    else if (active) action = btn(`＋ ${planned > lv ? `排入 Lv${next}` : '加入佇列'}（第 ${g.research.used() + 1} 項）`, 'start', { id }, { cls: 'btn-sm btn-primary' });
    else action = btn(`${lv ? `升到 Lv${lv + 1}` : '研究'}`, 'start', { id }, { cls: 'btn-sm btn-primary' });
    const isNew = !!this.fresh()[id];
    if (isNew) this.seen.add(id);
    const pips = `<span class="rs-pips" title="Lv ${lv}/${r.maxLevel}">${'●'.repeat(lv)}<i>${'●'.repeat(Math.max(0, r.maxLevel - lv))}</i></span>`;
    const done = state === 'max' || state === 'planned';
    const effect = done
      ? `<div class="fac2-effect">目前：${lv ? effectText(id, lv) : '尚未研究'}</div>`
      : `<div class="fac2-effect">${lv ? `目前：${effectText(id, lv)}` : '目前：尚未研究'}</div>
        <div class="fac2-effect"><span class="muted">${planned ? `Lv${next}` : '第 1 級'}：</span><span class="pos">${planned ? `${effectText(id, planned)} → ` : ''}${effectText(id, next)}</span></div>`;
    const progress = running ? `<span class="tag tag-amber">⏳ 研究中 Lv${active.level}・${Math.min(100, Math.round(((Date.now() - active.startAt) / Math.max(1, active.endAt - active.startAt)) * 100))}%</span>` : '';
    const inQueue = queuedHere.length ? `<small class="muted block">📋 已在佇列：${queuedHere.map((x) => `Lv${x.q.level}（第 ${x.n} 項）`).join('、')}</small>` : '';
    return `<div class="fac-card2 rs-card ${state === 'lock' ? 'unbuilt' : ''} ${running ? 'rs-active' : ''} ${isNew ? 'rs-new' : ''}">
      ${isNew ? '<span class="rs-new-tag">NEW 剛完成</span>' : ''}
      <div class="fac2-head"><b>${r.name}</b><span class="rs-lv ${lv ? 'on' : ''}">Lv ${lv}/${r.maxLevel}</span></div>
      ${pips}
      <small class="muted">${r.desc}${r.unlock.length ? '（第 1 級解鎖）' : ''}</small>
      ${effect}
      ${progress}${inQueue}
      ${state === 'lock' ? `<small class="neg">🔒 ${reason}</small>` : req ? `<small class="muted">前置：${req}</small>` : ''}
      ${done ? `<div class="row-between"><small class="muted"></small>${action}</div>` : `<div class="fac2-cost">
        ${running && !queuedHere.length ? timerBar(active.startAt, active.endAt) : ''}
        ${state === 'lock' ? '' : `<div class="needs">${needHtml(st, g.research.cost(id, next))}</div>`}
        <div class="row-between"><small class="muted">${state === 'lock' ? '' : `⏱ ${formatDuration(g.research.researchTime(id, next) * 1000)}・研究中心 Lv${labLevelFor(id, next)}`}</small>${action}</div>
      </div>`}
    </div>`;
  }

  /** 研究佇列：研究中的項目＋排隊中的項目（可調整順序、取消），未解鎖的格子顯示需要的研究中心等級 */
  queueCard() {
    const g = this.game;
    const rs = g.research;
    const active = g.state.research.active;
    const lab = rs.labLevel();
    const slots = rs.slots();
    const now = Date.now();
    const rows = [];
    if (active) {
      const r = RESEARCH[active.id];
      const done = Math.min(1, (now - active.startAt) / Math.max(1, active.endAt - active.startAt));
      rows.push(`<div class="rq-item run">
        <div class="row-between"><b><span class="rq-num">1</span>${r.name} Lv${active.level - 1} → Lv${active.level}</b>${btn(`取消（退還 ${Math.round(90 * (1 - done))}%）`, 'cancelResearch', {}, { cls: 'btn-xs btn-ghost btn-danger-ghost' })}</div>
        ${timerBar(active.startAt, active.endAt)}
        <small class="pos">${active.level > 1 ? `${effectText(active.id, active.level - 1)} → ` : ''}${effectText(active.id, active.level)}</small>
      </div>`);
    }
    rs.queue.forEach((q, i) => {
      const r = RESEARCH[q.id];
      const startIn = Math.max(0, rs.queueStartAt(i, now) - now);
      rows.push(`<div class="rq-item">
        <div class="row-between"><b><span class="rq-num">${i + 2}</span>${r.name} Lv${q.level - 1} → Lv${q.level}</b>
          <span class="rq-acts">${btn('▲', 'qUp', { i }, { cls: 'btn-xs btn-ghost', disabled: i === 0, title: '往前' })}${btn('▼', 'qDown', { i }, { cls: 'btn-xs btn-ghost', disabled: i === rs.queue.length - 1, title: '往後' })}${btn('取消', 'qCancel', { i }, { cls: 'btn-xs btn-ghost btn-danger-ghost' })}</span></div>
        <small class="muted">⏱ ${formatDuration(rs.researchTime(q.id, q.level) * 1000)}・約 ${formatDuration(startIn)}後開始</small>
        <small class="pos block">${q.level > 1 ? `${effectText(q.id, q.level - 1)} → ` : ''}${effectText(q.id, q.level)}</small>
      </div>`);
    });
    for (let k = rows.length; k < slots; k += 1) rows.push('<div class="rq-empty">＋ 空位：在科技卡片按「研究」或「加入佇列」</div>');
    const nextLab = lab < 15 ? (Math.floor(lab / 5) + 1) * 5 : null;
    if (lab > 0 && nextLab && nextLab <= 15) rows.push(`<div class="rq-lock">🔒 第 ${slots + 1} 格：研究中心 Lv${nextLab} 解鎖</div>`);
    return `<section class="sh-card rs-now rq-card">
      <h3>🔬 研究佇列 <small class="muted">${rs.used()}/${slots} 格</small></h3>
      ${lab ? '' : '<small class="muted">需要先建造研究中心。</small>'}
      ${rows.join('')}
    </section>`;
  }

  /** 右側：研究中、研究規則、下一個可研究 */
  side() {
    const g = this.game;
    const cur = this.queueCard();
    const nexts = Object.entries(RESEARCH)
      .map(([id, r]) => ({ id, r, s: this.stateOf(id).state }))
      .filter((x) => x.s === 'ok' || x.s === 'lack')
      .sort((a, b) => (a.s === b.s ? a.r.tier - b.r.tier : a.s === 'ok' ? -1 : 1))
      .slice(0, 6);
    return `<aside class="sh-fac-side">
      ${cur}
      <section class="sh-card sh-rates"><h3>研究規則</h3>
        <ul class="rs-rules"><li>研究中心 Lv1 有 1 格佇列，每升 5 級多 1 格</li><li>依佇列順序進行，前一項完成後自動開始下一項</li><li>加入佇列時就扣除材料；取消排隊中的項目全額退還</li><li>取消研究中的項目依完成度退還</li><li>科技第 L 級需要研究中心 Lv L</li></ul></section>
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
    // 換分支：上一個分支看過的 NEW 消失
    if (this.seenBranch !== this.branch) {
      this.clearSeen();
      this.seenBranch = this.branch;
    }
    const fresh = this.fresh();
    const items = Object.entries(RESEARCH).filter(([, r]) => r.branch === this.branch);
    const branchNav = Object.entries(RESEARCH_BRANCHES).map(([bid, b]) => {
      const n = Object.values(RESEARCH).filter((r) => r.branch === bid);
      const lv = Object.entries(RESEARCH).filter(([, r]) => r.branch === bid).reduce((s, [id]) => s + g.research.level(id), 0);
      const max = n.reduce((s, r) => s + r.maxLevel, 0);
      const nNew = Object.keys(fresh).filter((id) => RESEARCH[id]?.branch === bid).length;
      return `<button class="sh-nav-item rs-branch ${this.branch === bid ? 'active' : ''}" data-action="branch" data-b="${bid}">
        <span>${b.icon} ${b.name}${nNew ? ` <i class="rs-new-dot">NEW ${nNew}</i>` : ''}</span><small>${lv}/${max}</small><i class="rs-bar desk-only"><i style="width:${Math.round((lv / Math.max(1, max)) * 100)}%"></i></i></button>`;
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

  /** 取消排隊中的項目：列出會全額退還的材料，以及會一併取消的後續項目 */
  confirmCancelQueued(i) {
    const g = this.game;
    const q = g.research.queue[i];
    if (!q) return;
    const rest = g.research.queue.filter((_, k) => k !== i);
    const keep = [...rest];
    const dropped = [];
    while (keep.length && !g.research.validOrder(keep)) {
      const bad = keep.findIndex((_, k) => !g.research.validOrder(keep.slice(0, k + 1)));
      dropped.push(...keep.splice(bad, 1));
    }
    const refund = {};
    [q, ...dropped].forEach((x) => Object.entries(x.cost || {}).forEach(([k, v]) => { refund[k] = (refund[k] || 0) + v; }));
    const chips = Object.entries(refund).map(([k, v]) => `<span class="sr-chip">${metaOf(k).icon} ${metaOf(k).name} +${v}</span>`).join('');
    this.ui.modal.open({
      title: `取消「${RESEARCH[q.id].name} Lv${q.level}」？`,
      body: `<p class="muted">還沒開始研究，材料全額退還：</p><div class="sr-items">${chips || '<span class="muted">（沒有材料）</span>'}</div>
        ${dropped.length ? `<p class="neg">需要這項先完成的「${dropped.map((x) => `${RESEARCH[x.id].name} Lv${x.level}`).join('、')}」也會一併取消並全額退還。</p>` : ''}
        <div class="btn-row end">${btn('保留', 'close', {}, { cls: 'btn-ghost' })}${btn('取消並退還', 'doCancel', {}, { cls: 'btn-danger' })}</div>`,
      onAction: (a, _d, m) => {
        if (a !== 'doCancel') return;
        m.close();
        this.ui.result(g.research.cancelQueued(i));
        this.ui.refresh(true);
      },
    });
  }

  onAction(action, data) {
    if (action === 'start') this.ui.result(this.game.research.start(data.id));
    if (action === 'cancelResearch' && confirm('取消研究中的項目？依完成度退還材料，完成度越高退得越少。')) this.ui.result(this.game.research.cancel());
    if (action === 'qUp' || action === 'qDown') this.ui.result(this.game.research.move(+data.i, action === 'qUp' ? -1 : 1));
    if (action === 'qCancel') this.confirmCancelQueued(+data.i);
    if (action === 'branch') {
      this.branch = data.b;
      this.ui.panelEl.scrollTop = 0;
    }
    if (action === 'rsFilter') this.filter = data.f;
    if (action === 'gotoShelter') this.ui.switchTab('shelter');
  }
}
