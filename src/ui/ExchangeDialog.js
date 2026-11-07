import { escapeHtml } from '../utils/dom.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS } from '../config/supplies.js';
import {
  MAX_LISTING_QTY, MAX_LISTING_PRICE, LISTING_MS, goodName, goodIcon, listingName,
} from '../systems/MarketSystem.js';
import { formatDuration } from '../utils/math.js';
import { DG_CORES, DG_CORE_KEYS } from '../config/dungeons.js';
import { btn, metaOf, itemCard } from './components.js';

const label = (k) => `${goodIcon(k)} ${goodName(k)}`;
/** 設計圖刊登的卡片 */
const bpCard = (g, d, actions) => {
  const info = g.equipment.blueprintInfo(d.bp) || { name: d.bpName || '設計圖', label: '', color: '#90a4ae' };
  return `<div class="card row-between ${info.dungeon ? 'dg-bp' : ''}"><div><b>📜 <span style="color:${info.color}">${escapeHtml(info.name)}</span></b> <small style="color:${info.color}">${escapeHtml(info.label)}</small>
    <small class="muted block">💰${(d.price || 0).toLocaleString()}</small></div><span class="trade-row">${actions}</span></div>`;
};
const have = (g, k) => Math.floor(RESOURCE_KEYS.includes(k) ? g.state.resources[k] || 0 : DG_CORES[k] ? g.state.dgCores?.[k] || 0 : g.state.supplies?.[k] || 0);

/**
 * 交易所分頁：交易市場（刊登賣單／收購，與其他玩家即時成交）。
 * @param {{side?:string, key?:string, itemId?:string, qty?:number, price?:number, view?:string}} form 表單目前輸入的值
 */
