import { SUPPLIES, SUPPLY_CATS } from '../config/supplies.js';
import { RARITIES, rarityIndex, ITEM_TYPES, ITEM_MODELS } from '../config/equipment.js';
import { BLACK_MARKET, EXCHANGE, RESOURCE_BUYBACK } from '../systems/BlackMarketSystem.js';
import { RESOURCES } from '../config/constants.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration, formatNumber } from '../utils/math.js';
import { LOCK_ITEM } from '../config/rebirth.js';
import { btn, itemCard } from './components.js';

/** 依階級與名稱排序（不依數量，賣出一部分後順序不會跳動） */
const supplyOrder = (a, b) => SUPPLIES[b].tier - SUPPLIES[a].tier || SUPPLIES[a].name.localeCompare(SUPPLIES[b].name, 'zh-Hant') || a.localeCompare(b);

/** v12.2.1 清單式一行：圖示、名稱、說明，右側動作 */
const bmRow = ({ icon, name, color, sub, right, cls = '' }) => `<div class="bm-row ${cls}"><span class="bm-ic">${icon}</span><span class="bm-nm"><b${color ? ` style="color:${color}"` : ''}>${name}</b><small>${sub}</small></span><span class="bm-act">${right}</span></div>`;

/** 裝備一行，點一下展開完整能力（和裝備卡片相同） */
const gearRow = (it, right, cls = '') => {
  const r = RARITIES[it.rarity] || RARITIES.common;
  const icon = ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔';
  return `<div class="bm-gear ${cls}" data-action="bmGearInfo" data-id="${it.id}">${bmRow({ icon, name: escapeHtml(it.name), color: r.color, sub: `${r.name} ${ITEM_TYPES[it.type]?.name || ''}${it.tier ? ` T${it.tier}` : ''}・Lv${it.level}・戰力 ${it.power}・ⓘ`, right })}</div>`;
};

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
  // 打開黑市：這一輪已經看過（導覽列的市場呼吸光停止）
  g.state.settings = g.state.settings || {};
  if (g.state.settings.bmSeenTick !== bm.tick(now)) {
    g.state.settings.bmSeenTick = bm.tick(now);
    ui.renderBadges?.();
  }
  const tab = (v, label) => `<button class="chip ${(view || 'buy') === v ? 'active' : ''}" data-action="bmView" data-v="${v}">${label}</button>`;
  const tabs = `<div class="chips">${tab('buy', '🛒 購買')}${tab('sell', '♻️ 出售')}${tab('ex', '🔄 交換')}${tab('sp', '✨ 特殊品')}</div>`;
  const boughtIds = bm.boughtIds(now);
  const bought = bm.boughtThisRound(now);
  const per = BLACK_MARKET.perRound;
  const t = new Date(next.at);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const quota = bought ? `<span class="bm-quota used">本輪已購買 ${per} / ${per} 件・下次換貨後可再買</span>` : `<span class="bm-quota">本輪已購買 ${boughtIds.length} / ${per} 件・還可以買 ${per - boughtIds.length} 件</span>`;
  const head = `<div class="bm-bar">🕶️ 所有倖存者共用的黑市：${BLACK_MARKET.slots} 項商品<b>每 ${Math.round(BLACK_MARKET.rotateMs / 60000)} 分鐘全部換新</b>・下次換貨 <b>${hm}</b>（約 ${formatDuration(Math.max(0, next.at - now))}）・先搶先贏，每輪每人限買 ${per} 件<br>${quota}</div>
    <p>💰 你的金錢：<b>${g.state.player.coins}</b>${g.shared.online ? '' : ' <small class="muted">（目前未連線：只有自己看得到購買紀錄）</small>'}</p>${tabs}`;
  if (view === 'ex') return `${head}${exchangeHtml(ui)}`;
  if (view === 'sp') return `${head}${specialHtml(ui)}`;
  if (view === 'sell') {
    const sup = g.state.supplies || {};
    const keys = Object.keys(sup).filter((k) => SUPPLIES[k] && sup[k] > 0).sort(supplyOrder);
    const sells = keys.map((k) => {
      const sp = SUPPLIES[k];
      const ten = Math.min(10, sup[k]);
      const unit = bm.buybackUnit(k);
      return bmRow({
        icon: sp.icon, name: `${sp.name} <small class="muted">倉庫 ${sup[k]}</small>`,
        sub: `${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}・每個 💰${unit.toFixed(unit < 1 ? 2 : 1)}`,
        right: `${btn(`賣 ${ten}（💰${bm.buybackPrice(k, ten)}）`, 'bmSell', { key: k, qty: ten }, { cls: 'btn-xs', disabled: bm.buybackPrice(k, ten) <= 0 })}${btn(`全賣（💰${bm.buybackPrice(k, sup[k])}）`, 'bmSell', { key: k, qty: sup[k] }, { cls: 'btn-xs btn-primary', disabled: bm.buybackPrice(k, sup[k]) <= 0 })}`,
      });
    }).join('');
    const gear = g.equipment.storeItems()
      .sort((a, b) => rarityIndex(b.rarity) - rarityIndex(a.rarity) || b.power - a.power || String(a.id).localeCompare(String(b.id)))
      .map((it) => gearRow(it, btn(`賣出 💰${bm.gearBuyback(it)}`, 'bmSellItem', { id: it.id }, { cls: 'btn-xs btn-primary', disabled: it.locked, title: it.locked ? '已上鎖' : '' }))).join('');
    // v15.11：基礎物資（食物、木材、燃料）：每種每天最多收購 RESOURCE_BUYBACK.dailyMax 個
    const res = Object.keys(RESOURCE_BUYBACK.price).map((k) => {
      const have = Math.floor(g.state.resources[k] || 0);
      const left = bm.resourceLeft(k);
      const can = Math.min(have, left);
      const per100 = bm.resourcePrice(k, 100);
      const b = (q, label, cls = 'btn-xs') => btn(`${label}（💰${bm.resourcePrice(k, Math.min(q, can))}）`, 'bmSellRes', { key: k, qty: q }, { cls, disabled: bm.resourcePrice(k, Math.min(q, can)) <= 0 });
      return bmRow({
        icon: RESOURCES[k].icon, name: `${RESOURCES[k].name} <small class="muted">倉庫 ${formatNumber(have)}</small>`,
        sub: `每 100 個 💰${per100}・今天還可賣 ${left.toLocaleString()} 個`,
        right: `${b(100, '賣 100')}${b(1000, '賣 1,000')}${b(can, `全賣 ${can.toLocaleString()}`, 'btn-xs btn-primary')}`,
        cls: 'bm-res',
      });
    }).join('');
    return `${head}<p class="muted">收購倉庫裡的物資、材料與裝備，越稀有回收比例越好。上鎖與穿戴中的裝備不會賣出。</p>
      <h4>基礎物資 <small class="muted">每種每天最多 ${RESOURCE_BUYBACK.dailyMax.toLocaleString()} 個</small></h4><div class="bm-list">${res}</div>
      <h4>材料</h4><div class="bm-list">${sells || '<p class="muted">倉庫裡沒有可以回收的物資。</p>'}</div>
      <div class="row-between"><h4>裝備</h4>${btn('一鍵賣出劣質/一般', 'bmSellCommon', {}, { cls: 'btn-sm btn-ghost' })}</div>
      <div class="bm-list">${gear || '<p class="muted">倉庫裡沒有裝備。</p>'}</div>`;
  }
  const rows = bm.shelf(now).map((x) => {
    const afford = g.state.player.coins >= x.price;
    const mine = boughtIds.includes(x.id);
    const soldTag = mine ? '<span class="bm-tag mine">✅ 你買了</span>' : x.soldTo ? `<span class="bm-tag">已被 ${escapeHtml(String(x.soldTo).slice(0, 8))} 買走</span>` : '';
    const buyBtn = x.soldTo || mine ? '' : bought ? btn('本輪已購買', 'bmBuy', { id: x.id }, { cls: 'btn-xs', disabled: true })
      : btn(`💰${x.price} 購買`, 'bmBuy', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !afford || ui.bmBusy === x.id });
    // 已售出的裝備沒有購買鈕，把「已被買走」放進卡片內，避免掉到格子外面
    const cls = mine ? 'bm-mine' : x.soldTo ? 'sold-out' : '';
    const right = x.soldTo || mine ? soldTag : buyBtn;
    // v12.2.1：清單式一行、照原本的順序打散排列（不分類別）；裝備點一下展開完整能力
    if (x.kind === 'gear') return gearRow(x.item, right, cls);
    const sp = SUPPLIES[x.key];
    const r = RARITIES[x.rarity];
    return bmRow({
      icon: sp.icon, name: `${sp.name} ×${x.qty}`, color: r?.color || '', cls,
      sub: `${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫 ${g.state.supplies?.[x.key] || 0}`,
      right,
    });
  }).join('');
  return `${head}<div class="bm-list">${rows}</div>`;
}

