import { escapeHtml } from '../utils/dom.js';
import { metaOf } from './components.js';

const chip = (text, cls = '') => `<span class="sr-chip ${cls}">${text}</span>`;
const itemChips = (items, sign, cls = '') => Object.entries(items || {})
  .map(([k, v]) => chip(`${metaOf(k).icon} ${escapeHtml(metaOf(k).name)} ${sign}${v}`, cls));

/** Boss 戰利品 */
function bossHtml(boss, compact) {
  if (!boss) return '';
  const list = [...itemChips(boss.items, '×')];
  if (boss.gear) list.push(chip(`🎁 ${escapeHtml(boss.gear.name)}`, 'gold'));
  if (boss.blueprint) list.push(chip(`📜 ${escapeHtml(boss.blueprint)}`, 'blue'));
  if (compact) return list.length ? chip(`👑 Boss 戰利品 ${list.length} 項`) : '';
  return `<div class="sr-sec">👑 擊殺 Boss「${escapeHtml(boss.name)}」的戰利品</div><div class="sr-items">${list.join('') || '<span class="muted">（沒有戰利品）</span>'}</div>`;
}

/**
 * 屍潮結算明細（天亮守住的獎勵，或被突破時的損失）。
 * @param {object} e 防守紀錄
 * @param {boolean} compact 紀錄列表用的精簡版
 */
export function siegeDetailHtml(e, compact = false) {
  const s = e.siege;
  if (!s) return '';
  if (e.success) {
    const gains = [chip(`💰 金幣 ×${s.coins}`), ...itemChips(s.items, '×')];
    (s.blueprints || []).forEach((b) => gains.push(chip(`📜 ${escapeHtml(b)}`, 'blue')));
    if (compact) {
      return `<div class="sr-items">${chip(`評價 ${escapeHtml(s.gradeName)} ×${s.mul}`, `g-${s.grade}`)}${gains.join('')}${bossHtml(s.boss, true)}${s.xp?.length ? chip(`🎖️ ${s.xp.length} 人駐守經驗`) : ''}</div>`;
    }
    return `<div class="sr-stats">
        <div><b>${e.kills}</b><small>擊殺</small></div>
        <div><b>${s.wallPct}%</b><small>城牆剩餘</small></div>
        <div><b><span class="sr-grade g-${s.grade}">${escapeHtml(s.gradeName)} ×${s.mul}</span></b><small>防守評價</small></div>
      </div>
      <div class="sr-bar"><i style="width:${s.wallPct}%"></i></div>
      <small class="muted block">城牆剩 ≥80% 優秀 ×1.5・50～80% 良好 ×1.2・20～50% 普通 ×1.0・&lt;20% 勉強 ×0.7</small>
      <div class="sr-sec">📦 防守物資箱</div><div class="sr-items">${gains.join('')}</div>
      ${bossHtml(s.boss)}
      ${s.xp?.length ? `<div class="sr-sec">🎖️ 駐守經驗（整晚駐守的人，各得升級所需 5%）</div>
        ${s.xp.map((x) => `<div class="sr-row"><span>${escapeHtml(x.name)} Lv${x.level}</span><span class="pos">+${x.xp} 經驗</span></div>`).join('')}` : ''}`;
  }
  const lost = Object.entries(e.lost || {}).map(([k, v]) => chip(`${metaOf(k).icon} ${escapeHtml(metaOf(k).name)} −${v}`, 'loss'));
  const mats = itemChips(s.materials, '−', 'loss');
  const hurt = (s.injuries || []).filter((x) => !x.ok);
  if (compact) {
    const sev = hurt.filter((x) => x.severe).length;
    const light = hurt.length - sev;
    return `<div class="sr-items">${chip(`📉 資源 −${s.lossPct}%`, 'loss')}${mats.length ? chip(`🧰 材料 −${Object.values(s.materials).reduce((a, b) => a + b, 0)}`, 'loss') : ''}${(e.damaged || []).map((d) => chip(`🏚️ ${escapeHtml(d)}`, 'loss')).join('')}${hurt.length ? chip(`🩹 ${[light ? `輕傷 ${light}` : '', sev ? `重傷 ${sev}` : ''].filter(Boolean).join('・')}`, 'loss') : ''}</div>`;
  }
  return `<div class="sr-stats">
      <div><b>${e.kills}</b><small>擊殺</small></div>
      <div><b>${Math.max(0, s.wave - 1)}/${s.maxWaves}</b><small>撐過波數</small></div>
      <div><b><span class="sr-grade g-barely">−${s.lossPct}%</span></b><small>資源損失</small></div>
    </div>
    <small class="muted block">資源損失 55%（第 1 波被破）→ 約 26%（撐到最後一波才破），地窖內不受影響</small>
    <div class="sr-sec">📉 資源損失（${s.lossPct}%）</div><div class="sr-items">${lost.join('') || '<span class="muted">（沒有可損失的資源）</span>'}</div>
    ${mats.length ? `<div class="sr-sec">🧰 材料損失（部分零件、布料被奪走或損壞）</div><div class="sr-items">${mats.join('')}</div>` : ''}
    ${e.damaged?.length ? `<div class="sr-sec">🏚️ 防禦設施</div>${e.damaged.map((d) => `<div class="sr-row"><span class="neg">${escapeHtml(d)}</span></div>`).join('')}` : ''}
    ${s.injuries?.length ? `<div class="sr-sec">🩹 駐守人員傷勢</div>${s.injuries.map((x) => `<div class="sr-row"><span>${escapeHtml(x.name)}</span><span class="${x.ok ? 'muted' : 'neg'}">${x.severe ? '重傷（需醫療站治療）' : x.light ? '輕傷（生命 −30%）' : '無傷'}</span></div>`).join('')}` : ''}
    ${bossHtml(s.boss)}`;
}

/** 天亮或被突破時跳出的結算視窗 */
export function openSiegeResult(ui, e) {
  if (!e?.siege) return;
  const s = e.siege;
  const title = e.success
    ? `🌅 天亮了：「${e.baseName}」守住屍潮！`
    : `💥 「${e.baseName}」防線在第 ${s.wave}/${s.maxWaves} 波被突破`;
  const sub = e.success ? `第 ${e.waves}/${e.waves} 波全數擊退${s.boss ? `・👑 擊殺 Boss「${escapeHtml(s.boss.name)}」` : ''}` : '越早被突破，損失越重';
  ui.modal.open({
    title,
    body: `<div class="siege-result ${e.success ? 'ok' : 'fail'}"><small class="muted block">${sub}</small>${siegeDetailHtml(e)}
      <div class="btn-row end"><button class="btn ${e.success ? 'btn-primary' : 'btn-ghost'}" data-action="close">${e.success ? '收下' : '知道了'}</button></div></div>`,
  });
}
