import { SUPPLIES, SUPPLY_CATS } from '../config/supplies.js';
import { RARITIES, RARITY_ORDER } from '../config/equipment.js';
import { BLACK_MARKET, EXCHANGE } from '../systems/BlackMarketSystem.js';
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
  const tab = (v, label) => `<button class="chip ${(view || 'buy') === v ? 'active' : ''}" data-action="bmView" data-v="${v}">${label}</button>`;
  const tabs = `<div class="chips">${tab('buy', '🛒 購買')}${tab('sell', '♻️ 出售')}${tab('ex', '🔄 交換')}</div>`;
  const boughtIds = bm.boughtIds(now);
  const bought = bm.boughtThisRound(now);
  const per = BLACK_MARKET.perRound;
  const t = new Date(next.at);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const quota = bought ? `<span class="bm-quota used">本輪已購買 ${per} / ${per} 件・下次換貨後可再買</span>` : `<span class="bm-quota">本輪已購買 ${boughtIds.length} / ${per} 件・還可以買 ${per - boughtIds.length} 件</span>`;
  const head = `<div class="bm-bar">🕶️ 所有倖存者共用的黑市：${BLACK_MARKET.slots} 項商品<b>每 ${Math.round(BLACK_MARKET.rotateMs / 60000)} 分鐘全部換新</b>・下次換貨 <b>${hm}</b>（約 ${formatDuration(Math.max(0, next.at - now))}）・先搶先贏，每輪每人限買 ${per} 件<br>${quota}</div>
    <p>💰 你的金錢：<b>${g.state.player.coins}</b>${g.shared.online ? '' : ' <small class="muted">（目前未連線：只有自己看得到購買紀錄）</small>'}</p>${tabs}`;
  if (view === 'ex') return `${head}${exchangeHtml(ui)}`;
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
    const mine = boughtIds.includes(x.id);
    const soldTag = mine ? '<small class="pos block">✅ 你買了這件</small>' : x.soldTo ? `<small class="muted block">✅ 已被 ${escapeHtml(x.soldTo)} 買走</small>` : '';
    const buyBtn = x.soldTo || mine ? '' : bought ? btn('本輪已購買', 'bmBuy', { id: x.id }, { cls: 'btn-xs', disabled: true })
      : btn(`💰${x.price} 購買`, 'bmBuy', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !afford || ui.bmBusy === x.id });
    // 已售出的裝備沒有購買鈕，把「已被買走」放進卡片內，避免掉到格子外面
    if (x.kind === 'gear') return `<div class="${mine ? 'bm-mine' : x.soldTo ? 'sold-out' : ''}">${itemCard(x.item, { actions: x.soldTo || mine ? soldTag : buyBtn })}</div>`;
    const sp = SUPPLIES[x.key];
    const r = RARITIES[x.rarity];
    return `<div class="card row-between ${mine ? 'bm-mine' : x.soldTo ? 'sold-out' : ''}"><div><b style="color:${r?.color || ''}">${sp.icon} ${sp.name} ×${x.qty}</b>
      <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫有 ${g.state.supplies?.[x.key] || 0}</small>${soldTag}</div>
      ${buyBtn}</div>`;
  }).join('');
  return `${head}<div class="grid">${rows}</div>`;
}

const exNum = (v) => (Number.isInteger(v) ? v : v.toFixed(1));

/** 交換試算文字（數量輸入時即時更新） */
export function exchangePreview(g, f) {
  if (!f.want || !f.give) return '<span class="muted">先選「想換到什麼」，再選「用什麼換」</span>';
  const q = g.blackMarket.exchangeQuote(f.give, f.want, f.qty || 0);
  const per = g.blackMarket.exchangeCostPer(f.give, f.want);
  const gs = SUPPLIES[f.give];
  const ws = SUPPLIES[f.want];
  const cross = gs.tier < ws.tier;
  return `<div class="bmx-flow"><span>給出 <b>${gs.icon} ${gs.name} ×${q.used || 0}</b></span><span class="bmx-arrow">➜</span><span>得到 <b class="bmx-get">${ws.icon} ${ws.name} ×${q.get || 0}</b></span></div>
    <small class="muted block">每換 1 個${ws.name}要 ${exNum(per)} 個${gs.name}（價值 ${exNum(EXCHANGE.value[f.want])} ÷ ${exNum(EXCHANGE.value[f.give])} × ${EXCHANGE.rate}${cross ? ` × 跨階 ${EXCHANGE.crossMul}` : ''}）・不到 1 個的部分不換${q.ok ? '' : `・<span class="neg">${escapeHtml(q.reason || '')}</span>`}</small>`;
}