const exNum = (v) => (Number.isInteger(v) ? v : v.toFixed(1));

/** 換到 n 個需要給出幾個（無條件進位） */
export function exchangeNeed(g, f, n = f.get || 0) {
  if (!f.want || !f.give) return 0;
  return n > 0 ? Math.ceil(n * g.blackMarket.exchangeCostPer(f.give, f.want) - 1e-9) : 0;
}

/** 倉庫材料最多可以換到幾個 */
export function exchangeMax(g, f) {
  if (!f.want || !f.give) return 0;
  return Math.floor((g.state.supplies?.[f.give] || 0) / g.blackMarket.exchangeCostPer(f.give, f.want) + 1e-9);
}

/** 交換試算文字（數量輸入時即時更新）：輸入想換到幾個，自動算出要給出多少 */
export function exchangePreview(g, f) {
  if (!f.want || !f.give) return '<span class="muted">先選「想換到什麼」，再選「用什麼換」</span>';
  const per = g.blackMarket.exchangeCostPer(f.give, f.want);
  const gs = SUPPLIES[f.give];
  const ws = SUPPLIES[f.want];
  const cross = gs.tier < ws.tier;
  const have = g.state.supplies?.[f.give] || 0;
  const need = exchangeNeed(g, f);
  const short = need > have;
  return `<div class="bmx-need">需要給出 <b class="${short ? 'neg' : 'bmx-give'}">${gs.icon} ${gs.name} ×${need}</b>
      ${short ? `<span class="neg">（倉庫只有 ${have}）</span>` : `<small class="muted">（倉庫 ${have}${need ? `，交換後剩 ${have - need}` : ''}）</small>`}</div>
    <small class="muted block">每換 1 個${ws.name}要 ${exNum(per)} 個${gs.name}（價值 ${exNum(EXCHANGE.value[f.want])} ÷ ${exNum(EXCHANGE.value[f.give])} × ${EXCHANGE.rate}${cross ? ` × 跨階 ${EXCHANGE.crossMul}` : ''}）</small>`;
}

