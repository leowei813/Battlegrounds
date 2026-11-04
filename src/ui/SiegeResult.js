import { escapeHtml } from '../utils/dom.js';
import { metaOf } from './components.js';
import { SUPPLIES } from '../config/supplies.js';

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

const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const ofCat = (items, cats) => Object.fromEntries(Object.entries(items || {}).filter(([k]) => cats.includes(SUPPLIES[k]?.cat)));
/** 明細用的小字清單：「名稱 數量・名稱 數量」 */
const plainList = (items, sign = '') => Object.entries(items || {}).map(([k, v]) => `${escapeHtml(metaOf(k).name)} ${sign}${v}`).join('・');
const groupRow = (label, count, list) => (list ? `<div class="sr-group"><div class="sr-group-h"><b>${label}</b>${count != null ? `<span>×${count}</span>` : ''}</div><div class="sr-group-l">${list}</div></div>` : '');

/** 紀錄收合時：只顯示一行總數 */
function summaryHtml(e) {
  const s = e.siege;
  if (e.success) {
    const parts = sum(ofCat(s.items, ['part', 'fabric'])) + sum(ofCat(s.boss?.items, ['part', 'fabric']));
    const ammo = sum(ofCat(s.items, ['ammo']));
    const list = [
      chip(`評價 ${escapeHtml(s.gradeName)} ×${s.mul}`, `g-${s.grade}`),
      chip(`💰 ${s.coins}`),
      parts ? chip(`🔩 零件 ×${parts}`) : '',
      ammo ? chip(`🎯 彈藥 ×${ammo}`) : '',
      s.boss ? chip(`👑 Boss${s.boss.gear ? '・🎁' : ''}`, s.boss.gear ? 'gold' : '') : '',
      (s.blueprints?.length || s.boss?.blueprint) ? chip(`📜 設計圖 ×${(s.blueprints?.length || 0) + (s.boss?.blueprint ? 1 : 0)}`, 'blue') : '',
      s.xp?.length ? chip(`🎖️ ${s.xp.length} 人經驗`) : '',
    ];
    return `<div class="sr-items">${list.join('')}</div>`;
  }
  const hurt = (s.injuries || []).filter((x) => !x.ok);
  const sev = hurt.filter((x) => x.severe).length;
  const light = hurt.length - sev;
  const list = [
    chip(`📉 資源 −${s.lossPct}%`, 'loss'),
    sum(s.materials) ? chip(`🧰 材料 −${sum(s.materials)}`, 'loss') : '',
    e.damaged?.length ? chip(`🏚️ 設施損毀 ${e.damaged.length}`, 'loss') : '',
    hurt.length ? chip(`🩹 ${[light ? `輕傷 ${light}` : '', sev ? `重傷 ${sev}` : ''].filter(Boolean).join('・')}`, 'loss') : '',
  ];
  return `<div class="sr-items">${list.join('')}</div>`;
}

/** 紀錄展開後：只補充收合時沒有的細項，依類別分組 */
function recordDetailHtml(e) {
  const s = e.siege;
  if (e.success) {
    const parts = ofCat(s.items, ['part', 'fabric']);
    const ammo = ofCat(s.items, ['ammo']);
    const boss = s.boss ? [plainList(s.boss.items), s.boss.gear ? `🎁 ${escapeHtml(s.boss.gear.name)}` : '', s.boss.blueprint ? `📜 ${escapeHtml(s.boss.blueprint)}` : ''].filter(Boolean).join('・') : '';
    return `<div class="sr-groups">
      ${groupRow('🔩 零件', sum(parts), plainList(parts))}
      ${groupRow('🎯 彈藥', sum(ammo), plainList(ammo))}
      ${groupRow('📜 設計圖', null, (s.blueprints || []).map(escapeHtml).join('・'))}
      ${s.boss ? groupRow(`👑 Boss「${escapeHtml(s.boss.name)}」`, null, boss || '（沒有戰利品）') : ''}
      ${groupRow('🎖️ 駐守經驗', null, (s.xp || []).map((x) => `${escapeHtml(x.name)} Lv${x.level} <span class="pos">+${x.xp}</span>`).join('・'))}
      <small class="muted block">評價依城牆剩餘：≥80% 優秀 ×1.5・50～80% 良好 ×1.2・20～50% 普通 ×1.0・&lt;20% 勉強 ×0.7</small>
    </div>`;
  }
  const hurt = (s.injuries || []).map((x) => `${escapeHtml(x.name)} ${x.severe ? '<span class="neg">重傷</span>' : x.light ? '<span class="neg">輕傷</span>' : '<span class="muted">無傷</span>'}`).join('・');
  return `<div class="sr-groups">
    ${groupRow(`📉 資源 −${s.lossPct}%`, null, plainList(e.lost, '−') || '（沒有可損失的資源）')}
    ${groupRow('🧰 材料', sum(s.materials), plainList(s.materials, '−'))}
    ${groupRow('🏚️ 防禦設施', null, (e.damaged || []).map(escapeHtml).join('・'))}
    ${groupRow('🩹 駐守人員', null, hurt)}
    <small class="muted block">撐過 ${Math.max(0, s.wave - 1)}/${s.maxWaves} 波・資源損失 55%（第 1 波被破）→ 約 26%（最後一波才破），地窖內不受影響</small>
  </div>`;
}

/**
 * 屍潮結算明細（天亮守住的獎勵，或被突破時的損失）。
 * @param {object} e 防守紀錄
 * @param {boolean|'summary'|'detail'} compact 紀錄收合（summary／true）、紀錄展開（detail）；省略為結算視窗的完整版
 */
export function siegeDetailHtml(e, compact = false) {
  const s = e.siege;
  if (!s) return '';
  if (compact === 'summary' || compact === true) return summaryHtml(e);
  if (compact === 'detail') return recordDetailHtml(e);
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
