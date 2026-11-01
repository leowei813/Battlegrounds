import { escapeHtml } from '../utils/dom.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS, unitWeight } from '../config/supplies.js';
import { CLASSES } from '../config/survivors.js';
import { MAX_DEMAND_QTY, MAX_DEMAND_PRICE } from '../systems/DemandSystem.js';
import { btn, metaOf } from './components.js';

/**
 * 交易所：管理自己的收購需求（避難所頁的「交易所」分頁）。
 * @param {{key?:string, qty?:number, price?:number}} form 表單目前輸入的值（重新繪製時保留）
 */
export function exchangeBody(ui, form = {}) {
  const g = ui.game;
  const lv = g.demand.exchangeLevel();
  if (lv < 1) return '<p class="muted">需要先在避難所建造🏪交易所，才能和其他玩家交易與發布收購需求。</p>';
  const rows = g.demand.list.map((d) => `<div class="card row-between"><div><b>${g.demand.label(d.key)}</b>
    <small class="muted block">已收 ${d.filled}/${d.qty}・每個 💰${d.price}・保留中 💰${(d.qty - d.filled) * d.price}</small></div>
    ${btn('取消（退還保留金額）', 'exCancel', { id: d.id }, { cls: 'btn-xs btn-ghost' })}</div>`).join('');
  const opt = (k, label) => `<option value="${k}" ${form.key === k ? 'selected' : ''}>${label}</option>`;
  const opts = [
    `<optgroup label="基礎物資">${RESOURCE_KEYS.map((k) => opt(k, `${metaOf(k).icon} ${metaOf(k).name}`)).join('')}</optgroup>`,
    ...Object.entries(SUPPLY_CATS).map(([cat, c]) => `<optgroup label="${c.name}">${SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === cat).map((k) => opt(k, `${SUPPLIES[k].icon} ${SUPPLIES[k].name}`)).join('')}</optgroup>`),
  ].join('');
  const full = g.demand.list.length >= g.demand.maxDemands();
  return `<p>🏪 交易所 Lv${lv}：可以同時掛 <b>${g.demand.maxDemands()}</b> 項收購（目前 ${g.demand.list.length} 項）。</p>
    <p class="muted">掛出收購後，其他玩家會在地圖上看到你據點的 📢 圖示，可以派倖存者帶著物資走過來交付。收購總額（數量 × 單價）會先保留起來，交付時自動付款，取消時退還。</p>
    <p>💰 你的金錢：<b>${g.state.player.coins}</b></p>
    <h4>收購中</h4><div class="grid">${rows || '<p class="muted">目前沒有收購需求。</p>'}</div>
    <h4>發布收購</h4>
    <div class="trade-row demand-form">
      <label>物資 <select class="d-key">${opts}</select></label>
      <label>數量 <input type="number" class="d-qty" min="1" max="${MAX_DEMAND_QTY}" value="${form.qty ?? 10}" inputmode="numeric"></label>
      <label>單價 💰<input type="number" class="d-price" min="0" max="${MAX_DEMAND_PRICE}" value="${form.price ?? 5}" inputmode="numeric"></label>
      ${btn('📢 掛出收購', 'exPost', {}, { cls: 'btn-sm btn-primary', disabled: full, title: full ? '已達同時收購上限，升級交易所可增加' : '' })}
    </div>`;
}

/** 讀取收購表單目前的值 */
export function exchangeForm(root) {
  const f = root?.querySelector('.demand-form');
  if (!f) return null;
  return { key: f.querySelector('.d-key').value, qty: f.querySelector('.d-qty').value, price: f.querySelector('.d-price').value };
}

/** 交易所分頁的操作；回傳是否處理了 */
export function exchangeAction(ui, action, data, root) {
  const g = ui.game;
  if (action === 'exCancel') ui.result(g.demand.cancel(data.id));
  else if (action === 'exPost') {
    const f = exchangeForm(root);
    if (f) ui.result(g.demand.post(f.key, f.qty, f.price));
  } else return false;
  g.changed?.();
  return true;
}

/** 出貨方：派倖存者帶物資到對方據點交付收購 */
export function openDeliver(ui, player, demand) {
  const g = ui.game;
  let svId = g.state.survivors.find((s) => g.survivors.isAvailable(s))?.id || null;
  const have = () => Math.floor(RESOURCE_KEYS.includes(demand.key) ? g.state.resources[demand.key] || 0 : g.state.supplies?.[demand.key] || 0);
  const body = () => {
    const c = g.demand.canDeliver(player.id, demand.id);
    const sv = g.survivors.get(svId);
    const avail = g.state.survivors.filter((s) => g.survivors.isAvailable(s));
    const picks = avail.map((s) => `<button class="chip ${s.id === svId ? 'active' : ''}" data-action="pickSv" data-id="${s.id}">${CLASSES[s.classId].icon} ${escapeHtml(s.name)} Lv${s.level}</button>`).join('');
    const room = sv ? Math.floor(Math.max(0, g.survivors.bagCap(sv) - g.survivors.bagLoad(sv)) / unitWeight(demand.key)) : 0;
    const max = Math.max(0, Math.min(demand.qty, have(), room));
    return `<p>📢 「<b>${escapeHtml(player.name)}</b>」收購 <b>${g.demand.label(demand.key)}</b>：還要 ${demand.qty} 個，每個 💰${demand.price}</p>
      <p class="muted">倖存者會帶著物資走到對方據點交出（需要移動時間），對方上線後付款；對方收不下或已經收滿的部分會退回你的倉庫。</p>
      ${c.ok ? '' : `<p class="neg">⚠️ ${escapeHtml(c.reason)}</p>`}
      <div class="label">派誰去</div><div class="chips">${picks || '<span class="muted">沒有可出發的倖存者</span>'}</div>
      <p class="muted">倉庫有 ${have()} 個${sv ? `・${escapeHtml(sv.name)} 最多帶得動 ${room} 個` : ''}</p>
      <div class="trade-row"><label>交付數量 <input type="number" class="dl-qty" min="1" max="${max}" value="${max}" inputmode="numeric"></label>
        <span class="muted">可得約 💰<b class="dl-sum">${max * demand.price}</b></span></div>
      <div class="btn-row">${btn('🚶 出發交付', 'go', {}, { cls: 'btn-primary', disabled: !c.ok || !sv || max < 1 })}</div>`;
  };
  ui.modal.open({
    title: '📦 交付收購',
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'pickSv') {
        svId = data.id;
        m.update(body());
        return;
      }
      if (action !== 'go') return;
      const qty = Number(m.el.querySelector('.dl-qty')?.value) || 0;
      const r = ui.result(g.demand.deliver(player.id, demand.id, svId, qty));
      if (r.ok) {
        m.close();
        ui.panels.map?.renderMap?.(true);
      }
    },
  });
}