export function exchangeBody(ui, form = {}) {
  const g = ui.game;
  const mk = g.market;
  const lv = mk.level();
  if (lv < 1) return '<p class="muted">需要先在避難所建造🏪交易所，才能使用交易市場。</p>';
  const now = Date.now();
  const view = form.view || 'market';
  const tabs = `<div class="chips">${[['market', '🛒 市場'], ['mine', `📋 我的刊登 ${mk.mine().length}`], ['post', '➕ 刊登']]
    .map(([v, t]) => `<button class="chip ${view === v ? 'active' : ''}" data-action="exView" data-v="${v}">${t}</button>`).join('')}</div>`;
  const head = `<p>🏪 交易所 Lv${lv}：可同時刊登賣單 <b>${mk.limit()}</b> 筆、收購 <b>${mk.limit()}</b> 筆（目前 ${mk.openCount('sell')}／${mk.openCount('buy')}）。💰 你的金錢：<b>${g.state.player.coins}</b></p>
    <p class="muted">刊登時物品（賣單）或金錢（收購）會先保管在市場上；其他玩家即時成交，對方不在線上也可以。成交的貨款或物品在你上線時自動收進倉庫。刊登 ${Math.round(LISTING_MS / 86400000)} 天後自動下架退還。</p>${tabs}`;
  if (view === 'mine') {
    const rows = mk.mine().map((m) => {
      const d = m.live || m;
      const what = m.item || m.bp ? escapeHtml(listingName(m)) : `${label(m.key)} ×${m.qty}`;
      const pending = (d.filled || 0) - (d.paid || 0);
      const left = Math.max(0, (m.at + LISTING_MS) - now);
      return `<div class="card row-between"><div><b>${m.side === 'sell' ? '📤 賣出' : '📥 收購'} ${what}</b>
        <small class="muted block">${m.item || m.bp ? `💰${m.price}` : `每個 💰${m.price}`}・已成交 ${d.filled || 0}/${m.qty}${pending > 0 ? `・待收取 ${pending}` : ''}${d.status === 'open' ? `・${formatDuration(left)}後下架` : '・已結束'}</small>
        ${(d.fills || []).slice(-3).map((f) => `<small class="block">🤝 ${escapeHtml(f.name)} ${m.side === 'sell' ? '買了' : '賣來'} ${f.n}</small>`).join('')}</div>
        <span>${pending > 0 ? btn('收取', 'exCollect', { id: m.id }, { cls: 'btn-xs btn-primary' }) : ''}${d.status === 'open' ? btn('下架', 'exCancel', { id: m.id }, { cls: 'btn-xs btn-ghost' }) : ''}</span></div>`;
    }).join('');
    return `${head}<div class="grid">${rows || '<p class="muted">目前沒有刊登。</p>'}</div>`;
  }
  if (view === 'post') {
    const side = form.side === 'buy' ? 'buy' : 'sell';
    const opt = (k, text) => `<option value="${k}" ${form.key === k ? 'selected' : ''}>${text}</option>`;
    const keys = (k) => (side === 'sell' ? have(g, k) > 0 : true);
    const opts = [
      `<optgroup label="基礎物資">${RESOURCE_KEYS.filter(keys).map((k) => opt(k, `${metaOf(k).icon} ${metaOf(k).name}${side === 'sell' ? `（${have(g, k)}）` : ''}`)).join('')}</optgroup>`,
      ...Object.entries(SUPPLY_CATS).map(([cat, c]) => `<optgroup label="${c.name}">${SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === cat && keys(k)).map((k) => opt(k, `${SUPPLIES[k].icon} ${SUPPLIES[k].name}${side === 'sell' ? `（${have(g, k)}）` : ''}`)).join('')}</optgroup>`),
      `<optgroup label="副本核心材料">${DG_CORE_KEYS.filter(keys).map((k) => opt(k, `${DG_CORES[k].icon} ${DG_CORES[k].name}${side === 'sell' ? `（${have(g, k)}）` : ''}`)).join('')}</optgroup>`,
    ].join('');
    const gear = side === 'sell' ? g.equipment.storeItems().filter((i) => !i.locked && !i.bound) : [];
    const full = mk.openCount(side) >= mk.limit();
    return `${head}
      <div class="chips"><button class="chip ${side === 'sell' ? 'active' : ''}" data-action="exSide" data-v="sell">📤 賣出</button><button class="chip ${side === 'buy' ? 'active' : ''}" data-action="exSide" data-v="buy">📥 收購</button></div>
      ${full ? `<p class="neg">${side === 'sell' ? '賣單' : '收購'}已達上限，升級交易所可增加。</p>` : ''}
      <div class="trade-row demand-form" data-side="${side}">
        <label>物品 <select class="d-key">${opts}</select></label>
        <label>數量 <input type="number" class="d-qty" min="1" max="${MAX_LISTING_QTY}" value="${form.qty ?? 10}" inputmode="numeric"></label>
        <label>單價 💰<input type="number" class="d-price" min="${side === 'buy' ? 1 : 0}" max="${MAX_LISTING_PRICE}" value="${form.price ?? 5}" inputmode="numeric"></label>
        ${btn(side === 'sell' ? '📤 刊登賣出' : '📥 刊登收購', 'exPost', {}, { cls: 'btn-sm btn-primary', disabled: full || ui.exBusy })}
      </div>
      <p class="muted">${side === 'sell' ? '賣出的物品會立即從倉庫移到市場保管。' : `收購總額（數量 × 單價）會立即從金錢扣除並保管。`}</p>
      ${side === 'sell' ? `<h4>刊登裝備</h4><div class="trade-row"><label>價格 💰<input type="number" class="d-gear-price" min="1" max="${MAX_LISTING_PRICE}" value="${form.gearPrice ?? 100}" inputmode="numeric"></label></div>
        <div class="grid">${gear.map((it) => itemCard(it, { compact: true, actions: btn('📤 刊登', 'exPostItem', { id: it.id }, { cls: 'btn-xs btn-primary', disabled: full || ui.exBusy }) })).join('') || '<p class="muted">倉庫裡沒有可刊登的裝備（上鎖與穿戴中的不能刊登）。</p>'}</div>
        <h4>📜 刊登設計圖</h4><div class="trade-row"><label>價格 💰<input type="number" class="d-bp-price" min="1" max="${MAX_LISTING_PRICE}" value="${form.bpPrice ?? 500}" inputmode="numeric"></label></div>
        <div class="grid">${g.state.inventory.blueprints.filter((bp) => g.equipment.blueprintInfo(bp)).map((bp) => {
    const info = g.equipment.blueprintInfo(bp);
    return `<div class="card row-between ${info.dungeon ? 'dg-bp' : ''}"><div><b>📜 <span style="color:${info.color}">${escapeHtml(info.name)}</span></b> <small style="color:${info.color}">${escapeHtml(info.label)}</small>
      <small class="muted block">黑市回收價 💰${g.blackMarket.blueprintBuyback(bp).toLocaleString()}</small></div>${btn('📤 刊登', 'exPostBp', { id: bp.id }, { cls: 'btn-xs btn-primary', disabled: full || ui.exBusy })}</div>`;
  }).join('') || '<p class="muted">沒有可刊登的設計圖。</p>'}</div>` : ''}`;
  }
  const list = mk.listings(now);
  const row = (d) => {
    // 自己的刊登：標「我的」，可以直接下架（不能自己買）
    if (d.mine) {
      const off = btn('下架', 'exCancel', { id: d.id }, { cls: 'btn-xs btn-ghost', disabled: ui.exBusy || !mk.state.mine[d.id] });
      const info = `<small class="muted block">👤 你${d.item ? `・💰${d.price}` : `・每個 💰${d.price}`}・剩 ${formatDuration(Math.max(0, (d.at || 0) + LISTING_MS - now))}</small>`;
      if (d.bp) return `<div class="mk-mine">${bpCard(g, d, `<span class="tag tag-amber">我的</span>${off}`)}</div>`;
      if (d.item) return `<div class="mk-mine">${itemCard(d.item, { compact: true, actions: `<span class="tag tag-amber">我的</span>${off}` })}</div>`;
      return `<div class="card row-between mk-mine"><div><b>${label(d.key)} ×${d.qty - d.filled}</b> <span class="tag tag-amber">我的</span>${info}</div><span class="trade-row">${off}</span></div>`;
    }
    const what = d.item || d.bp ? '' : `${label(d.key)} ×${d.qty - d.filled}`;
    const max = d.item || d.bp ? 1 : d.side === 'sell' ? Math.min(d.qty - d.filled, Math.floor(g.state.player.coins / Math.max(1, d.price))) : Math.min(d.qty - d.filled, have(g, d.key));
    const act = d.side === 'sell'
      ? `${d.item || d.bp ? '' : `<input type="number" class="mk-qty" data-id="${d.id}" min="1" max="${Math.max(1, max)}" value="${Math.max(1, Math.min(max, d.qty - d.filled))}" inputmode="numeric">`}${btn(d.item || d.bp ? `💰${d.price} 購買` : '購買', 'mkBuy', { id: d.id }, { cls: 'btn-xs btn-primary', disabled: max < 1 || ui.exBusy })}`
      : `<input type="number" class="mk-qty" data-id="${d.id}" min="1" max="${Math.max(1, max)}" value="${Math.max(1, max)}" inputmode="numeric">${btn('賣給他', 'mkSell', { id: d.id }, { cls: 'btn-xs btn-primary', disabled: max < 1 || ui.exBusy })}`;
    if (d.bp) return bpCard(g, d, `<small class="muted">👤 ${escapeHtml(d.ownerName)}</small>${act}`);
    if (d.item) return itemCard(d.item, { compact: true, actions: `<small class="muted">👤 ${escapeHtml(d.ownerName)}</small>${act}` });
    return `<div class="card row-between"><div><b>${what}</b>
      <small class="muted block">👤 ${escapeHtml(d.ownerName)}・每個 💰${d.price}${d.side === 'buy' ? `・你有 ${have(g, d.key)}` : ''}</small></div><span class="trade-row">${act}</span></div>`;
  };
  const sells = list.filter((d) => d.side === 'sell');
  const buys = list.filter((d) => d.side === 'buy');
  return `${head}${g.shared.online ? '' : '<p class="neg">目前未連線到伺服器，看不到其他玩家的刊登。</p>'}
    <div class="row-between"><span></span>${btn('🔄 重新整理', 'exRefresh', {}, { cls: 'btn-xs btn-ghost' })}</div>
    <h4>📤 出售中（${sells.length}）</h4><div class="grid">${sells.map(row).join('') || '<p class="muted">目前沒有人在賣東西。</p>'}</div>
    <h4>📥 收購中（${buys.length}）</h4><div class="grid">${buys.map(row).join('') || '<p class="muted">目前沒有人在收購。</p>'}</div>`;
}

