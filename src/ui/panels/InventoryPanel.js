import {
  SLOTS, ITEM_TYPES, RARITIES, RARITY_ORDER, ITEM_MODELS, benchFor,
} from '../../config/equipment.js';
import { CLASSES } from '../../config/survivors.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, itemCard, costHtml, progressBar, statRangeLine,
} from '../components.js';
import { VEHICLES } from '../../config/vehicles.js';
import {
  SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS, AMMO_RECIPES, AMMO_FOR,
} from '../../config/supplies.js';
import { STACK_MAX } from '../../config/equipment.js';

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
    const view = ['vehicles', 'ammo'].includes(this.view) ? this.view : 'craft';
    const tabs = `<div class="seg">${btn('🛠️ 裝備製作', 'view', { v: 'craft' }, { cls: view === 'craft' ? 'active' : '' })}${btn('🎯 彈藥製作', 'view', { v: 'ammo' }, { cls: view === 'ammo' ? 'active' : '' })}${btn('🚗 載具製作', 'view', { v: 'vehicles' }, { cls: view === 'vehicles' ? 'active' : '' })}</div>`;
    const body = view === 'craft' ? this.renderCraft() : view === 'ammo' ? this.renderAmmoCraft() : this.renderVehicleCraft();
    return `<div class="panel-inner"><h2>🛠️ 製作</h2>${tabs}${body}</div>`;
  }

  /** 彈藥與箭矢製作：槍械需要彈藥、弓弩需要箭矢 */
  renderAmmoCraft() {
    const g = this.game;
    const eq = g.equipment;
    const users = (key) => Object.entries(AMMO_FOR).filter(([, a]) => a.ammo === key).map(([t]) => ITEM_TYPES[t].name).join('、');
    const cards = Object.entries(AMMO_RECIPES).map(([key, rc]) => {
      const sp = SUPPLIES[key];
      const check = eq.canCraftAmmo(key);
      return `<div class="card row-between"><div><b>${sp.icon} ${sp.name} ×${rc.batch}</b>
        <small class="muted block">用於：${users(key)}・${rc.bench ? `工作台 Lv${rc.bench}` : '不需工作台'}・倉庫有 ${g.state.supplies?.[key] || 0}</small>
        <div class="costs">${costHtml(g.state, rc.cost)}</div></div>
        ${check.ok ? btn('製作', 'craftAmmo', { key }, { cls: 'btn-sm btn-primary' }) : `<span class="tag tag-red">🔒 ${check.reason}</span>`}</div>`;
    }).join('');
    const per = Object.entries(AMMO_FOR).map(([t, a]) => `${ITEM_TYPES[t].name} ${a.perFight}`).join('、');
    return `<p class="muted">槍械需要彈藥、弓弩需要箭矢才能使用；沒有彈藥時只能徒手作戰。每場戰鬥消耗：${per}。出發探索時，使用槍械或弓弩的隊員會自動從倉庫補充約 4 場戰鬥的彈藥。彈藥也能在警察局、軍事基地、商店探索時找到。</p>
      <div class="grid">${cards}</div>`;
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
        <div class="row-between"><b>${def.icon} ${def.name}</b><span class="tag ${v.status === 'out' ? 'tag-blue' : vs.isBroken(v) ? 'tag-red' : ''}">${v.status === 'out' ? '出勤中' : vs.isBroken(v) ? '🔧 損壞' : '可出車'}</span></div>
        <small class="muted block">🪑 ${def.seats} 座・🏎️ 速度 ×${def.speed}・📦 運載 ${def.cargo}・⛽ ${def.fuelPerKm ? `${def.fuelPerKm}/公里` : '不耗油'}</small>
        ${progressBar(ratio, ratio < 0.3 ? 'danger' : '', `耐久 ${v.durability}/${max}`)}
        <div class="row-between">${Object.keys(cost).length ? `<div class="costs">${costHtml(g.state, cost)}</div>` : '<span></span>'}
          <span>${btn('🔧 維修', 'repair', { id: v.id }, { cls: 'btn-xs btn-primary', disabled: !Object.keys(cost).length || v.status !== 'idle' })}${btn('拆解', 'scrap', { id: v.id }, { cls: 'btn-xs btn-ghost', disabled: v.status !== 'idle' })}</span></div>
      </div>`;
    }).join('');
    return `
      <p class="muted">探索時可帶載具：所有隊員都有座位時全隊以載具速度移動；運載量讓隊伍帶回更多物資（每人徒步 ${g.vehicles.personCarry()}，背包可再增加）。每台至少一人駕駛，除滑板車與腳踏車外都會耗油，行駛與遇襲會磨損耐久。更多載具主要在探索修車廠時找到（需要維修），或到「製作」頁製作。</p>
      <div class="grid">${cards || '<p class="muted">車庫是空的。</p>'}</div>`;
  }

  /** 載具製作 */
  renderVehicleCraft() {
    const g = this.game;
    const vs = g.vehicles;
    const crafts = Object.entries(VEHICLES).filter(([, d]) => d.craft).map(([type, d]) => {
      const check = vs.canCraft(type);
      return `<div class="card row-between"><div><b>${d.icon} ${d.name}</b><small class="muted block">工作台 Lv${d.craft.workbench}・🪑${d.seats}・速度 ×${d.speed}・運載 ${d.cargo}</small><div class="costs">${costHtml(g.state, d.craft.cost)}</div></div>
        ${btn('製作', 'craftVehicle', { type }, { cls: 'btn-sm btn-primary', disabled: !check.ok, title: check.reason || '' })}</div>`;
    }).join('');
    return `<p class="muted">車庫 ${g.state.vehicles.length}/${vs.garageSize()}（到避難所頁「🚗 車庫」管理、維修載具）。其他載具只能在探索時找到。</p>
      <div class="grid">${crafts}</div>`;
  }

  /** 倉庫頁顯示的裝備：不含隊員身上已裝備的物品 */
  storedItems() {
    const eq = this.game.equipment;
    return this.game.state.inventory.items.filter((i) => !eq.equippedBy(i.id));
  }

  /** 倉庫格子：材料依種類（零件→布料→藥品→彈藥）、階級排列，每 999 個一格；裝備依部位、品級、戰力排列 */
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
      .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot) || RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.power - a.power)
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
    return `<div class="inv-detail">${itemCard(it, { actions })}<small class="muted">💰 想換錢請在流浪商人出現時，到「回收」分頁賣給他。</small></div>`;
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
    const isSel = (c) => this.sel && (c.kind === 'supply' ? this.sel.kind === 'supply' && this.sel.key === c.key : this.sel.kind === 'gear' && this.sel.id === c.item.id);
    const cellHtml = shown.map((c) => {
      if (c.kind === 'supply') {
        const sp = SUPPLIES[c.key];
        return `<button class="inv-cell cat-${c.cat} ${isSel(c) ? 'sel' : ''}" data-action="selSupply" data-key="${c.key}" title="${sp.name} ×${c.qty}">
          <span class="inv-ic">${sp.icon}</span><span class="inv-nm">${sp.name}</span><b class="inv-qty">${c.qty}</b></button>`;
      }
      const it = c.item;
      const r = RARITIES[it.rarity];
      return `<button class="inv-cell gear r-${it.rarity} ${isSel(c) ? 'sel' : ''}" style="--rc:${r.color}" data-action="selItem" data-id="${it.id}" title="${escapeHtml(it.name)}">
        <span class="inv-ic">${ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔'}</span><span class="inv-nm">${escapeHtml(it.name)}</span>${it.locked ? '<i class="inv-lock">🔒</i>' : ''}<b class="inv-qty">Lv${it.level}</b></button>`;
    }).join('');
    const empty = this.filter === 'all' ? Math.max(0, cap - all.length) : 0;
    const carried = g.state.inventory.items.filter((i) => i.loc && i.loc !== 'store' && !eq.equippedBy(i.id)).length;
    return `
      <p>🗄️ 物品倉庫空間 <b class="${used >= cap ? 'neg' : ''}">${used} / ${cap}</b> 格 <small class="muted">（裝備每件 1 格；零件、布料、藥品、彈藥同種類每 ${STACK_MAX} 個 1 格；物品倉庫每升一級 +10 格。穿戴中與隊員背包裡的裝備不在這裡，請到倖存者頁查看${carried ? `，目前有 ${carried} 件在隊員背包` : ''}）</small></p>
      <div class="chips">${filters}</div>
      <div class="inv-grid">${cellHtml}${'<div class="inv-cell empty"></div>'.repeat(empty)}</div>
      ${shown.length ? '' : '<p class="muted">這個分類沒有物品。</p>'}
      ${this.renderSelected()}`;
  }

  renderCraft() {
    const g = this.game;
    const st = g.state;
    const eq = g.equipment;
    const wb = eq.workbench();
    const cats = Object.entries(ITEM_TYPES).map(([id, t]) => `<button class="chip ${this.craftCat === id ? 'active' : ''}" data-action="craftCat" data-c="${id}">${t.icon} ${t.name}</button>`).join('');
    const models = Object.entries(ITEM_MODELS).filter(([, md]) => md.type === this.craftCat).sort((a, b) => a[1].tier - b[1].tier);
    const cards = models.map(([id, md]) => {
      const check = eq.canCraftModel(id);
      const bench = benchFor(md);
      const extra = md.extra?.carry ? `・📦 運載 +${md.extra.carry}` : md.fuel ? `・⛽ 每場戰鬥耗油 ${md.fuel}` : '';
      return `<div class="fac-card ${check.ok ? '' : 'locked'}">
        <div class="fac-head"><span class="fac-icon">${md.icon || ITEM_TYPES[md.type].icon}</span><div><b>${md.name}</b> <span class="tier">${'★'.repeat(Math.ceil(md.tier / 2))}</span>
          <small class="muted block">強度 T${md.tier}・${bench ? `工作台 Lv${bench}` : '簡易製作（不需工作台）'}・裝備等級 Lv${eq.craftLevel(id)}${extra}</small></div></div>
        <div class="stat-line range">${statRangeLine(eq.craftStatRange(id))}</div>
        <div class="row-between"><div class="costs">${costHtml(st, eq.craftCost(id))}</div>
        ${check.ok ? btn('製作', 'craft', { type: id }, { cls: 'btn-sm btn-primary' }) : `<span class="tag tag-red">🔒 ${check.reason}</span>`}</div>
      </div>`;
    }).join('');
    const bps = st.inventory.blueprints.filter((bp) => ITEM_MODELS[bp.model]).map((bp) => {
      const md = ITEM_MODELS[bp.model];
      const check = eq.canCraftModel(bp.model, true);
      return `<div class="card row-between">
        <div>📜 <b>${md.name}設計圖</b> <span class="rarity" style="--rc:${RARITIES[bp.rarity].color}">保底${RARITIES[bp.rarity].name}</span>
        <div class="stat-line range">${statRangeLine(eq.craftStatRange(bp.model, bp.rarity))}</div>
        <div class="costs">${costHtml(st, eq.craftCost(bp.model, true))}</div></div>
        ${btn('製作', 'craftBp', { id: bp.id, type: bp.model }, { cls: 'btn-sm btn-primary', disabled: !check.ok, title: check.reason || '' })}
      </div>`;
    }).join('');
    const odds = Object.entries(eq.rarityOdds())
      .map(([r, p]) => `<span class="odd" style="--rc:${RARITIES[r].color}">${RARITIES[r].name} ${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%</span>`).join('');
    return `
      <p>📦 倉庫空間 <b>${eq.storeUsed()} / ${eq.storeCap()}</b> 格（空間不足時無法製作）</p>
      <p class="muted">工作台 Lv${wb}：簡易製作不需要工作台；其餘裝備需要對應等級的工作台，工作台等級越高<b>可製作的型號越多</b>。槍械另需研究「槍械製造」。製作品級只受研究「製作技術」影響（Lv${eq.craftTech()}/15）。</p>
      <div class="odds"><small class="muted">製作品級機率：</small>${odds}</div>
      <p class="muted">每件裝備下方為製作出來的能力範圍（最低～最高，已含品級差異；另有依品級隨機出現的詞綴）。</p>
      ${bps ? `<h3>設計圖</h3>${bps}` : ''}
      <div class="chips">${cats}</div>
      <div class="grid">${cards}</div>`;
  }

  onAction(action, data) {
    const g = this.game;
    switch (action) {
      case 'view': this.view = data.v; break;
      case 'craftCat': this.craftCat = data.c; break;
      case 'filter': this.filter = data.f; break;
      case 'selSupply':
        this.sel = this.sel?.kind === 'supply' && this.sel.key === data.key ? null : { kind: 'supply', key: data.key };
        this.dropQty = 1;
        break;
      case 'selItem': this.sel = this.sel?.kind === 'gear' && this.sel.id === data.id ? null : { kind: 'gear', id: data.id }; break;
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
      case 'craftAmmo': this.ui.result(g.equipment.craftAmmo(data.key)); break;
      case 'craftBp': this.showCraftResult(g.equipment.craft(data.type, data.id)); break;
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
      const diff = item.power - (cur?.power || 0);
      const info = carry
        ? `<small class="muted">背包 ${eq.bagSlotsUsed(sv)}/${eq.bagSlotCap(sv)} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))}/${g.survivors.bagCap(sv)}</small>`
        : `<small class="muted">目前：${cur ? escapeHtml(cur.name) : '無'}</small><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`;
      return `<button class="pick-row" data-action="give" data-id="${sv.id}" ${sv.status === 'exploring' ? 'disabled' : ''}>
        <span>${CLASSES[sv.classId].icon} <b>${escapeHtml(sv.name)}</b> Lv${sv.level}</span>${info}
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
