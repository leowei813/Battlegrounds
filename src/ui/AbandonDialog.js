import { escapeHtml } from '../utils/dom.js';
import { gainsHtml } from './components.js';
import { ABANDON_REFUND } from '../config/civilization.js';
import { VEHICLES } from '../config/vehicles.js';
import { RESOURCES } from '../config/constants.js';
import { formatNumber } from '../utils/math.js';

/**
 * 放棄據點的確認視窗：顯示退還的建造資源；放棄避難所時另外顯示能帶走與會被遺棄的物資。
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
  const lost = Object.values(p.lost || {}).reduce((s, v) => s + v, 0);
  const body = `
    <p>放棄${shelter ? '避難所' : '前哨站'}「<b>${escapeHtml(base.name)}</b>」後，所有設施與防禦建築都會消失，退還 ${pct}% 的建造資源：</p>
    <div class="gains">${Object.keys(p.refund).length ? gainsHtml(p.refund) : '<span class="muted">（沒有可退還的資源）</span>'}</div>
    ${shelter ? `
      <h4>🚚 搬家</h4>
      <p class="muted">沒有避難所時無法生產與探索，請在地圖上選擇新的建築重新建立（免費）。<br>
      所有物資只能帶走「人 + 有人駕駛的載具」載得動的量：可行動 ${p.people} 人、載具 ${p.vehicles.length} 台
      ${p.vehicles.map((v) => VEHICLES[v.type].icon).join('')}，共可搬運 <b>${p.carry}</b> 單位。</p>
      <div class="label">可帶走</div><div class="gains">${Object.entries(p.keep).filter(([, v]) => v > 0).map(([k, v]) => `<span class="gain">${RESOURCES[k].icon}${formatNumber(v)}</span>`).join('') || '<span class="muted">無</span>'}</div>
      ${lost ? `<div class="label neg">⚠️ 帶不走、會被遺棄（${lost}）</div><div class="gains">${gainsHtml(Object.fromEntries(Object.entries(p.lost).map(([k, v]) => [k, -v])))}</div>` : '<p class="pos">✅ 全部物資都帶得走</p>'}` : ''}
    <div class="btn-row end">
      <button class="btn btn-ghost" data-action="close">取消</button>
      <button class="btn btn-danger" data-action="confirm">🏚️ 確定放棄</button>
    </div>`;
  ui.modal.open({
    title: `🏚️ 放棄${shelter ? '避難所' : '前哨站'}`,
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
