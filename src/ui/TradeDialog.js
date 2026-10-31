import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, SUPPLY_KEYS, unitWeight } from '../config/supplies.js';
import { RARITY_ORDER, itemWeight } from '../config/equipment.js';
import { CLASSES } from '../config/survivors.js';
import { tripProgress } from '../systems/ExplorationSystem.js';
import { MAX_TRADE_GOODS, TRADE_STAY_MS } from '../systems/TradeSystem.js';
import { btn, itemCard, metaOf } from './components.js';

/**
 * 賣方：選一位倖存者、訂好要帶的商品數量與價格，派往對方據點擺攤。
 */
export function openTradeSetup(ui, player) {
  const g = ui.game;
  let svId = g.state.survivors.find((s) => g.survivors.isAvailable(s))?.id || null;
  const body = () => {
    const check = g.trade.canStart(player.id);
    const avail = g.state.survivors.filter((s) => g.survivors.isAvailable(s));
    const sv = g.survivors.get(svId);
    const picks = avail.map((s) => `<button class="chip ${s.id === svId ? 'active' : ''}" data-action="pickSv" data-id="${s.id}">${CLASSES[s.classId].icon} ${escapeHtml(s.name)} Lv${s.level}</button>`).join('');
    const res = g.state.resources;
    const sup = g.state.supplies || {};
    const keys = [...RESOURCE_KEYS.filter((k) => res[k] >= 1), ...SUPPLY_KEYS.filter((k) => sup[k] > 0)];
    const row = (k) => {
      const have = Math.floor(RESOURCE_KEYS.includes(k) ? res[k] : sup[k]);
      return `<div class="trade-row" data-key="${k}"><span class="trade-name">${metaOf(k).icon} ${metaOf(k).name} <small class="muted">有 ${have}・⚖️${unitWeight(k)}</small></span>
        <label>數量 <input type="number" class="t-qty" min="0" max="${have}" value="0" inputmode="numeric"></label>
        <label>單價 💰<input type="number" class="t-price" min="0" value="0" inputmode="numeric"></label></div>`;
    };
    const gear = g.equipment.storeItems().filter((i) => !i.locked)
      .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.power - a.power)
      .map((it) => `<div class="trade-row gear" data-item="${it.id}">${itemCard(it, { compact: true })}
        <label><input type="checkbox" class="t-pick"> 帶去賣</label>
        <label>價格 💰<input type="number" class="t-price" min="0" value="0" inputmode="numeric"></label><small class="muted">⚖️${itemWeight(it)}</small></div>`).join('');
    return `<p>🤝 派一位倖存者帶著商品到「<b>${escapeHtml(player.name)}</b>」的據點擺攤。對方只能用金錢購買（價格可以訂 0，等於免費贈送）。</p>
      <p class="muted">抵達後最多停留 ${formatDuration(TRADE_STAY_MS)}；對方可以結束交易，你也可以隨時從地圖或探索頁召回。賣出的金錢會在對方購買後送到你手上，沒賣完的商品會跟著倖存者回家。最多 ${MAX_TRADE_GOODS} 項商品。</p>
      ${check.ok ? '' : `<p class="neg">⚠️ ${escapeHtml(check.reason)}</p>`}
      <div class="label">派誰去</div><div class="chips">${picks || '<span class="muted">沒有可出發的倖存者</span>'}</div>
      ${sv ? `<p class="muted">🎒 ${escapeHtml(sv.name)} 背包 ${g.equipment.bagSlotsUsed(sv)}/${g.equipment.bagSlotCap(sv)} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))}/${g.survivors.bagCap(sv)}（可攜帶的數量受負重與格子限制）</p>` : ''}
      <h4>物資</h4><div class="trade-list">${keys.map(row).join('') || '<p class="muted">倉庫沒有物資。</p>'}</div>
      <h4>裝備</h4><div class="trade-list">${gear || '<p class="muted">倉庫沒有可交易的裝備（上鎖的不會列出）。</p>'}</div>
      <div class="btn-row">${btn('🚶 出發交易', 'go', {}, { cls: 'btn-primary', disabled: !check.ok || !sv })}</div>`;
  };
  ui.modal.open({
    title: `🤝 與 ${player.name} 交易`,
    wide: true,
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'pickSv') {
        svId = data.id;
        m.update(body());
        return;
      }
      if (action !== 'go') return;
      const goods = [];
      m.el.querySelectorAll('.trade-row').forEach((row) => {
        const price = Number(row.querySelector('.t-price')?.value) || 0;
        if (row.dataset.item) {
          if (row.querySelector('.t-pick')?.checked) goods.push({ itemId: row.dataset.item, price });
        } else {
          const qty = Math.floor(Number(row.querySelector('.t-qty')?.value) || 0);
          if (qty > 0) goods.push({ key: row.dataset.key, qty, price });
        }
      });
      if (goods.length > MAX_TRADE_GOODS) {
        ui.toastEl.show(`最多帶 ${MAX_TRADE_GOODS} 項商品`, 'danger');
        return;
      }
      const r = ui.result(g.trade.start(player.id, svId, goods));
      if (r.ok) {
        m.close();
        ui.panels.map?.renderMap?.(true);
      }
    },
  });
}

