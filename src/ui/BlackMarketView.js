import { SUPPLIES, SUPPLY_CATS } from '../config/supplies.js';
import { RARITIES, RARITY_ORDER } from '../config/equipment.js';
import { BLACK_MARKET, BM_VIP } from '../systems/BlackMarketSystem.js';
import { RESEARCH } from '../config/research.js';
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
    // 已售出的裝備沒有購買鈕，把「已被買走」放進卡片內，避免掉到格子外面
    if (x.kind === 'gear') return `<div class="${x.soldTo ? 'sold-out' : ''}">${itemCard(x.item, { actions: x.soldTo ? soldTag : buyBtn })}</div>`;
    const sp = SUPPLIES[x.key];
    const r = RARITIES[x.rarity];
    return `<div class="card row-between ${x.soldTo ? 'sold-out' : ''}"><div><b style="color:${r?.color || ''}">${sp.icon} ${sp.name} ×${x.qty}</b>
      <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫有 ${g.state.supplies?.[x.key] || 0}</small>${soldTag}</div>
      ${buyBtn}</div>`;
  }).join('');
  return `${head}${vipHtml(ui, now)}<h4>🕶️ 全服共用（${BLACK_MARKET.slots} 格・先搶先贏）</h4><div class="grid">${rows}</div>`;
}

/** 專屬保留區：只有自己看得到、只有自己能買；每小時補貨 1 格 */
function vipHtml(ui, now) {
  const g = ui.game;
  const bm = g.blackMarket;
  const slots = bm.updateVip(now);
  const count = bm.vipCount();
  const maxSlots = BM_VIP.baseSlots + (RESEARCH.t_bm_vip?.maxLevel || 4);
  const next = bm.nextVip();
  const t = new Date(next.at);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const cards = Array.from({ length: maxSlots }, (_, i) => {
    if (i >= count) return `<div class="card vip-lock"><b>🔒 第 ${i + 1} 格</b><small class="muted block">研究「${RESEARCH.t_bm_vip?.name || '黑市商人的厚愛'}」Lv${i}</small></div>`;
    const x = slots[i];
    if (!x) return '';
    const gd = x.good;
    const nextTag = i === next.slot ? '<span class="vip-next">下次補貨</span>' : '';
    const afford = g.state.player.coins >= gd.price;
    const action = x.sold ? '<small class="muted">✅ 已購買・等待補貨</small>' : btn(`💰${gd.price} 購買`, 'bmVipBuy', { i }, { cls: 'btn-xs btn-primary', disabled: !afford });
    if (gd.kind === 'gear') return `<div class="vip-card ${x.sold ? 'sold-out' : ''}">${nextTag}${itemCard(gd.item, { actions: action })}</div>`;
    const sp = SUPPLIES[gd.key];
    const r = RARITIES[gd.rarity];
    return `<div class="card row-between vip-card ${x.sold ? 'sold-out' : ''}">${nextTag}<div><b style="color:${r?.color || ''}">${sp.icon} ${sp.name} ×${gd.qty}</b>
      <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫有 ${g.state.supplies?.[gd.key] || 0}</small></div>${action}</div>`;
  }).join('');
  return `<section class="bm-vip"><div class="row-between"><h4>🎩 專屬保留區</h4><span class="vip-badge">只有你看得到・只有你能買</span></div>
    <p class="muted">每小時補貨 1 格・下次 <b>${hm}</b>（約 ${formatDuration(Math.max(0, next.at - now))}）更新第 ${next.slot + 1} 格・目前 ${count}/${maxSlots} 格</p>
    <div class="grid">${cards}</div></section>`;
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
  if (action === 'bmVipBuy') { ui.result(bm.buyVip(Number(data.i))); g.requestSave?.(); return true; }
  if (action === 'bmSell') { ui.result(bm.sell(data.key, Number(data.qty))); return true; }
  if (action === 'bmSellItem') { ui.result(bm.sellItem(data.id)); return true; }
  if (action === 'bmSellCommon') {
    if (confirm('確定賣出倉庫裡所有未上鎖的劣質與一般裝備？')) ui.result(bm.sellCommonGear());
    return true;
  }
  return false;
}
