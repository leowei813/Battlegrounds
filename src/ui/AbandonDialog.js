import { escapeHtml } from '../utils/dom.js';
import { gainsHtml } from './components.js';
import { ABANDON_REFUND, RELOCATE_DEFENSE_REFUND, RELOCATE_KEEP } from '../config/civilization.js';
import { RESOURCES } from '../config/constants.js';
import { FACILITIES } from '../config/facilities.js';
import { DEFENSES } from '../config/defenses.js';
import { RESEARCH } from '../config/research.js';
import { formatNumber } from '../utils/math.js';

/** 搬遷避難所的說明與確認內容 */
function relocateBody(g, base, p) {
  const keepPct = Math.round(RELOCATE_KEEP * 100);
  const defPct = Math.round(RELOCATE_DEFENSE_REFUND * 100);
  const res = (o) => Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => `<span class="gain">${RESOURCES[k].icon}${RESOURCES[k].name} ${formatNumber(v)}</span>`).join('') || '<span class="muted">無</span>';
  const cancel = [
    p.research ? `🔬 研究「${RESEARCH[p.research.id]?.name || ''}」Lv${p.research.level}` : '',
    p.builds ? `🔨 施工中的建築 ${p.builds} 項` : '',
  ].filter(Boolean);
  return `
    <p>搬離「<b>${escapeHtml(base.name)}</b>」後，可以在地圖上選擇新的地點重新建立避難所（免費）。</p>
    <ol class="reloc-steps">
      <li><b>進行中的工作先取消</b>：${cancel.length ? `${cancel.join('、')}，依完成度退還材料：<div class="gains">${Object.keys(p.cancelled).length ? gainsHtml(p.cancelled) : '<span class="muted">無</span>'}</div>` : '<span class="muted">目前沒有進行中的研究或施工。</span>'}</li>
      <li><b>防禦建築全部拆除</b>，退還 ${defPct}% 建造材料：${p.defenses.length ? `<small class="muted block">${p.defenses.map((d) => `${DEFENSES[d.type].icon}${DEFENSES[d.type].name} Lv${d.level}`).join('、')}</small><div class="gains">${gainsHtml(p.defRefund)}</div>` : '<span class="muted">沒有防禦建築。</span>'}</li>
      <li><b>其他設施保留</b>到新的避難所；新地點較小時，超過上限的設施會降到上限，降掉的等級退還 50% 建造材料（設施最高：小型 Lv8、中型 Lv11、大型 Lv13、巨型 Lv15）：<small class="muted block">${p.facilities.map((f) => `${FACILITIES[f.id]?.icon || ''}${FACILITIES[f.id]?.name || f.id} Lv${f.level}`).join('、') || '無'}</small></li>
      <li><b>食物、木材、燃料只能帶走 ${keepPct}%</b>（包含上面退還的部分）：
        <div class="label">搬遷前</div><div class="gains">${res(p.before)}</div>
        <div class="label">帶走</div><div class="gains">${res(p.keep)}</div>
        ${Object.keys(p.lost).length ? `<div class="label neg">⚠️ 遺棄</div><div class="gains">${gainsHtml(Object.fromEntries(Object.entries(p.lost).map(([k, v]) => [k, -v])))}</div>` : ''}</li>
    </ol>
    <p class="muted">倖存者、裝備、物品倉庫（零件、布料等）、金錢、載具與研究等級都會跟著搬走。搬遷期間沒有避難所，無法生產與探索。</p>
    ${g.state.expeditions.length ? '<p class="neg">⚠️ 有隊伍在外，需要等隊伍回來才能搬遷。</p>' : ''}
    <div class="btn-row end">
      <button class="btn btn-ghost" data-action="close">取消</button>
      <button class="btn btn-danger" data-action="confirm" ${g.state.expeditions.length ? 'disabled' : ''}>🚚 確定搬遷</button>
    </div>`;
}

/**
 * 搬遷避難所／放棄前哨站的確認視窗。
 * @param {import('./UIManager.js').UIManager} ui
 * @param {object} base
 * @param {() => void} [onDone]
 */
export function openAbandonDialog(ui, base, onDone) {
  const g = ui.game;
  const p = g.shelter.abandonPreview(base.id);
  if (!p) return;
  const shelter = base.kind !== 'outpost';
  const pct = Math.round(ABANDON_REFUND * 100);
  const body = shelter ? relocateBody(g, base, p) : `
    <p>放棄前哨站「<b>${escapeHtml(base.name)}</b>」後，所有設施與防禦建築都會消失，退還 ${pct}% 的建造資源：</p>
    <div class="gains">${Object.keys(p.refund).length ? gainsHtml(p.refund) : '<span class="muted">（沒有可退還的資源）</span>'}</div>
    <div class="btn-row end">
      <button class="btn btn-ghost" data-action="close">取消</button>
      <button class="btn btn-danger" data-action="confirm">🏚️ 確定放棄</button>
    </div>`;
  ui.modal.open({
    title: shelter ? '🚚 搬遷避難所' : '🏚️ 放棄前哨站',
    body,
    onAction: (action, _d, m) => {
      if (action !== 'confirm') return;
      const r = ui.result(g.shelter.abandon(base.id));
      if (r.ok) {
        m.close();
        ui.setViewBase(null);
        onDone?.();
      }
    },
  });
}
