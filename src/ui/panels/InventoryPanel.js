import { dgCraftHtml } from '../DungeonView.js';
import {
  SLOTS, ITEM_TYPES, RARITIES, RARITY_ORDER, ITEM_MODELS, benchFor, rarityIndex,
} from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, itemCard, costHtml, needHtml, progressBar, statRangeLine, affordable, metaOf,
} from '../components.js';
import { VEHICLES } from '../../config/vehicles.js';
import {
  SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS, AMMO_RECIPES, MED_RECIPES, AMMO_FOR, AMMO_RECOVER,
} from '../../config/supplies.js';
import { STACK_MAX } from '../../config/equipment.js';
import { DG_GEAR } from '../../config/dungeons.js';

/** 設計圖的裝備部位標籤（遠程武器另外標示槍種） */
function slotTag(type, slot = ITEM_TYPES[type]?.slot) {
  const sl = SLOTS[slot];
  if (!sl) return '';
  const sub = slot === 'weapon' && ITEM_TYPES[type] ? `・${ITEM_TYPES[type].name}` : '';
  return `<span class="slot-tag">${sl.icon} ${sl.name}${sub}</span>`;
}

/**
 * 製作分頁（裝備與載具製作）；倉庫裝備清單與車庫顯示在避難所頁的「倉庫」「車庫」分頁。
 */