/**
 * 買方：在自己的據點選購對方交易隊的商品，或結束交易。
 */
export function openTradeStall(ui, playerId, tripId) {
  const g = ui.game;
  const body = () => {
    const c = g.trade.canTrade(playerId, tripId);
    const f = g.trade.find(playerId, tripId);
    if (!f) return '<p class="muted">交易隊已經離開了。</p>';
    const now = Date.now();
    const p = tripProgress(f.trip, now);
    const goods = (f.trip.stall || []).map((x) => {
      const left = g.trade.remaining(tripId, x);
      const price = x.price ? `💰${x.price}${x.item ? '' : ' / 個'}` : '🎁 免費';
      if (x.item) {
        const it = g.equipment.importItem(x.item);
        return it ? itemCard(it, {
          actions: left ? `<span class="tag">${price}</span>${btn(x.price ? '購買' : '收下', 'buy', { id: x.id, n: 1 }, { cls: 'btn-xs btn-primary', disabled: !c.ok || g.state.player.coins < x.price })}` : '<span class="tag">已售出</span>',
        }) : '';
      }
      const meta = SUPPLIES[x.key] || metaOf(x.key);
      return `<div class="card row-between" data-good="${x.id}"><div><b>${meta.icon} ${meta.name}</b> <small class="muted">剩 ${left}</small>
        <small class="muted block">${price}</small></div>
        ${left ? `<span class="trade-buy"><input type="number" class="t-qty" min="1" max="${left}" value="${Math.min(left, 1)}" inputmode="numeric">
          ${btn(x.price ? '購買' : '收下', 'buyQty', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !c.ok })}${btn('全部', 'buy', { id: x.id, n: left }, { cls: 'btn-xs btn-ghost', disabled: !c.ok || g.state.player.coins < x.price * left })}</span>` : '<span class="tag">已售出</span>'}</div>`;
    }).join('');
    return `<p>🤝 玩家「<b>${escapeHtml(f.player.name)}</b>」的交易隊${p.phase === 'searching' ? `正在你的據點擺攤・⏱ 約 ${formatDuration(p.phaseRemainingMs)}後離開` : '還在路上'}</p>
      <p>💰 你的金錢：<b>${g.state.player.coins}</b> <small class="muted">（只能用金錢購買；價格 0 等於對方免費贈送）</small></p>
      ${c.ok ? '' : `<p class="neg">⚠️ ${escapeHtml(c.reason)}</p>`}
      <div class="grid">${goods || '<p class="muted">對方沒有帶商品。</p>'}</div>
      <div class="btn-row">${btn('👋 結束交易', 'end', {}, { cls: 'btn-danger', disabled: !c.ok })}</div>
      <small class="muted">結束交易後對方的倖存者會回家；對方也可以自行召回。</small>`;
  };
  ui.modal.open({
    title: '🤝 交易',
    wide: true,
    body: body(),
    live: body,
    onAction: (action, data, m, el) => {
      if (action === 'buy') ui.result(g.trade.buy(playerId, tripId, data.id, Number(data.n) || 1));
      if (action === 'buyQty') {
        const n = Number(el.closest('[data-good]')?.querySelector('.t-qty')?.value) || 1;
        ui.result(g.trade.buy(playerId, tripId, data.id, n));
      }
      if (action === 'end') {
        if (!confirm('結束交易後對方的倖存者會回家，確定？')) return;
        if (ui.result(g.trade.end(playerId, tripId)).ok) {
          m.close();
          return;
        }
      }
      g.changed?.();
      m.update(body());
    },
  });
}