/** 讀取刊登表單目前的值 */
export function exchangeForm(root, prev = {}) {
  const f = root?.querySelector('.demand-form');
  const gp = root?.querySelector('.d-gear-price');
  const bpp = root?.querySelector('.d-bp-price');
  if (!f) return prev;
  return {
    ...prev, key: f.querySelector('.d-key')?.value, qty: f.querySelector('.d-qty')?.value, price: f.querySelector('.d-price')?.value, gearPrice: gp?.value ?? prev.gearPrice, bpPrice: bpp?.value ?? prev.bpPrice,
  };
}

/** 交易所分頁的操作；回傳是否處理了 */
export function exchangeAction(ui, action, data, root, form, setForm) {
  const g = ui.game;
  const mk = g.market;
  const run = (p) => {
    ui.exBusy = true;
    p.then((r) => { ui.exBusy = false; ui.result(r); ui.refresh(true); });
  };
  const qtyOf = (id) => Number(root?.querySelector(`.mk-qty[data-id="${id}"]`)?.value) || 1;
  if (action === 'exRefresh') {
    mk.refresh().then(() => ui.refresh(true));
  } else if (action === 'exView') {
    setForm({ ...form, view: data.v });
    if (data.v === 'market') mk.refresh().then(() => ui.refresh(true));
  } else if (action === 'exSide') setForm({ ...exchangeForm(root, form), side: data.v, key: undefined });
  else if (ui.exBusy && ['exPost', 'exPostItem', 'exPostBp', 'mkBuy', 'mkSell', 'exCancel', 'exCollect'].includes(action)) return true;
  else if (action === 'exPost') {
    const f = exchangeForm(root, form);
    setForm(f);
    run(mk.post({
      side: form.side === 'buy' ? 'buy' : 'sell', key: f.key, qty: f.qty, price: f.price,
    }));
  } else if (action === 'exPostItem') {
    const f = exchangeForm(root, form);
    setForm(f);
    run(mk.post({ side: 'sell', itemId: data.id, price: f.gearPrice }));
  } else if (action === 'exPostBp') {
    const f = exchangeForm(root, form);
    setForm(f);
    run(mk.post({ side: 'sell', bpId: data.id, price: f.bpPrice }));
  } else if (action === 'mkBuy') run(mk.buy(data.id, qtyOf(data.id)));
  else if (action === 'mkSell') run(mk.sellTo(data.id, qtyOf(data.id)));
  else if (action === 'exCancel') {
    if (confirm('下架這筆刊登？未成交的部分會退還。')) run(mk.cancel(data.id));
  } else if (action === 'exCollect') run(mk.collect(data.id).then((r) => (r.ok ? { ok: true, msg: '已收取' } : r)));
  else return false;
  return true;
}
