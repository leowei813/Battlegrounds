import { RESEARCH, RESEARCH_BRANCHES, requiredLabLevel } from '../../config/research.js';
import { btn, costHtml, timerBar } from '../components.js';
import { formatDuration } from '../../utils/math.js';

/**
 * 研究分頁：五大科技分支，每分支四階。
 */
export class ResearchPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const lab = g.research.labLevel();
    const active = st.research.active;
    const branches = Object.entries(RESEARCH_BRANCHES).map(([bid, b]) => {
      const nodes = Object.entries(RESEARCH)
        .filter(([, r]) => r.branch === bid)
        .sort((a, b2) => a[1].tier - b2[1].tier)
        .map(([id, r]) => {
          const done = g.research.isDone(id);
          const isActive = active?.id === id;
          const check = g.research.canStart(id);
          const state = done ? 'done' : isActive ? 'active' : check.ok ? 'ready' : 'locked';
          return `<div class="rs-node ${state}">
            <div class="row-between"><b>${done ? '✅' : isActive ? '⏳' : `T${r.tier}`} ${r.name}</b><small>研究中心 Lv${requiredLabLevel(r.tier)}</small></div>
            <small class="muted block">${r.desc}</small>
            ${done ? '' : isActive ? timerBar(active.startAt, active.endAt) : `
              <div class="costs">${costHtml(st, r.cost)} <span class="muted">⏱${formatDuration(g.research.researchTime(id) * 1000)}</span></div>
              ${btn('研究', 'start', { id }, { cls: 'btn-xs btn-primary', disabled: !check.ok, title: check.reason || '' })}${check.ok ? '' : `<small class="lock">${check.reason}</small>`}`}
          </div>`;
        }).join('');
      return `<div class="rs-branch"><h3>${b.icon} ${b.name}</h3>${nodes}</div>`;
    }).join('');
    return `<div class="panel-inner">
      <h2>🔬 研究 <small>${st.research.completed.length}/${Object.keys(RESEARCH).length}</small></h2>
      ${lab < 1 ? `<div class="card warn">需要先在避難所建造「研究中心」。${btn('前往避難所', 'gotoShelter', {}, { cls: 'btn-sm' })}</div>` : `<p class="muted">研究中心 Lv${lab}：研究速度 +${lab * 10}%。同時只能進行一項研究。</p>`}
      <div class="rs-tree">${branches}</div>
    </div>`;
  }

  onAction(action, data) {
    if (action === 'start') this.ui.result(this.game.research.start(data.id));
    if (action === 'gotoShelter') this.ui.switchTab('shelter');
  }
}
