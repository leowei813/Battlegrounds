import { SUPPLIES, SUPPLY_CATS } from '../config/supplies.js';
import { RARITIES, RARITY_ORDER } from '../config/equipment.js';
import { BLACK_MARKET } from '../systems/BlackMarketSystem.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { btn, itemCard } from './components.js';

/** 依階級與名稱排序（不依數量，賣出一部分後順序不會跳動） */
const supplyOrder = (a, b) => SUPPLIES[b].tier - SUPPLIES[a].tier || SUPPLIES[a].name.localeCompare(SUPPLIES[b].name, 'zh-Hant') || a.localeCompare(b);

/**
 * 黑市分頁（避難所頁）：全體玩家共用的 20 格商品＋回收。
 * @param {object} ui
 * @param {'buy'|'sell'} view
 */
export function blackMarketBody(ui, view = 'buy') {
  const g = ui.game;
  const bm = g.blackMarket;
  const now = Date.now();
  const next = bm.nextRotate(now);
  const tabs = `<div class="chips"><button class="chip ${view !== 'sell' ? 'active' : ''}" data-action="bmView" data-v="buy">🛒 購買</button><button class="chip ${view === 'sell' ? 'active' : ''}" data-action="bmView" data-v="sell">♻️ 出售</button></div>`;
  const head = `<p class="muted">🕶️ 所有倖存者共用的黑市：${BLACK_MARKET.slots} 項商品，每 10 分鐘換掉其中 1 項（下一次：第 ${next.slot + 1} 格，⏱ ${formatDuration(next.at - now)}後）。有人買走後其他人就買不到了。</p>
    <p>💰 你的金錢：<b>${g.state.player.coins}</b>${g.shared.online ? '' : ' <small class="muted">（目前未連線：只有自己看得到購買紀錄）</small>'}</p>${tabs}`;
  if (view === 'sell') {
    const sup = g.state.supplies || {};
    const keys = Object.keys(sup).filter((k) => SUPPLIES[k] && sup[k] > 0).sort(supplyOrder);
    const sells = keys.map((k) => {
      const sp = SUPPLIES[k];
      const ten = Math.min(10, sup[k]);
      const unit = bm.buybackUnit(k);
      return `<div class="card row-between"><div><b>${sp.icon} ${sp.name}</b> <small class="muted">倉庫 ${sup[k]}</small>
        <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}・回收價每個 💰${unit.toFixed(unit < 1 ? 2 : 1)}</small></div>
        <span>${btn(`賣 ${ten}（💰${bm.buybackPrice(k, ten)}）`, 'bmSell', { key: k, qty: ten }, { cls: 'btn-xs', disabled: bm.buybackPrice(k, ten) <= 0 })}${btn(`全賣（💰${bm.buybackPrice(k, sup[k])}）`, 'bmSell', { key: k, qty: sup[k] }, { cls: 'btn-xs btn-primary', disabled: bm.buybackPrice(k, sup[k]) <= 0 })}</span></div>`;
    }).join('');
    const gear = g.equipment.storeItems()
      .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.power - a.power || String(a.id).localeCompare(String(b.id)))
      .map((it) => itemCard(it, { compact: true, actions: btn(`賣出 💰${bm.gearBuyback(it)}`, 'bmSellItem', { id: it.id }, { cls: 'btn-xs btn-primary', disabled: it.locked, title: it.locked ? '已上鎖' : '' }) })).join('');
    return `${head}<p class="muted">收購倉庫裡的材料與裝備，越稀有回收比例越好。上鎖與穿戴中的裝備不會賣出。</p>
      <h4>材料</h4><div class="grid">${sells || '<p class="muted">倉庫裡沒有可以回收的物資。</p>'}</div>
      <div class="row-between"><h4>裝備</h4>${btn('一鍵賣出劣質/一般', 'bmSellCommon', {}, { cls: 'btn-sm btn-ghost' })}</div>
      <div class="grid">${gear || '<p class="muted">倉庫裡沒有裝備。</p>'}</div>`;
  }
  const rows = bm.shelf(now).map((x) => {
    const afford = g.state.player.coins >= x.price;
    const soldTag = x.soldTo ? `<small class="muted block">✅ 已被 ${escapeHtml(x.soldTo)} 買走</small>` : '';
    const buyBtn = x.soldTo ? '' : btn(`💰${x.price} 購買`, 'bmBuy', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !afford || ui.bmBusy === x.id });
    if (x.kind === 'gear') return `<div class="${x.soldTo ? 'sold-out' : ''}">${itemCard(x.item, { actions: buyBtn })}${soldTag}</div>`;
    const sp = SUPPLIES[x.key];
    const r = RARITIES[x.rarity];
    return `<div class="card row-between ${x.soldTo ? 'sold-out' : ''}"><div><b style="color:${r?.color || ''}">${sp.icon} ${sp.name} ×${x.qty}</b>
      <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫有 ${g.state.supplies?.[x.key] || 0}</small>${soldTag}</div>
      ${buyBtn}</div>`;
  }).join('');
  return `${head}<div class="grid">${rows}</div>`;
}

/** 黑市分頁的操作；處理了回傳 true */
export function blackMarketAction(ui, action, data) {
  const g = ui.game;
  const bm = g.blackMarket;
  if (action === 'bmView') {
    ui.bmView = data.v;
    if (data.v === 'buy') bm.refresh().then(() => ui.refresh(true));
    return true;
  }
  if (action === 'bmBuy') {
    if (ui.bmBusy) return true;
    ui.bmBusy = data.id;
    bm.buy(data.id).then((r) => { ui.bmBusy = null; ui.result(r); ui.refresh(true); });
    return true;
  }
  if (action === 'bmSell') { ui.result(bm.sell(data.key, Number(data.qty))); return true; }
  if (action === 'bmSellItem') { ui.result(bm.sellItem(data.id)); return true; }
  if (action === 'bmSellCommon') {
    if (confirm('確定賣出倉庫裡所有未上鎖的劣質與一般裝備？')) ui.result(bm.sellCommonGear());
    return true;
  }
  return false;
}