/** 交換按鈕能不能按 */
export function exchangeReady(g, f) {
  return !!(f.want && f.give && (f.get || 0) > 0 && exchangeNeed(g, f) <= (g.state.supplies?.[f.give] || 0));
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
  return `<p class="muted bmx-rule">用倉庫裡的零件或布料，換成同類別的其他材料。黑市抽成很重：<b class="bmx-rate">同價值 ${EXCHANGE.rate} 換 1</b>，用低一階的材料換再 ×${EXCHANGE.crossMul}。只能用同階或低一階的材料交換，${'★'.repeat(EXCHANGE.maxTier + 1)} 最高階不開放。</p>
    <h4>① 想換到什麼</h4>
    <div class="chips bmx-cats">${chip('bmExCat', 'part', '🔩 零件', f.cat === 'part')}${chip('bmExCat', 'fabric', '🧵 布料', f.cat === 'fabric')}
      ${[1, 2, 3, 4].map((t) => chip('bmExTier', t, `★${t}`, f.tier === t)).join('')}</div>
    <div class="bmx-grid">${wants.map((k) => cell(k, 'bmExWant', `want ${f.want === k ? 'on' : ''}`)).join('') || '<p class="muted">這一階沒有可以交換的材料。</p>'}</div>
    ${f.want ? `<h4>② 用什麼換 <small class="muted">（只列出 ${'★'.repeat(SUPPLIES[f.want].tier)}${SUPPLIES[f.want].tier > 1 ? ` 與 ${'★'.repeat(SUPPLIES[f.want].tier - 1)}` : ''} 的${SUPPLY_CATS[f.cat].name}，倉庫裡有的才會列出）</small></h4>
    <div class="bmx-grid">${giveList}</div>` : ''}
    ${f.want && f.give ? `<div class="bmx-sum">
      <div class="bmx-q">想換到 <b class="bmx-get">${SUPPLIES[f.want].icon} ${SUPPLIES[f.want].name}</b>
        <span class="bmx-qn">${btn('−1', 'bmExQty', { d: -1 }, { cls: 'btn-xs' })}<input type="number" min="0" step="1" data-role="bmExQty" value="${f.get || 0}">${btn('＋1', 'bmExQty', { d: 1 }, { cls: 'btn-xs' })}${btn('＋10', 'bmExQty', { d: 10 }, { cls: 'btn-xs' })}${btn(`最多（${exchangeMax(g, f)}）`, 'bmExQty', { max: 1 }, { cls: 'btn-xs' })}</span></div>
      <div class="bmx-preview">${exchangePreview(g, f)}</div>
      <div class="bmx-go">${btn('🔄 交換', 'bmExDo', {}, { cls: 'btn-primary', disabled: !exchangeReady(g, f) })}</div>
    </div>` : ''}`;
}