/** 🔄 交換：用倉庫裡的零件或布料換成想要的材料 */
function exchangeHtml(ui) {
  const g = ui.game;
  const bm = g.blackMarket;
  const sup = g.state.supplies || {};
  const f = ui.bmEx || (ui.bmEx = { cat: 'part', tier: 1, want: null, give: null, qty: 0 });
  const chip = (act, val, label, on) => `<button class="chip ${on ? 'active' : ''}" data-action="${act}" data-v="${val}">${label}</button>`;
  const cell = (k, act, cls = '', disabled = false, note = '') => {
    const sp = SUPPLIES[k];
    return `<button class="bmx-it ${cls}" data-action="${act}" data-key="${k}" ${disabled ? 'disabled' : ''}><b>${sp.icon} ${sp.name}</b>
      <small><span class="bmx-st">${'★'.repeat(sp.tier)}</span> 倉庫 ${sup[k] || 0}・價值 ${exNum(EXCHANGE.value[k])}${note}</small></button>`;
  };
  // 固定順序（階級高的在前，再依價值、名稱），不依倉庫數量排序，交換後順序不會跳動；兩排的排法一致
  const exOrder = (a, b) => SUPPLIES[b].tier - SUPPLIES[a].tier || EXCHANGE.value[b] - EXCHANGE.value[a] || supplyOrder(a, b);
  const wants = Object.keys(EXCHANGE.value).filter((k) => bm.exchangeable(k) && SUPPLIES[k].cat === f.cat && SUPPLIES[k].tier === f.tier)
    .sort((a, b) => exOrder(a, b));
  const sources = f.want ? bm.exchangeSources(f.want).sort(exOrder) : [];
  // 只列出倉庫裡有的材料（沒有的不列，清單才不會太長）
  const giveList = sources.filter((k) => sup[k] > 0).map((k) => cell(k, 'bmExGive', `give ${f.give === k ? 'on' : ''}`)).join('')
    || '<p class="muted">倉庫裡沒有可以拿來換的材料。</p>';
  const maxQ = f.give ? (sup[f.give] || 0) : 0;
  return `<p class="muted bmx-rule">用倉庫裡的零件或布料，換成同類別的其他材料。黑市抽成很重：<b class="bmx-rate">同價值 ${EXCHANGE.rate} 換 1</b>，用低一階的材料換再 ×${EXCHANGE.crossMul}。只能用同階或低一階的材料交換，${'★'.repeat(EXCHANGE.maxTier + 1)} 最高階不開放。</p>
    <h4>① 想換到什麼</h4>
    <div class="chips bmx-cats">${chip('bmExCat', 'part', '🔩 零件', f.cat === 'part')}${chip('bmExCat', 'fabric', '🧵 布料', f.cat === 'fabric')}
      ${[1, 2, 3, 4].map((t) => chip('bmExTier', t, `★${t}`, f.tier === t)).join('')}</div>
    <div class="bmx-grid">${wants.map((k) => cell(k, 'bmExWant', `want ${f.want === k ? 'on' : ''}`)).join('') || '<p class="muted">這一階沒有可以交換的材料。</p>'}</div>
    ${f.want ? `<h4>② 用什麼換 <small class="muted">（只列出 ${'★'.repeat(SUPPLIES[f.want].tier)}${SUPPLIES[f.want].tier > 1 ? ` 與 ${'★'.repeat(SUPPLIES[f.want].tier - 1)}` : ''} 的${SUPPLY_CATS[f.cat].name}，倉庫裡有的才會列出）</small></h4>
    <div class="bmx-grid">${giveList}</div>` : ''}
    ${f.want && f.give ? `<div class="bmx-sum">
      <div class="bmx-preview">${exchangePreview(g, f)}</div>
      <div class="bmx-q">給出數量 ${btn('−10', 'bmExQty', { d: -10 }, { cls: 'btn-xs' })}<input type="number" min="0" max="${maxQ}" step="1" data-role="bmExQty" value="${f.qty || 0}">${btn('＋10', 'bmExQty', { d: 10 }, { cls: 'btn-xs' })}${btn('最多', 'bmExQty', { max: 1 }, { cls: 'btn-xs' })}</div>
      <div class="bmx-go">${btn('🔄 交換', 'bmExDo', {}, { cls: 'btn-primary' })}</div>
    </div>` : ''}`;
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
  const f = ui.bmEx || (ui.bmEx = { cat: 'part', tier: 1, want: null, give: null, qty: 0 });
  if (action === 'bmExCat') { f.cat = data.v; f.want = null; f.give = null; f.qty = 0; return true; }
  if (action === 'bmExTier') { f.tier = Number(data.v); f.want = null; f.give = null; f.qty = 0; return true; }
  if (action === 'bmExWant') { f.want = data.key; f.give = null; f.qty = 0; return true; }
  if (action === 'bmExGive') {
    f.give = data.key;
    // 預設帶入剛好換到 1 個的數量
    f.qty = Math.min(g.state.supplies?.[data.key] || 0, Math.ceil(bm.exchangeCostPer(data.key, f.want) - 1e-9));
    return true;
  }
  if (action === 'bmExQty') {
    const have = g.state.supplies?.[f.give] || 0;
    f.qty = data.max ? have : Math.max(0, Math.min(have, (f.qty || 0) + Number(data.d || 0)));
    return true;
  }
  if (action === 'bmExDo') {
    const r = ui.result(bm.exchange(f.give, f.want, f.qty || 0));
    if (r?.ok !== false) f.qty = Math.min(f.qty || 0, g.state.supplies?.[f.give] || 0);
    return true;
  }
  if (action === 'bmSellItem') { ui.result(bm.sellItem(data.id)); return true; }
  if (action === 'bmSellCommon') {
    if (confirm('確定賣出倉庫裡所有未上鎖的劣質與一般裝備？')) ui.result(bm.sellCommonGear());
    return true;
  }
  return false;
}
