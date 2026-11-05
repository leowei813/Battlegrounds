import { escapeHtml } from '../utils/dom.js';

const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 單場戰鬥：標題列（點選展開）＋展開後的傷害統計與戰鬥過程 */
export function battleHtml(b, open) {
  const row = (u) => `<tr class="${u.down ? 'neg' : ''}"><td>${escapeHtml(u.name)}${u.weapon ? `<small class="muted">（${u.weapon === 'ranged' ? '遠程' : '近戰'}）</small>` : ''}</td><td>${u.dealt}</td><td>${u.hits}</td><td>${u.crits}</td><td>${u.kills}</td><td>${u.taken}</td><td>${u.healed ? `<span class="pos">+${u.healed}</span>` : ''}</td><td>${u.maxHp ? `${u.hpStart}→<b class="${u.hpEnd < u.hpStart ? 'neg' : ''}">${u.hpEnd}</b><small class="muted">/${u.maxHp}</small>` : ''}</td><td>${u.meds || ''}</td><td>${u.down ? '倒下' : ''}</td></tr>`;
  const table = (units, label) => `<h5>${label}</h5><div class="bt-wrap"><table class="battle-table"><tr><th>名稱</th><th>造成傷害</th><th>命中</th><th>暴擊</th><th>擊倒</th><th>承受傷害</th><th title="醫生急救、吸血、藥品欄用藥">回復</th><th>生命（戰前→戰後）</th><th>用藥</th><th></th></tr>${units.map(row).join('')}</table></div>`;
  return `<div class="bt-item ${b.victory ? '' : 'lose'} ${open ? 'open' : ''}">
    <div class="row-between" data-action="toggleBattle" data-id="${b.id}">
      <span>${b.victory ? '🏆' : '💀'} ${escapeHtml(b.title)}${b.fights > 1 ? `<small class="muted">（${b.fights} 次交戰）</small>` : ''}</span><small class="muted">${hhmm(b.at)}・${b.duration} 秒 ${open ? '▲' : '▼'}</small>
    </div>
    <small class="muted">我方：${b.team.map((u) => `${escapeHtml(u.name)} ${u.dealt}`).join('、')}</small>
    ${open ? `${table(b.team, '📊 我方傷害統計')}${table(b.foes, '📊 敵方')}
      <small class="muted block">承受傷害是整場戰鬥被打的總量；醫生急救、吸血與藥品會在戰鬥中補回生命，所以戰後生命可能比「戰前 − 承受傷害」高。守城時的傷勢另計。</small>
      ${b.log?.length ? `<h5>📜 戰鬥過程</h5><ol class="battle-log">${b.log.map((l) => `<li class="bl-${l.type}">${l.t >= 0 ? `<time>${l.t}s</time>` : ''}${escapeHtml(l.msg)}</li>`).join('')}</ol>` : '<small class="muted block">（較早的戰鬥只保留統計，沒有逐筆過程）</small>'}` : ''}
  </div>`;
}

/** 報告或紀錄裡的「⚔️ 本次戰鬥」區塊（依發生順序） */
export function battlesSectionHtml(game, ids, openId) {
  const list = (ids || []).map((id) => game.combat.battle(id)).filter(Boolean);
  if (!list.length) return '';
  return `<div class="bt-section"><div class="label">⚔️ 本次戰鬥（${list.length} 場）</div>${list.map((b) => battleHtml(b, openId === b.id)).join('')}</div>`;
}