/** ✨ 特殊品：常駐販售、不佔每輪購買額度、每天限購（台灣時間 00:00 重置） */
function specialHtml(ui) {
  const g = ui.game;
  const rb = g.rebirth;
  const left = rb.bmLeft();
  const afford = g.state.player.coins >= LOCK_ITEM.bmPrice;
  return `<div class="card bm-sp-head">✨ <b>特殊品</b>：黑市商人私藏的稀有貨，<b>常駐販售</b>、不會隨每 ${Math.round(BLACK_MARKET.rotateMs / 60000)} 分鐘換貨下架，也<b>不佔每輪 ${BLACK_MARKET.perRound} 件</b>的購買額度。每天限購，台灣時間 00:00 重置。</div>
    <div class="bm-sp-item">
      <div class="bm-sp-ic">${LOCK_ITEM.icon}</div>
      <div class="bm-sp-mid"><b class="bm-sp-nm">${LOCK_ITEM.name}</b>
        <small class="muted block">在「脫胎換骨還你漂漂重生器」超渡倖存者時，鎖住 1 種素質不改變（每鎖 1 種消耗 1 個）・持有 ${rb.locks()}</small>
        <span class="bm-sp-lim">今日已買 ${rb.bmBoughtToday()} / ${LOCK_ITEM.bmDaily}</span></div>
      ${btn(`💰${formatNumber(LOCK_ITEM.bmPrice)} 購買`, 'bmSpBuy', {}, { cls: 'bm-sp-buy', disabled: !left || !afford, title: !left ? '今天已經買滿了' : !afford ? '金錢不足' : '' })}
    </div>
    <div class="bm-sp-item soon"><div class="bm-sp-ic">❔</div><div class="bm-sp-mid"><b class="muted">更多特殊品敬請期待</b><small class="muted block">之後新增的稀有道具也會放在這一區</small></div></div>`;
}

/** 購買特殊品的確認視窗（選擇數量） */
function openSpecialBuy(ui) {
  const g = ui.game;
  const rb = g.rebirth;
  const body = () => {
    const left = rb.bmLeft();
    const max = Math.min(left, Math.floor((g.state.player.coins || 0) / LOCK_ITEM.bmPrice));
    const opts = Array.from({ length: Math.max(0, max) }, (_, i) => i + 1)
      .map((n) => btn(`${n} 個（💰${formatNumber(n * LOCK_ITEM.bmPrice)}）`, 'spQty', { n }, { cls: 'btn-sm' })).join('');
    return `<p>${LOCK_ITEM.icon} <b>${LOCK_ITEM.name}</b>：每個 💰${formatNumber(LOCK_ITEM.bmPrice)}・今天還能買 ${left} 個・你的金錢 💰${formatNumber(g.state.player.coins)}</p>
      <div class="btn-row">${opts || '<span class="muted">金錢不足或今天已經買滿了</span>'}</div>`;
  };
  ui.modal.open({
    title: '✨ 購買特殊品',
    body: body(),
    onAction: (action, data, m) => {
      if (action !== 'spQty') return;
      ui.result(rb.buyLocks(Number(data.n)));
      m.close();
      ui.refresh(true);
    },
  });
}

/** 黑市分頁的操作；處理了回傳 true */
export function blackMarketAction(ui, action, data) {
  const g = ui.game;
  const bm = g.blackMarket;
  if (action === 'bmGearInfo') {
    // 點裝備那一行（不是按鈕）：彈出完整能力
    const it = bm.shelf(Date.now()).find((x) => x.kind === 'gear' && x.item.id === data.id)?.item || g.equipment.getItem(data.id);
    if (it) ui.modal.open({ title: it.name, body: itemCard(it) });
    return true;
  }
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
  if (action === 'bmSellRes') { ui.result(bm.sellResource(data.key, Number(data.qty))); return true; }
  if (action === 'bmSpBuy') { openSpecialBuy(ui); return true; }
  const f = ui.bmEx || (ui.bmEx = { cat: 'part', tier: 1, want: null, give: null, get: 0 });
  if (action === 'bmExCat') { f.cat = data.v; f.want = null; f.give = null; f.get = 0; return true; }
  if (action === 'bmExTier') { f.tier = Number(data.v); f.want = null; f.give = null; f.get = 0; return true; }
  if (action === 'bmExWant') { f.want = data.key; f.give = null; f.get = 0; return true; }
  if (action === 'bmExGive') {
    f.give = data.key;
    // 預設換 1 個（材料不夠時為 0）
    f.get = Math.min(1, exchangeMax(g, f));
    return true;
  }
  if (action === 'bmExQty') {
    const max = exchangeMax(g, f);
    f.get = data.max ? max : Math.max(0, Math.min(max, (f.get || 0) + Number(data.d || 0)));
    return true;
  }
  if (action === 'bmExDo') {
    if (!exchangeReady(g, f)) return true;
    const r = ui.result(bm.exchange(f.give, f.want, exchangeNeed(g, f)));
    if (r?.ok !== false) f.get = Math.min(f.get || 0, exchangeMax(g, f));
    return true;
  }
  if (action === 'bmSellItem') { ui.result(bm.sellItem(data.id)); return true; }
  if (action === 'bmSellCommon') {
    if (confirm('確定賣出倉庫裡所有未上鎖的劣質與一般裝備？')) ui.result(bm.sellCommonGear());
    return true;
  }
  return false;
}
