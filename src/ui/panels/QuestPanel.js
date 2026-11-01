import { ACHIEVEMENTS, MAIN_QUESTS } from '../../config/quests.js';
import { btn, progressBar } from '../components.js';
import { formatNumber } from '../../utils/math.js';
import { escapeHtml } from '../../utils/dom.js';

/**
 * 任務分頁：主線、每日、成就。
 */
export class QuestPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  questCard(def, prog, claimable, claimAction, data, claimed = false) {
    const q = this.game.quests;
    return `<div class="quest ${claimed ? 'claimed' : claimable ? 'ready' : ''}">
      <div class="row-between"><b>${def.name}</b>${claimed ? '<span class="tag">已領取</span>' : btn(claimable ? '領取' : '進行中', claimAction, data, { cls: 'btn-xs btn-primary', disabled: !claimable })}</div>
      <small class="muted block">${def.desc}</small>
      ${progressBar(prog.cur / prog.max, '', `${formatNumber(Math.min(prog.cur, prog.max))}/${formatNumber(prog.max)}`)}
      <small class="reward">獎勵：${q.rewardText(def.reward)}</small>
    </div>`;
  }

  render() {
    const g = this.game;
    const q = g.quests;
    const main = q.currentMain();
    const mainHtml = main
      ? this.questCard(main, q.progress(main.cond), q.isDone(main.cond), 'claimMain', {})
      : '<p class="muted">🎉 你已完成所有主線任務！</p>';
    const dailies = q.dailyDefs().map((d) => this.questCard(d.def, q.progress(d.def.cond, d.baseline), q.isDone(d.def.cond, d.baseline), 'claimDaily', { id: d.id }, d.claimed)).join('');
    // 成就：可領取的排最前面，已領取的收合到最下方（點擊展開）
    const card = (a) => this.questCard(a, q.progress(a.cond), q.isDone(a.cond), 'claimAch', { id: a.id }, !!g.state.quests.achievements[a.id]);
    const open = ACHIEVEMENTS.filter((a) => !g.state.quests.achievements[a.id])
      .sort((a, b) => Number(q.isDone(b.cond)) - Number(q.isDone(a.cond)));
    const done = ACHIEVEMENTS.filter((a) => g.state.quests.achievements[a.id]);
    const ach = `${open.map(card).join('') || '<p class="muted">所有成就都已達成！</p>'}`;
    const doneHtml = done.length ? `<div class="btn-row">${btn(`${this.showDone ? '▲ 收合' : '▼ 展開'}已達成的成就（${done.length}）`, 'toggleDoneAch', {}, { cls: 'btn-sm btn-ghost' })}</div>
      ${this.showDone ? `<div class="grid">${done.map(card).join('')}</div>` : ''}` : '';
    const doneAch = Object.keys(g.state.quests.achievements).length;
    const claimedN = q.dailyDefs().filter((d) => d.claimed).length;
    const opened = g.state.quests.chestDate === g.state.quests.dailyDate;
    const chest = `<div class="card row-between chest-card ${q.chestReady() ? 'ready' : ''}"><div><b>🎁 每日物資箱</b>
      <small class="muted block">領取當天全部每日任務（${claimedN}/${q.dailyDefs().length}）後可開啟一次：隨機 3～5 項零件、布料、藥品、彈藥、裝備或設計圖，越高階、品級越高越難開到。</small></div>
      ${opened ? '<span class="tag">今天已開啟</span>' : btn('開啟', 'openChest', {}, { cls: 'btn-sm btn-primary', disabled: !q.chestReady() })}</div>`;
    return `<div class="panel-inner">
      <h2>📜 任務</h2>
      <h3>主線 <small>${Math.min(g.state.quests.mainIndex + 1, MAIN_QUESTS.length)}/${MAIN_QUESTS.length}</small></h3>${mainHtml}
      <h3>每日任務 <small class="muted">每天 00:00 重置</small></h3><div class="grid">${dailies}</div>${chest}
      <h3>成就 <small>${doneAch}/${ACHIEVEMENTS.length}</small></h3><div class="grid">${ach}</div>${doneHtml}
    </div>`;
  }

  onAction(action, data) {
    const q = this.game.quests;
    if (action === 'claimMain') this.ui.result(q.claimMain());
    if (action === 'claimDaily') this.ui.result(q.claimDaily(data.id));
    if (action === 'claimAch') this.ui.result(q.claimAchievement(data.id));
    if (action === 'toggleDoneAch') {
      this.showDone = !this.showDone;
      this.ui.refresh(true);
    }
    if (action === 'openChest') {
      const r = this.ui.result(q.openChest());
      if (r.ok) this.ui.modal.open({ title: '🎁 每日物資箱', body: `<ul class="event-list">${r.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('') || '<li>倉庫已滿，什麼都放不下</li>'}</ul>` });
    }
  }
}
