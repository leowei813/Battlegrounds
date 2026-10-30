import {
  RESEARCH, RESEARCH_BRANCHES, labLevelFor, effectText,
} from '../../config/research.js';
import { btn, costHtml, timerBar } from '../components.js';
import { formatDuration } from '../../utils/math.js';

/**
 * 研究分頁：10 個科技分支（分頁切換），每項科技都有等級。
 */
export class ResearchPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.branch = 'weapons';
  }

  node(id, r) {
    const g = this.game;
    const st = g.state;
    const active = st.research.active;
    const lv = g.research.level(id);
    const max = lv >= r.maxLevel;
    const isActive = active?.id === id;
    const check = g.research.canStart(id);
    const state = max ? 'done' : isActive ? 'active' : check.ok ? 'ready' : 'locked';
    const req = r.requires.map(([rid, need]) => `${RESEARCH[rid].name} Lv${need}`).join('、');
    return `<div class="rs-node ${state}">
      <div class="row-between"><b>${isActive ? '⏳' : `T${r.tier}`} ${r.name} <span class="tag ${lv ? 'tag-amber' : ''}">Lv${lv}/${r.maxLevel}</span></b><small>研究中心 Lv${labLevelFor(id, Math.min(r.maxLevel, lv + 1))}</small></div>
      <small class="muted block">${r.desc}${r.unlock.length ? '（第 1 級解鎖）' : ''}${req ? `・前置：${req}` : ''}</small>
      <small class="block">目前：${effectText(id, lv)}${max ? '' : `<span class="next">→ ${effectText(id, lv + 1)}</span>`}</small>
      ${max ? '<div class="tag">MAX</div>' : isActive ? timerBar(active.startAt, active.endAt) : `
        <div class="costs">${costHtml(st, g.research.cost(id))} <span class="muted">⏱${formatDuration(g.research.researchTime(id) * 1000)}</span></div>
        ${btn(lv ? `升到 Lv${lv + 1}` : '研究', 'start', { id }, { cls: 'btn-xs btn-primary', disabled: !check.ok, title: check.reason || '' })}${check.ok ? '' : `<small class="lock">${check.reason}</small>`}`}
    </div>`;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const lab = g.research.labLevel();
    const active = st.research.active;
    const total = Object.values(RESEARCH).reduce((s, r) => s + r.maxLevel, 0);
    const done = Object.values(st.research.levels).reduce((s, v) => s + v, 0);
    const tabs = Object.entries(RESEARCH_BRANCHES).map(([bid, b]) => {
      const n = Object.entries(RESEARCH).filter(([, r]) => r.branch === bid);
      const lv = n.reduce((s, [id]) => s + g.research.level(id), 0);
      return `<button class="chip ${this.branch === bid ? 'active' : ''}" data-action="branch" data-b="${bid}">${b.icon} ${b.name} <small>${lv}</small></button>`;
    }).join('');
    const nodes = Object.entries(RESEARCH)
      .filter(([, r]) => r.branch === this.branch)
      .sort((a, b2) => a[1].tier - b2[1].tier)
      .map(([id, r]) => this.node(id, r)).join('');
    return `<div class="panel-inner">
      <h2>🔬 研究 <small>${Object.keys(RESEARCH).length} 項・總等級 ${done}/${total}</small></h2>
      ${lab < 1 ? `<div class="card warn">需要先在避難所建造「研究中心」。${btn('前往避難所', 'gotoShelter', {}, { cls: 'btn-sm' })}</div>` : `<p class="muted">研究中心 Lv${lab}：研究速度 +${lab * 10}%。同時只能進行一項研究；科技第 L 級需要研究中心 Lv L 以上。</p>`}
      ${active ? `<div class="card">⏳ 研究中：<b>${RESEARCH[active.id].name} Lv${active.level}</b>${timerBar(active.startAt, active.endAt)}</div>` : ''}
      <div class="chips">${tabs}</div>
      <div class="rs-tree single">${nodes}</div>
    </div>`;
  }

  onAction(action, data) {
    if (action === 'start') this.ui.result(this.game.research.start(data.id));
    if (action === 'branch') this.branch = data.b;
    if (action === 'gotoShelter') this.ui.switchTab('shelter');
  }
}