export class InventoryPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.view = 'craft';
    this.filter = 'all';
    this.rarityFilter = 'all';
    this.sort = 'power';
    this.craftCat = 'melee';
  }

  /** 製作分頁：只有裝備製作與載具製作 */
  render() {
    const g = this.game;
    const eq = g.equipment;
    const view = ['vehicles', 'ammo', 'meds', 'blueprints', 'dgcraft'].includes(this.view) ? this.view : 'craft';
    if (!ITEM_TYPES[this.craftCat]) this.craftCat = Object.keys(ITEM_TYPES)[0];
    const bpN = g.state.inventory.blueprints.filter((bp) => g.equipment.blueprintInfo(bp)).length;
    const count = (type) => Object.values(ITEM_MODELS).filter((md) => md.type === type).length;
    // 分類選單：網頁版在左側直排，手機版改為上方分頁＋可左右滑動的類別
    const item = (v, cat, label, extra = '') => {
      const on = view === v && (!cat || this.craftCat === cat);
      return `<button class="sh-nav-item ${on ? 'active' : ''}" data-action="${cat ? 'craftCat' : 'view'}" data-${cat ? 'c' : 'v'}="${cat || v}" ${cat ? 'data-v="craft"' : ''}><span>${label}</span>${extra ? `<small>${extra}</small>` : ''}</button>`;
    };
    const nav = `<nav class="sh-nav craft-nav" aria-label="製作分類">
      <div class="sh-base"><b>🛠️ 工作台 Lv ${eq.workbench()}</b><small class="muted">製作技術 Lv ${eq.craftTech()}・倉庫 ${eq.storeUsed()}/${eq.storeCap()}</small></div>
      <div class="craft-kinds">${[['craft', '裝備'], ['ammo', '彈藥'], ['meds', '藥品'], ['vehicles', '載具'], ['blueprints', `設計圖${bpN ? ` ${bpN}` : ''}`], ['dgcraft', '✨ 副本裝備']].map(([v, l]) => `<button class="sv-tab ${view === v ? 'active' : ''}" data-action="view" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="sh-nav-list craft-cats ${view === 'craft' ? '' : 'desk-only'}">
        <small class="muted nav-label2">裝備</small>
        ${Object.entries(ITEM_TYPES).map(([id, t]) => item('craft', id, `${t.icon} ${t.name}`, count(id))).join('')}
        <i class="sh-nav-sep"></i>
        ${item('ammo', null, '🎯 彈藥與箭矢', Object.keys(AMMO_RECIPES).length)}
        ${item('meds', null, '💊 藥品', Object.keys(MED_RECIPES).length)}
        ${item('vehicles', null, '🚗 載具', Object.values(VEHICLES).filter((d) => d.craft).length)}
        ${item('blueprints', null, '📜 設計圖', bpN || '')}
        ${item('dgcraft', null, '✨ 副本裝備', g.state.inventory.blueprints.filter((b) => b.dg).length || '')}
      </div>
    </nav>`;
    const body = view === 'craft' ? this.renderCraft() : view === 'ammo' ? this.renderAmmoCraft() : view === 'meds' ? this.renderMedCraft() : view === 'vehicles' ? this.renderVehicleCraft() : view === 'dgcraft' ? `<div class="sh-fac"><div class="sh-fac-main"><h3 class="sh-title">✨ 副本裝備</h3>${dgCraftHtml(g)}</div></div>` : this.renderBlueprints();
    return `<div class="sh-layout craft-layout">${nav}<div class="sh-main">${body}</div></div>`;
  }

  /** 製作卡片的狀態：未解鎖／材料不足／可製作 */
  craftState(check, cost) {
    if (!check.ok) return 'lock';
    return affordable(this.game.state, cost) ? 'ok' : 'lack';
  }

  /** 製作按鈕 */
  craftBtn(state, label, action, data, reason = '') {
    if (state === 'lock') return `<span class="tag">🔒 ${escapeHtml(reason)}</span>`;
    if (state === 'lack') return btn('材料不足', action, data, { cls: 'btn-sm btn-lack', disabled: true });
    return btn(label, action, data, { cls: 'btn-sm btn-primary' });
  }

  /** 篩選：全部／可製作／材料不足／未解鎖 */
  filterChips() {
    const f = this.craftFilter || 'all';
    return `<div class="chips fac-filter">${[['all', '全部'], ['ok', '可製作'], ['lack', '材料不足'], ['lock', '未解鎖']].map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-action="craftFilter" data-f="${k}">${l}</button>`).join('')}</div>`;
  }

  passFilter(state) {
    const f = this.craftFilter || 'all';
    return f === 'all' || f === state;
  }

  /** 右側：製作品級機率與設計圖 */
  craftSide() {
    const g = this.game;
    const eq = g.equipment;
    const odds = Object.entries(eq.rarityOdds())
      .map(([r, p]) => `<div class="row-between"><span style="color:${RARITIES[r].color}">${RARITIES[r].name}</span><span>${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%</span></div>`).join('');
    const bps = g.state.inventory.blueprints.filter((bp) => ITEM_MODELS[bp.model] && !bp.dg);
    return `<aside class="sh-fac-side">
      <section class="sh-card"><h3>製作品級機率</h3>${odds}<small class="muted">研究「製作技術」可提高高品級機率（Lv${eq.craftTech()}/15）</small></section>
      <section class="sh-card sh-rates"><h3>設計圖 ${bps.length}</h3>${(() => {
        // v15.15：同型號、同保底品級合併（×數量）
        const groups = [];
        bps.forEach((bp) => { const hit = groups.find((x) => x.bp.model === bp.model && x.bp.rarity === bp.rarity); if (hit) hit.n += 1; else groups.push({ bp, n: 1 }); });
        const auto = g.blackMarket.bpAutoSell();
        return `${auto.r && auto.s ? `<small class="muted block bp-auto-sum">🔁 自動出售：<span style="color:${RARITIES[auto.r].color}">${RARITIES[auto.r].name}${auto.r === 'poor' ? '' : '以下'}</span>・${'★'.repeat(auto.s)}${auto.s > 1 ? ' 以下' : ''}</small>` : ''}${groups.slice(0, 6).map(({ bp, n }) => {
          const md = ITEM_MODELS[bp.model];
          const st = this.craftState(eq.canCraftModel(bp.model, true), eq.craftCost(bp.model, true));
          return `<div class="row-between bp-row"><span><b>${md.name}</b>${n > 1 ? ` <span class="bp-count">×${n}</span>` : ''}<small class="block" style="color:${RARITIES[bp.rarity].color}">保底${RARITIES[bp.rarity].name}</small></span>${this.craftBtn(st, '製作', 'craftBp', { id: bp.id, type: bp.model }, eq.canCraftModel(bp.model, true).reason)}</div>`;
        }).join('') || '<p class="muted">探索時有機會找到設計圖（製作時保底品級）。</p>'}${groups.length > 6 ? btn('查看全部', 'view', { v: 'blueprints' }, { cls: 'btn-xs' }) : ''}`;
      })()}</section>
    </aside>`;
  }

  /** 彈藥與箭矢製作：槍械需要彈藥、弓弩需要箭矢 */
  /**
   * 可批量製作的卡片（彈藥、藥品）：選批數、材料依批數相乘、不足時說明最多可做幾批。
   * @param {{effect:string, unit:string, tag?:string, highlight?:string[]}} o
   */
  batchCard(key, rc, o) {
    const g = this.game;
    const eq = g.equipment;
    const sp = SUPPLIES[key];
    const check = eq.canCraftAmmo(key);
    const n = eq.ammoBatch(key);
    const cost = eq.ammoCost(key, n);
    const { max, limit } = eq.ammoMaxBatches(key);
    const st = !check.ok ? 'lock' : n <= max ? 'ok' : 'lack';
    if (!this.passFilter(st)) return '';
    const qtyRow = check.ok ? `<div class="ammo-qty"><small class="muted">批數</small>
        <span class="ammo-step">${btn('−', 'ammoBatch', { key, n: n - 1 }, { disabled: n <= 1 })}<b>${n}</b>${btn('＋', 'ammoBatch', { key, n: n + 1 }, { disabled: n >= eq.constructor.AMMO_BATCH_MAX })}</span>
        ${[1, 5, 10].map((v) => `<button class="chip ${n === v ? 'active' : ''}" data-action="ammoBatch" data-key="${key}" data-n="${v}">×${v}</button>`).join('')}
        <button class="chip ${n === max && max > 1 ? 'active' : ''}" data-action="ammoBatch" data-key="${key}" data-n="${Math.max(1, max)}" ${max < 1 ? 'disabled' : ''}>最多 ×${max}</button></div>` : '';
    const lackName = limit === 'room' ? '倉庫空間' : metaOf(limit)?.name || '材料';
    const note = st === 'ok' ? `<small class="pos">一次製作 <b>${rc.batch * n}</b> ${o.unit}${n > 1 ? `（${n} 批）` : ''}</small>`
      : st === 'lack' ? `<small class="neg">${lackName}不足${max > 0 ? `：最多可做 ${max} 批` : ''}</small>` : '<span></span>';
    const label = n > 1 ? `製作 ×${n}` : '製作';
    return `<div class="fac-card2 ${st === 'lock' ? 'unbuilt' : ''}">
      <div class="fac2-head"><span class="fac-icon">${sp.icon}</span><b>${sp.name} ×${rc.batch}／批</b>${o.tag || ''}<span class="muted">倉庫 ${g.state.supplies?.[key] || 0}</span></div>
      <div class="fac2-effect"><small class="muted">${o.effect}</small></div>
      ${qtyRow}
      <div class="fac2-cost"><small class="muted">所需材料（擁有/需要${n > 1 ? ` ×${n} 批` : ''}）</small><div class="needs">${needHtml(g.state, cost, o.highlight || [])}</div>
        <div class="row-between">${note}${this.craftBtn(st, label, 'craftAmmo', { key }, check.reason)}</div></div>
    </div>`;
  }

  /** 彈藥與箭矢製作：槍械需要彈藥、弓弩需要箭矢 */
  renderAmmoCraft() {
    const users = (key) => Object.entries(AMMO_FOR).filter(([, a]) => a.ammo === key).map(([t]) => ITEM_TYPES[t].name).join('、');
    const cards = Object.entries(AMMO_RECIPES).map(([key, rc]) => this.batchCard(key, rc, {
      effect: `${key === 'casing' ? '子彈的主要材料（戰鬥後也會回收）' : `用於：${users(key)}`}・${rc.bench ? `工作台 Lv${rc.bench}` : '不需工作台'}`,
      unit: key === 'casing' ? '個' : '發',
    })).join('');
    const per = Object.entries(AMMO_FOR).map(([t, a]) => `${ITEM_TYPES[t].name} ${a.perFight}`).join('、');
    return `<div class="sh-fac"><div class="sh-fac-main">
      <h3 class="sh-title">🎯 彈藥與箭矢</h3>
      <details class="civ-more"><summary>說明</summary><p class="muted">槍械需要彈藥、弓弩需要箭矢；沒有彈藥時改用近戰武器。每場戰鬥消耗：${per}。子彈以彈殼製作：戰鬥勝利與屍潮防守後會回收約 ${Math.round(AMMO_RECOVER * 100)}% 的彈殼（箭矢直接回收），也能用廢鐵壓製，或在警察局、軍事基地、回收站找到。</p></details>
      ${this.filterChips()}
      <div class="fac-grid">${cards || '<p class="muted">沒有符合的項目。</p>'}</div>
    </div>${this.craftSide()}</div>`;
  }

  /** 藥品製作：依醫療站等級解鎖 */
  renderMedCraft() {
    const eq = this.game.equipment;
    const cards = Object.entries(MED_RECIPES).map(([key, rc]) => this.batchCard(key, rc, {
      effect: `醫療站 Lv${rc.clinic}`,
      unit: '個',
      tag: `<span class="heal-tag">回復 ${Math.round((SUPPLIES[key].heal || 0) * 100)}%</span>`,
      highlight: Object.keys(rc.cost).filter((k) => SUPPLIES[k]?.cat === 'med'),
    })).join('');
    return `<div class="sh-fac"><div class="sh-fac-main">
      <h3 class="sh-title">💊 藥品</h3>
      <small class="muted block">🏥 醫療站 Lv${eq.clinicLevel()}・等級越高可製作的藥品越好</small>
      <details class="civ-more"><summary>說明</summary><p class="muted">依醫療站等級解鎖：Lv1 紗布、繃帶／Lv3 維他命／Lv5 止痛藥／Lv7 抗生素／Lv9 小型醫藥箱／Lv12 中型醫藥箱。大型醫藥箱不能製作，只能探索取得。藍色標示的是當作材料的藥品，投入的回復量不超過做出來的 6 成，製作一定划算。</p></details>
      ${this.filterChips()}
      <div class="fac-grid">${cards || '<p class="muted">沒有符合的項目。</p>'}</div>
    </div>${this.craftSide()}</div>`;
  }


  /** 倉庫裝備（從避難所頁開啟） */
  openStorage() {
    this.sel = null;
    this.dropQty = 1;
    this.filter = 'all';
    const m = this.ui.modal.open({
      title: `🗄️ 物品倉庫（裝備 ${this.game.equipment.storeItems().length} 件）`,
      wide: true,
      body: this.renderItems(),
      live: () => this.renderItems(),
      onAction: (action, data, modal) => {
        const input = modal.el?.querySelector('#inv-drop-qty');
        if (input) this.dropQty = Number(input.value) || 1;
        this.onAction(action, data);
        if (this.ui.modal.current === modal) modal.update(this.renderItems());
        // 手機上詳細資訊在格子下方：選取後捲動到可見位置
        if (action === 'selSupply' || action === 'selItem') modal.el?.querySelector('.inv-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    });
    m.el?.addEventListener('input', (e) => { if (e.target.id === 'inv-drop-qty') this.dropQty = Number(e.target.value) || 1; });
  }

  /** 車庫（從避難所頁開啟） */
  openGarage() {
    this.ui.modal.open({
      title: `🚗 車庫 ${this.game.state.vehicles.length}/${this.game.vehicles.garageSize()}`,
      wide: true,
      body: this.renderGarage(),
      live: () => this.renderGarage(),
      onAction: (action, data, m) => {
        this.onAction(action, data);
        if (this.ui.modal.current === m) m.update(this.renderGarage());
      },
    });
  }

  /** 車庫：載具耐久、維修、拆解，以及工作台製作滑板車／腳踏車 */
  renderGarage() {
    const g = this.game;
    const vs = g.vehicles;
    const cards = g.state.vehicles.map((v) => {
      const def = VEHICLES[v.type];
      const max = vs.maxDurability(v);
      const ratio = v.durability / max;
      const cost = vs.repairCostOf(v);
      return `<div class="card vehicle-card ${vs.isBroken(v) ? 'broken' : ''}">
        <div class="row-between"><b>${def.icon} ${def.name}</b><span class="tag ${v.status === 'out' ? 'tag-blue' : v.status === 'reserved' ? 'tag-amber' : vs.isBroken(v) ? 'tag-red' : ''}">${v.status === 'out' ? '出勤中' : v.status === 'reserved' ? '🔒 已指定給臨時小隊' : vs.isBroken(v) ? '🔧 損壞' : '可出車'}</span></div>
        <small class="muted block">🪑 ${def.seats} 座・🏎️ 速度 ×${def.speed}・📦 運載 ${def.cargo}・⛽ ${def.fuelPerKm ? `${def.fuelPerKm}/公里` : '不耗油'}</small>
        ${progressBar(ratio, ratio < 0.3 ? 'danger' : '', `耐久 ${v.durability}/${max}`)}
        <div class="row-between">${Object.keys(cost).length ? `<div class="costs">${costHtml(g.state, cost)}</div>` : '<span></span>'}
          <span>${btn('🔧 維修', 'repair', { id: v.id }, {
    cls: 'btn-xs btn-primary',
    disabled: !Object.keys(cost).length || v.status !== 'idle' || !affordable(g.state, cost),
    title: !Object.keys(cost).length ? '耐久已滿' : v.status === 'reserved' ? '已指定給臨時小隊，無法維修' : v.status !== 'idle' ? '出勤中不能維修' : !affordable(g.state, cost) ? '材料不足' : '',
  })}${btn('拆解', 'scrap', { id: v.id }, { cls: 'btn-xs btn-ghost', disabled: v.status !== 'idle' })}</span></div>
      </div>`;
    }).join('');
    return `
      <p class="muted">🔧 維修：載具耐久會因行駛與遇襲下降，耐久歸零就不能出車。按「維修」會一次修到滿，需要的材料列在每台載具下方（缺少的會標紅），材料足夠時按鈕才會亮起；出勤中的載具不能維修。研究「維修技術」可降低維修費用。</p>
      <p class="muted">探索時可帶載具：所有隊員都有座位時全隊以載具速度移動；運載量讓隊伍帶回更多物資（每人徒步 ${g.vehicles.personCarry()}，背包可再增加）。每台至少一人駕駛，除滑板車與腳踏車外都會耗油，行駛與遇襲會磨損耐久。更多載具主要在探索修車廠時找到（需要維修），或到「製作」頁製作。</p>
      <div class="grid">${cards || '<p class="muted">車庫是空的。</p>'}</div>`;
  }

  /** 載具製作 */
  renderVehicleCraft() {
    const g = this.game;
    const vs = g.vehicles;
    const crafts = Object.entries(VEHICLES).filter(([, d]) => d.craft).map(([type, d]) => {
      const check = vs.canCraft(type);
      const st = check.ok ? 'ok' : affordable(g.state, d.craft.cost) ? 'lock' : 'lack';
      if (!this.passFilter(st)) return '';
      return `<div class="fac-card2 ${st === 'lock' ? 'unbuilt' : ''}">
        <div class="fac2-head"><span class="fac-icon">${d.icon}</span><b>${d.name}</b><span class="muted">工作台 Lv${d.craft.workbench}</span></div>
        <div class="fac2-effect"><small class="muted">🪑 ${d.seats} 人・速度 ×${d.speed}・運載 ${d.cargo}</small></div>
        <div class="fac2-cost"><small class="muted">所需材料（擁有/需要）</small><div class="needs">${needHtml(g.state, d.craft.cost)}</div>
          <div class="row-between"><small class="muted">${check.ok ? '' : escapeHtml(check.reason || '')}</small>${this.craftBtn(st, '製作', 'craftVehicle', { type }, check.reason)}</div></div>
      </div>`;
    }).join('');
    return `<div class="sh-fac"><div class="sh-fac-main">
      <h3 class="sh-title">🚗 載具 <small class="muted">車庫 ${g.state.vehicles.length}/${vs.garageSize()}（到避難所「車庫」管理、維修）</small></h3>
      ${this.filterChips()}
      <div class="fac-grid">${crafts || '<p class="muted">沒有符合的項目。</p>'}</div>
    </div>${this.craftSide()}</div>`;
  }

  /** 設計圖：製作時保底品級；可以出售（交易市場也能刊登） */
  renderBlueprints() {
    const g = this.game;
    const eq = g.equipment;
    // v15.15.1：×2 以上多一顆「全部出售」（單張價格 × 張數）
    const extra = (bp, list = [bp]) => `${btn(`出售 💰${g.blackMarket.blueprintBuyback(bp).toLocaleString()}`, 'bpSell', { id: bp.id }, { cls: 'btn-sm btn-ghost bp-sell' })}${list.length > 1
      ? btn(`全部 💰${list.reduce((t, b) => t + g.blackMarket.blueprintBuyback(b), 0).toLocaleString()}`, 'bpSellAll', { id: bp.id }, { cls: 'btn-sm btn-ghost bp-sell' }) : ''}`;
    // v15.15：同型號、同保底品級的設計圖合併成一張卡片（×數量）
    const groups = [];
    g.state.inventory.blueprints.forEach((bp) => {
      const key = `${bp.dg ? 'dg' : ''}:${bp.model}:${bp.rarity}`;
      const hit = groups.find((x) => x.key === key);
      if (hit) hit.list.push(bp); else groups.push({ key, list: [bp] });
    });
    const cards = groups.map(({ list }) => {
      const bp = list[0];
      const n = list.length > 1 ? `<span class="bp-count">×${list.length}</span>` : '';
      const info = eq.blueprintInfo(bp);
      if (!info) return '';
      if (info.dungeon) {
        const st = g.dungeon.canCraft(bp.model).ok ? 'ok' : 'short';
        if (!this.passFilter(st)) return '';
        return `<div class="fac-card2 dg-bp">
        <div class="fac2-head"><span class="fac-icon">📜</span><b class="dg-name">${escapeHtml(info.name)}</b>${n}${slotTag(null, DG_GEAR[bp.model]?.slot)}<span class="dg-tag">副本圖紙</span></div>
        <div class="stat-line muted">${escapeHtml(g.dungeon.gearLine(bp.model))}</div>
        <div class="row-between bp-acts"><span></span><span class="btn-row">${btn('製作', 'view', { v: 'dgcraft' }, { cls: 'btn-sm btn-primary' })}${extra(bp, list)}</span></div>
      </div>`;
      }
      const md = ITEM_MODELS[bp.model];
      const t = ITEM_TYPES[md.type];
      const check = eq.canCraftModel(bp.model, true);
      const cost = eq.craftCost(bp.model, true);
      const st = this.craftState(check, cost);
      if (!this.passFilter(st)) return '';
      const r = RARITIES[bp.rarity];
      const bench = benchFor(md);
      return `<div class="fac-card2 bp-card ${st === 'lock' ? 'unbuilt' : ''}" style="--rc:${r.color}">
        <div class="fac2-head"><span class="fac-icon">${md.icon || t.icon}</span><b>${md.name}</b><span class="tier">${'★'.repeat(Math.ceil(md.tier / 2))}</span>${n}<span class="bp-rarity">📜 保底${r.name}</span></div>
        <small class="muted bp-sub">${slotTag(md.type)} 強度 T${md.tier}・${bench ? `工作台 Lv${bench}` : '不需工作台'}・裝備 Lv${eq.craftLevel(bp.model)}</small>
        <div class="stat-line range">${statRangeLine(eq.craftStatRange(bp.model, bp.rarity))}</div>
        <div class="fac2-cost"><small class="muted">所需材料（擁有/需要）</small><div class="needs">${needHtml(g.state, cost)}</div>
          <div class="row-between bp-acts"><span></span><span class="btn-row">${this.craftBtn(st, '製作', 'craftBp', { id: bp.id, type: bp.model }, check.reason)}${extra(bp, list)}</span></div></div>
      </div>`;
    }).join('');
    return `<div class="sh-fac"><div class="sh-fac-main">
      <h3 class="sh-title">📜 設計圖</h3>
      ${this.filterChips()}
      ${this.bpAutoHtml()}
      <div class="fac-grid">${cards || '<p class="muted">沒有設計圖。探索時有機會找到，用設計圖製作時保底品級。</p>'}</div>
      <small class="muted">設計圖也可以在交易所的交易市場刊登，賣給其他玩家。</small>
    </div>${this.craftSide()}</div>`;
  }

  /** 設計圖自動出售：保底品級＋星級兩個下拉（預設不設定）與「一鍵出售」（v15.17） */
  bpAutoHtml() {
    const cfg = this.game.blackMarket.bpAutoSell();
    const rl = (r, i) => (i === 0 ? RARITIES[r].name : `${RARITIES[r].name}以下`);
    const ropts = `<option value="" ${!cfg.r ? 'selected' : ''}>不設定</option>${RARITY_ORDER.map((r, i) => `<option value="${r}" ${cfg.r === r ? 'selected' : ''}>${rl(r, i)}</option>`).join('')}`;
    const sopts = `<option value="" ${!cfg.s ? 'selected' : ''}>不設定</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${cfg.s === n ? 'selected' : ''}>${'★'.repeat(n)}${n > 1 ? ' 以下' : ''}</option>`).join('')}`;
    const on = !!(cfg.r && cfg.s);
    return `<div class="bp-auto"><b>🔁 自動出售</b>
      <label class="bp-dd">保底品級 <select class="keep-min bp-auto-sel" data-k="r" aria-label="自動出售的保底品級">${ropts}</select></label>
      <label class="bp-dd">星級 <select class="keep-min bp-auto-sel" data-k="s" aria-label="自動出售的星級">${sopts}</select></label>
      ${btn('一鍵出售', 'bpSellRule', {}, { cls: 'btn-sm btn-primary', disabled: !on, title: on ? '把現有符合兩個條件的設計圖一起賣掉' : '品級和星級都設定後才能使用' })}
      <small class="muted">品級和星級都設定後才會啟用：之後拿到的設計圖符合兩個條件就自動賣；按「一鍵出售」才會賣掉現有符合的設計圖（副本圖紙、交易所買來或撤回的不會賣）。</small></div>`;
  }

  /** 下拉選單變更：只記住設定（之後新拿到的設計圖適用），不賣任何東西 */
  afterRender(el) {
    if (this.boundEl === el) return;
    this.boundEl = el;
    el.addEventListener('change', (e) => {
      if (this.ui.tab !== 'inventory' || !e.target.classList?.contains('bp-auto-sel')) return;
      const g = this.game;
      const k = e.target.dataset.k;
      g.blackMarket.setBpAutoSell({ [k]: e.target.value ? (k === 's' ? Number(e.target.value) : e.target.value) : null });
      const cfg = g.blackMarket.bpAutoSell();
      this.ui.toastEl.show(cfg.r && cfg.s ? '🔁 已更新：之後拿到符合條件的設計圖會自動出售' : '品級和星級都設定後才會自動出售', 'info');
      g.changed?.();
      g.requestSave?.();
      this.ui.refresh(true);
    });
  }

  /** 丟棄設計圖前確認（可以改賣黑市） */
  confirmBpDiscard(id) {
    const g = this.game;
    const bp = g.state.inventory.blueprints.find((b) => b.id === id);
    const info = g.equipment.blueprintInfo(bp);
    if (!bp || !info) return;
    const price = g.blackMarket.blueprintBuyback(bp);
    this.ui.modal.open({
      title: '🗑️ 丟棄設計圖？',
      body: `<p>「${escapeHtml(info.name)}」${info.dungeon ? '副本圖紙' : '設計圖'}丟棄後無法復原。</p>
        <p class="muted">出售可以得到 💰${price.toLocaleString()}，或到交易市場賣給其他玩家。</p>
        <div class="btn-row end">${btn('取消', 'close', {}, { cls: 'btn-ghost' })}${btn('改為出售', 'bpSellNow', {}, { cls: '' })}${btn('確定丟棄', 'bpDropNow', {}, { cls: 'btn-danger' })}</div>`,
      onAction: (action, _d, m) => {
        if (action === 'bpSellNow') this.ui.result(g.blackMarket.sellBlueprint(id));
        else if (action === 'bpDropNow') this.ui.result(g.equipment.discardBlueprint(id));
        else return;
        m.close();
        g.changed?.();
        this.ui.refresh(true);
      },
    });
  }

  /** 倉庫頁顯示的裝備：不含隊員身上已裝備的物品 */
  storedItems() {
    const eq = this.game.equipment;
    return this.game.state.inventory.items.filter((i) => !eq.equippedBy(i.id));
  }

  /** 倉庫格子：材料依種類（零件→布料→藥品→彈藥）、階級排列，每 9999 個一格；裝備依部位、品級、戰力排列 */
  storeCells() {
    const g = this.game;
    const sup = g.state.supplies || {};
    const catOrder = Object.keys(SUPPLY_CATS);
    const cells = [];
    SUPPLY_KEYS.filter((k) => sup[k] > 0)
      .sort((a, b) => catOrder.indexOf(SUPPLIES[a].cat) - catOrder.indexOf(SUPPLIES[b].cat) || SUPPLIES[a].tier - SUPPLIES[b].tier || SUPPLY_KEYS.indexOf(a) - SUPPLY_KEYS.indexOf(b))
      .forEach((k) => {
        let left = sup[k];
        let i = 0;
        while (left > 0) {
          const n = Math.min(STACK_MAX, left);
          cells.push({ kind: 'supply', key: k, qty: n, cat: SUPPLIES[k].cat, idx: i });
          left -= n;
          i += 1;
        }
      });
    const slotOrder = Object.keys(SLOTS);
    g.equipment.storeItems()
      .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot) || rarityIndex(b.rarity) - rarityIndex(a.rarity) || b.power - a.power)
      .forEach((it) => cells.push({ kind: 'gear', item: it, cat: 'gear' }));
    return cells;
  }

  /** 選取的格子詳細資訊與操作（點選格子才顯示） */
  renderSelected() {
    const g = this.game;
    const sel = this.sel;
    if (!sel) return '<p class="muted inv-hint">👆 點選格子查看物品資訊，可以丟棄或交給隊員（出售請找流浪商人）。</p>';
    if (sel.kind === 'supply') {
      const sp = SUPPLIES[sel.key];
      const have = g.state.supplies?.[sel.key] || 0;
      if (!sp || have <= 0) { this.sel = null; return this.renderSelected(); }
      const qty = Math.min(have, Math.max(1, Math.floor(this.dropQty || 1)));
      return `<div class="card inv-detail">
        <div class="row-between"><b>${sp.icon} ${sp.name}</b><span class="muted">共 ${have} 個・佔 ${Math.ceil(have / STACK_MAX)} 格</span></div>
        <small class="muted block">${SUPPLY_CATS[sp.cat].icon} ${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier || 1)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}% 生命` : ''}</small>
        <div class="inv-drop">🗑️ 丟棄數量
          <input id="inv-drop-qty" type="number" min="1" max="${have}" value="${qty}" inputmode="numeric">
          ${btn('丟棄', 'dropSupply', { key: sel.key }, { cls: 'btn-sm btn-danger' })}
          ${btn(`全部丟棄（${have}）`, 'dropSupplyAll', { key: sel.key }, { cls: 'btn-sm btn-ghost' })}</div>
      </div>`;
    }
    const it = g.equipment.getItem(sel.id);
    if (!it || !g.equipment.storeItems().includes(it)) { this.sel = null; return this.renderSelected(); }
    const actions = [
      btn('裝備', 'equipTo', { id: it.id }, { cls: 'btn-xs btn-primary' }),
      btn('交給隊員', 'toBag', { id: it.id }, { cls: 'btn-xs' }),
      btn(it.locked ? '🔓 解鎖' : '🔒 上鎖', 'lock', { id: it.id }, { cls: 'btn-xs btn-ghost' }),
      btn('拆解', 'dismantle', { id: it.id }, { cls: 'btn-xs btn-ghost', disabled: it.locked }),
      btn('🗑️ 丟棄', 'dropItem', { id: it.id }, { cls: 'btn-xs btn-danger', disabled: it.locked }),
    ].join('');
    return `<div class="inv-detail">${itemCard(it, { actions, ammoWarn: this.game.equipment.ammoWarn(it) })}<small class="muted">💰 想換錢請在流浪商人出現時，到「回收」分頁賣給他。</small></div>`;
  }

  renderItems() {
    const g = this.game;
    const eq = g.equipment;
    const used = eq.storeUsed();
    const cap = eq.storeCap();
    const all = this.storeCells();
    const cats = [['all', '全部'], ...Object.entries(SUPPLY_CATS).map(([k, c]) => [k, `${c.icon}${c.name}`]), ['gear', '⚔️裝備']];
    const filters = cats.map(([k, n]) => `<button class="chip ${this.filter === k ? 'active' : ''}" data-action="filter" data-f="${k}">${n}</button>`).join('');
    if (!cats.some(([k]) => k === this.filter)) this.filter = 'all';
    const shown = this.filter === 'all' ? all : all.filter((c) => c.cat === this.filter);
    const qd = this.qd ? this.qdSel || (this.qdSel = new Set()) : null;
    // 快速拆解：清掉已經不在倉庫的選取
    if (qd) [...qd].forEach((id) => { if (!eq.storeItems().some((i) => i.id === id)) qd.delete(id); });
    const isSel = (c) => (qd ? c.kind === 'gear' && qd.has(c.item.id) : this.sel && (c.kind === 'supply' ? this.sel.kind === 'supply' && this.sel.key === c.key : this.sel.kind === 'gear' && this.sel.id === c.item.id));
    const cellHtml = shown.map((c) => {
      if (c.kind === 'supply') {
        if (qd) {
          const sp = SUPPLIES[c.key];
          return `<div class="inv-cell cat-${c.cat} qd-off"><span class="inv-ic">${sp.icon}</span><span class="inv-nm">${sp.name}</span><b class="inv-qty">${c.qty}</b></div>`;
        }
        const sp = SUPPLIES[c.key];
        return `<button class="inv-cell cat-${c.cat} ${isSel(c) ? 'sel' : ''}" data-action="selSupply" data-key="${c.key}" title="${sp.name} ×${c.qty}">
          <span class="inv-ic">${sp.icon}</span><span class="inv-nm">${sp.name}</span><b class="inv-qty">${c.qty}</b></button>`;
      }
      const it = c.item;
      const r = RARITIES[it.rarity];
      return `<button class="inv-cell gear r-${it.rarity} ${isSel(c) ? 'sel' : ''} ${qd && isSel(c) ? 'qd-sel' : ''} ${qd && it.locked ? 'qd-off' : ''}" style="--rc:${r.color}" data-action="${qd ? 'qdPick' : 'selItem'}" data-id="${it.id}" title="${escapeHtml(it.name)}" ${qd && it.locked ? 'disabled' : ''}>
        <span class="inv-ic">${ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔'}</span><span class="inv-nm">${escapeHtml(it.name)}</span>${it.locked ? '<i class="inv-lock">🔒</i>' : ''}<b class="inv-qty">Lv${it.level}</b></button>`;
    }).join('');
    const empty = this.filter === 'all' ? Math.max(0, cap - all.length) : 0;
    const carried = g.state.inventory.items.filter((i) => i.loc && i.loc !== 'store' && !eq.equippedBy(i.id)).length;
    return `
      <p>🗄️ 物品倉庫空間 <b class="${used >= cap ? 'neg' : ''}">${used} / ${cap}</b> 格 <small class="muted">（裝備每件 1 格；零件、布料、藥品、彈藥同種類每 ${STACK_MAX} 個 1 格；物品倉庫每升一級 +13 格，研究「物品倉儲」每級 +7 格。穿戴中與隊員背包裡的裝備不在這裡，請到倖存者頁查看${carried ? `，目前有 ${carried} 件在隊員背包` : ''}）</small></p>
      <div class="row-between"><div class="chips">${filters}</div>${qd ? btn('✕ 結束快速拆解', 'qdToggle', {}, { cls: 'btn-sm qd-on' }) : btn('🔨 快速拆解', 'qdToggle', {}, { cls: 'btn-sm', title: '一次選取多件裝備拆解' })}</div>
      ${qd ? this.qdRarityChips() : ''}
      <div class="inv-grid">${cellHtml}${'<div class="inv-cell empty"></div>'.repeat(empty)}</div>
      ${shown.length ? '' : '<p class="muted">這個分類沒有物品。</p>'}
      ${qd ? this.qdBar() : this.renderSelected()}`;
  }

  /** 快速拆解：依品級一次選取／取消（上鎖的不算） */
  qdRarityChips() {
    const eq = this.game.equipment;
    const items = eq.storeItems().filter((i) => !i.locked);
    const chips = RARITY_ORDER.map((rk) => {
      const list = items.filter((i) => i.rarity === rk);
      if (!list.length) return '';
      const all = list.every((i) => this.qdSel.has(i.id));
      return `<button class="chip qd-r ${all ? 'active' : ''}" style="--rc:${RARITIES[rk].color}" data-action="qdRarity" data-r="${rk}">${all ? '✓ ' : ''}${RARITIES[rk].name}（${list.length}）</button>`;
    }).join('');
    return `<div class="chips qd-chips">${chips || '<small class="muted">倉庫裡沒有可拆解的裝備</small>'}</div>
      <small class="muted block">點品級可一次選取／取消該品級全部裝備，也可以一件一件點；上鎖的裝備不能選</small>`;
  }

  /** 快速拆解：已選件數、預計回收與確認按鈕 */
  qdBar() {
    const eq = this.game.equipment;
    const ids = [...this.qdSel];
    const gain = eq.dismantlePreview(ids);
    const chips = Object.entries(gain).map(([k, v]) => `<span class="sr-chip">${metaOf(k).icon} ${metaOf(k).name} +${v}</span>`).join('');
    // v12.2：預計回收預設收合成一行（種類與總數），點一下展開材料清單
    const kinds = Object.keys(gain).length;
    const total = Object.values(gain).reduce((x, v) => x + v, 0);
    const sum = kinds ? `<button class="qd-sum" data-action="qdGain">預計回收 ${kinds} 種・共 ${total} 個 ${this.qdOpen ? '▴' : '▾'}</button>` : '<small class="muted">點選要拆解的裝備</small>';
    return `<div class="qd-bar">
      <div class="row-between"><b>🔨 已選 ${ids.length} 件</b>${sum}</div>
      ${kinds && this.qdOpen ? `<div class="sr-items qd-gain">${chips}</div>` : ''}
      <div class="row-between" style="margin-top:6px">${btn('清除選取', 'qdClear', {}, { cls: 'btn-sm btn-ghost', disabled: !ids.length })}${btn(`🔨 確認拆解 ${ids.length} 件`, 'qdConfirm', {}, { cls: 'btn-sm btn-danger', disabled: !ids.length })}</div>
    </div>`;
  }

  /** 快速拆解的確認視窗 */
  qdConfirm() {
    const g = this.game;
    const eq = g.equipment;
    const items = [...this.qdSel].map((id) => eq.getItem(id)).filter(Boolean);
    if (!items.length) return;
    const gain = eq.dismantlePreview(items.map((i) => i.id));
    const rows = items.map((it) => `<div class="sr-row"><span>${ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔'} <span style="color:${RARITIES[it.rarity].color}">${RARITIES[it.rarity].name}</span> ${escapeHtml(it.name)} Lv${it.level}</span><span class="muted">戰力 ${it.power}</span></div>`).join('');
    this.ui.modal.open({
      title: `🔨 確定拆解 ${items.length} 件裝備？`,
      body: `<div class="qd-list">${rows}</div>
        <p class="muted">預計回收：</p><div class="sr-items">${Object.entries(gain).map(([k, v]) => `<span class="sr-chip">${metaOf(k).icon} ${metaOf(k).name} +${v}</span>`).join('')}</div>
        <p class="warn-text">⚠️ 拆解後無法復原</p>
        <div class="btn-row end">${btn('取消', 'close', {}, { cls: 'btn-ghost' })}${btn('確認拆解', 'qdDo', {}, { cls: 'btn-danger' })}</div>`,
      onAction: (a, _d, m) => {
        if (a !== 'qdDo') return;
        m.close();
        const r = g.equipment.dismantleMany(items.map((i) => i.id));
        this.ui.result(r);
        if (r.ok) this.qdSel.clear();
        this.ui.refresh(true);
      },
    });
  }

  renderCraft() {
    const g = this.game;
    const st = g.state;
    const eq = g.equipment;
    const t = ITEM_TYPES[this.craftCat];
    // 手機版：類別改為可左右滑動的標籤
    const catChips = `<div class="chips craft-cat-chips mobile-only">${Object.entries(ITEM_TYPES).map(([id, it]) => `<button class="chip ${this.craftCat === id ? 'active' : ''}" data-action="craftCat" data-c="${id}">${it.icon} ${it.name}</button>`).join('')}</div>`;
    const models = Object.entries(ITEM_MODELS).filter(([, md]) => md.type === this.craftCat).sort((a, b) => a[1].tier - b[1].tier);
    const cards = models.map(([id, md]) => {
      const check = eq.canCraftModel(id);
      const cost = eq.craftCost(id);
      const s2 = this.craftState(check, cost);
      if (!this.passFilter(s2)) return '';
      const bench = benchFor(md);
      const extra = md.extra?.carry ? `・運載 +${md.extra.carry}` : md.fuel ? `・每場耗油 ${md.fuel}` : '';
      return `<div class="fac-card2 ${s2 === 'lock' ? 'unbuilt' : ''}">
        <div class="fac2-head"><span class="fac-icon">${md.icon || t.icon}</span><b>${md.name}</b><span class="tier">${'★'.repeat(Math.ceil(md.tier / 2))}</span></div>
        <small class="muted">強度 T${md.tier}・${bench ? `工作台 Lv${bench}` : '不需工作台'}・裝備 Lv${eq.craftLevel(id)}${extra}</small>
        <div class="stat-line range">${statRangeLine(eq.craftStatRange(id))}</div>
        <div class="fac2-cost"><small class="muted">所需材料（擁有/需要）</small><div class="needs">${needHtml(st, cost)}</div>
          <div class="row-between"><small class="muted">${s2 === 'lack' ? '材料不足' : ''}</small>${this.craftBtn(s2, '製作', 'craft', { type: id }, check.reason)}</div></div>
      </div>`;
    }).join('');
    return `<div class="sh-fac"><div class="sh-fac-main">
      ${catChips}
      <h3 class="sh-title">${t.icon} ${t.name}</h3>
      ${this.filterChips()}
      <div class="fac-grid">${cards || '<p class="muted">沒有符合的型號。</p>'}</div>
      <small class="muted">能力為製作出來的範圍（最低～最高，已含品級差異；另有依品級隨機出現的詞綴）。槍械另需研究「槍械製造」。空間不足時無法製作。</small>
    </div>${this.craftSide()}</div>`;
  }


  onAction(action, data) {
    const g = this.game;
    switch (action) {
      case 'view': this.view = data.v; break;
      case 'craftCat': this.craftCat = data.c; this.view = 'craft'; break;
      case 'craftFilter': this.craftFilter = data.f; break;
      case 'filter': this.filter = data.f; break;
      case 'selSupply':
        this.sel = this.sel?.kind === 'supply' && this.sel.key === data.key ? null : { kind: 'supply', key: data.key };
        this.dropQty = 1;
        break;
      case 'selItem': this.sel = this.sel?.kind === 'gear' && this.sel.id === data.id ? null : { kind: 'gear', id: data.id }; break;
      case 'qdToggle':
        this.qd = !this.qd;
        this.qdSel = new Set();
        this.sel = null;
        break;
      case 'qdPick': {
        const it = g.equipment.getItem(data.id);
        if (!it || it.locked) break;
        if (this.qdSel.has(data.id)) this.qdSel.delete(data.id);
        else this.qdSel.add(data.id);
        break;
      }
      case 'qdRarity': {
        const list = g.equipment.storeItems().filter((i) => !i.locked && i.rarity === data.r);
        const all = list.every((i) => this.qdSel.has(i.id));
        list.forEach((i) => (all ? this.qdSel.delete(i.id) : this.qdSel.add(i.id)));
        break;
      }
      case 'qdGain': this.qdOpen = !this.qdOpen; break;
      case 'qdClear': this.qdSel.clear(); break;
      case 'qdConfirm': this.qdConfirm(); break;
      case 'dropSupply': this.ui.result(g.equipment.discardSupply(data.key, this.dropQty)); break;
      case 'dropSupplyAll':
        if (confirm(`確定丟棄全部 ${SUPPLIES[data.key]?.name || ''}？丟棄後無法復原。`)) this.ui.result(g.equipment.discardSupply(data.key, Infinity));
        break;
      case 'dropItem': {
        const it = g.equipment.getItem(data.id);
        if (it && confirm(`確定丟棄「${it.name}」？丟棄後無法復原。`)) this.ui.result(g.equipment.discardItem(data.id));
        break;
      }
      case 'sort': this.sort = data.s; break;
      case 'rfilter': this.rarityFilter = data.r; break;
      case 'lock': g.equipment.toggleLock(data.id); break;
      case 'dismantle': this.ui.result(g.equipment.dismantle(data.id)); break;
      case 'craft': this.showCraftResult(g.equipment.craft(data.type)); break;
      case 'craftAmmo': this.ui.result(g.equipment.craftAmmo(data.key, g.equipment.ammoBatch(data.key))); break;
      case 'ammoBatch': g.equipment.setAmmoBatch(data.key, data.n); g.requestSave?.(); break;
      case 'craftBp': this.showCraftResult(g.equipment.craft(data.type, data.id)); break;
      case 'bpSell': {
        const bp = g.state.inventory.blueprints.find((b) => b.id === data.id);
        const info = g.equipment.blueprintInfo(bp);
        if (bp && confirm(`出售設計圖「${info?.name || ''}」，得到 💰${g.blackMarket.blueprintBuyback(bp).toLocaleString()}？`)) this.ui.result(g.blackMarket.sellBlueprint(data.id));
        break;
      }
      case 'bpSellAll': {
        // 同型號、同保底品級（副本圖紙另外分組）的設計圖一起賣
        const bp = g.state.inventory.blueprints.find((b) => b.id === data.id);
        if (!bp) break;
        const same = g.state.inventory.blueprints.filter((b) => !!b.dg === !!bp.dg && b.model === bp.model && b.rarity === bp.rarity);
        const coins = same.reduce((t, b) => t + g.blackMarket.blueprintBuyback(b), 0);
        const info = g.equipment.blueprintInfo(bp);
        if (confirm(`把 ${same.length} 張設計圖「${info?.name || ''}」一起賣掉，得到 💰${coins.toLocaleString()}？`)) this.ui.result(g.blackMarket.sellBlueprints(same.map((b) => b.id)));
        break;
      }
      case 'bpSellRule': {
        const bm = g.blackMarket;
        const list = bm.bpAutoTargets(bm.bpAutoSell(), false);
        if (!list.length) { this.ui.toastEl.show('目前沒有符合條件的設計圖', 'info'); break; }
        const coins = list.reduce((t, b) => t + bm.blueprintBuyback(b), 0);
        if (confirm(`依目前條件一鍵出售 ${list.length} 張設計圖，得到 💰${coins.toLocaleString()}？`)) this.ui.result(bm.sellBpByRule());
        break;
      }
      case 'bpDiscard': this.confirmBpDiscard(data.id); break;
      case 'dgCraft': {
        const r = g.dungeon.craft(data.id);
        this.ui.result(r);
        if (r.ok) this.ui.toastEl.show(`✨ ${r.msg}`, 'loot');
        break;
      }
      case 'equipTo': this.pickSurvivor(data.id); break;
      case 'toStore': this.ui.result(g.equipment.moveToStore(data.id)); break;
      case 'toBag': this.pickSurvivor(data.id, 'carry'); break;
      case 'repair': this.ui.result(g.vehicles.repair(data.id)); break;
      case 'scrap': if (confirm('確定拆解這台載具？會回收部分零件。')) this.ui.result(g.vehicles.scrap(data.id)); break;
      case 'craftVehicle': this.ui.result(g.vehicles.craft(data.type)); break;
      default: break;
    }
    this.ui.refresh(true);
  }

  showCraftResult(res) {
    this.ui.result(res);
    if (res.ok) this.ui.modal.open({ title: '🛠️ 製作完成', body: itemCard(res.item) });
  }

  /** 選擇倖存者：mode = equip（裝備）或 carry（放進背包攜帶） */
  pickSurvivor(itemId, mode = 'equip') {
    const g = this.game;
    const eq = g.equipment;
    const item = eq.getItem(itemId);
    const carry = mode === 'carry';
    const rows = g.state.survivors.map((sv) => {
      const cur = eq.getItem(sv.equipment[item.slot]);
      // v15.13：對這位倖存者的實際戰力變化（含職業技能、研究加成）
      const diff = eq.powerDelta(sv, item);
      const info = carry
        ? `<small class="muted">背包 ${eq.bagSlotsUsed(sv)}/${eq.bagSlotCap(sv)} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))}/${g.survivors.bagCap(sv)}</small>`
        : `<small class="muted">目前：${cur ? escapeHtml(cur.name) : '無'}</small><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`;
      return `<button class="pick-row" data-action="give" data-id="${sv.id}" ${sv.status === 'exploring' ? 'disabled' : ''}>
        <span>${g.survivors.classIcon(sv)} <b>${escapeHtml(sv.name)}</b> Lv${sv.level}</span>${info}
      </button>`;
    }).join('');
    this.ui.modal.open({
      title: carry ? `交給誰攜帶「${item.name}」？` : `裝備「${item.name}」給…`,
      body: `<div class="pick-list">${rows}</div>`,
      onAction: (action, data, m) => {
        if (action === 'give') {
          const r = this.ui.result(carry ? eq.moveToBag(itemId, data.id) : eq.equip(data.id, itemId));
          if (r.ok) m.close();
        }
      },
    });
  }
}
