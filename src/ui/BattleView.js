import { escapeHtml } from '../utils/dom.js';
import { gainsHtml, itemCard, progressBar } from './components.js';

/**
 * 戰鬥播放：逐行顯示戰鬥紀錄，最後顯示結果與戰利品。
 */
export function showBattle(ui, result, loot = {}, title = '⚔️ 戰鬥') {
  const lines = result.log;
  let shown = 0;
  let timer = null;

  const summary = () => `
    <div class="battle-summary ${result.victory ? 'win' : 'lose'}">
      <h4>${result.victory ? '🏆 勝利' : '💀 敗北'}（${result.duration} 秒）</h4>
      <div class="battle-teams">
        <div>${result.team.map((u) => `<div class="mini-unit ${u.down ? 'down' : ''}">${escapeHtml(u.name)} ${progressBar(u.hp / u.maxHp, 'hp', `${u.hp}/${u.maxHp}`)}</div>`).join('')}</div>
        <div>${result.enemies.map((e) => `<div class="mini-unit ${e.hp <= 0 ? 'down' : ''}">${e.icon} ${escapeHtml(e.name)} ${progressBar(e.hp / e.maxHp, 'hp enemy', `${e.hp}/${e.maxHp}`)}</div>`).join('')}</div>
      </div>
      <p>擊殺 ${result.kills.length}・經驗 +${result.xp}</p>
      <div class="gains">${gainsHtml({ coins: result.coins, parts: result.parts, ...(loot.resources || {}) })}</div>
      ${(loot.items || []).map((it) => itemCard(it, { compact: true })).join('')}
    </div>`;

  const body = (done) => `
    <div class="battle-log">${lines.slice(0, shown).map((l) => `<div class="bl ${l.type}"><i>${l.t}s</i> ${escapeHtml(l.msg)}</div>`).join('')}</div>
    ${done ? summary() : '<div class="btn-row end"><button class="btn btn-ghost" data-action="skip">跳過 ⏩</button></div>'}`;

  const modal = ui.modal.open({
    title,
    body: body(false),
    wide: true,
    onAction(action) {
      if (action === 'skip') finish();
    },
    onClose: () => clearInterval(timer),
  });

  const scrollEnd = () => {
    const log = modal.body.querySelector('.battle-log');
    if (log) log.scrollTop = log.scrollHeight;
  };
  function finish() {
    clearInterval(timer);
    shown = lines.length;
    modal.update(body(true));
    scrollEnd();
  }
  const step = Math.max(1, Math.ceil(lines.length / 40));
  timer = setInterval(() => {
    shown = Math.min(lines.length, shown + step);
    if (shown >= lines.length) finish();
    else {
      modal.update(body(false));
      scrollEnd();
    }
  }, 60);
}
