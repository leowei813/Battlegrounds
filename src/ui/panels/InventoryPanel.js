import {
  SLOTS, ITEM_TYPES, RARITIES, RARITY_ORDER, ITEM_MODELS, benchFor,
} from '../../config/equipment.js';
import { CLASSES } from '../../config/survivors.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, itemCard, costHtml, progressBar,
} from '../components.js';
import { VEHICLES } from '../../config/vehicles.js';

/**
 * 製作分頁（裝備與載具製作）；倉庫裝備清單與車庫由避難所頁以彈窗開啟。
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
    const view = this.view === 'vehicles' ? 'vehicles' : 'craft';
    const tabs = `<div class="seg">${btn('🛠️ 裝備製作', 'view', { v: 'craft' }, { cls: view === 'craft' ? 'active' : '' })}${btn('🚗 載具製作', 'view', { v: 'vehicles' }, { cls: view === 'vehicles' ? 'active' : '' })}</div>`;
    return `<div class="panel-inner"><h2>🛠️ 製作</h2>${tabs}${view === 'craft' ? this.renderCraft() : this.renderVehicleCraft()}</div>`;
  }

  /** 倉庫裝備（從避難所頁開啟） */
  openStorage() {
    this.ui.modal.open({
      title: `📦 倉庫裝備（${this.game.state.inventory.items.length} 件）`,
      wide: true,
      body: this.renderItems(),
      live: () => this.renderItems(),
      onAction: (action, data, m) => {
        this.onAction(action, data);
        if (this.ui.modal.current === m) m.update(this.renderItems());
      },
    });
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
      <p class="muted">探索時可帶載具：所有隊員都有座位時全隊以載具速度移動；運載量讓隊伍帶回更多物資（每人徒步 ${g.vehicles.personCarry()}，背包可再增加）。每台至少一人駕駛，除滑板車與腳踏車外都會耗油，行駛與遇襲會磨損耐久。更多載具可在探索加油站、倉庫、工廠等地點時找到，或到「製作」頁製作。</p>
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

  renderItems() {
    const g = this.game;
    let items = [...g.state.inventory.items];
    if (this.filter !== 'all') items = items.filter((i) => i.slot === this.filter);
    if (this.rarityFilter !== 'all') items = items.filter((i) => i.rarity === this.rarityFilter);
    items.sort(this.sort === 'power'
      ? (a, b) => b.power - a.power
      : (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.power - a.power);
    const filters = [['all', '全部'], ...Object.entries(SLOTS).map(([k, v]) => [k, `${v.icon}${v.name}`])]
      .map(([k, n]) => `<button class="chip ${this.filter === k ? 'active' : ''}" data-action="filter" data-f="${k}">${n}</button>`).join('');
    const eq = g.equipment;
    const cards = items.map((it) => {
      const owner = eq.equippedBy(it.id);
      const carrier = it.loc && it.loc !== 'store' ? g.survivors.get(it.loc) : null;
      const actions = [
        btn('裝備', 'equipTo', { id: it.id }, { cls: 'btn-xs btn-primary' }),
        carrier && !owner ? btn('放回倉庫', 'toStore', { id: it.id }, { cls: 'btn-xs' }) : '',
        !carrier && !owner ? btn('交給隊員', 'toBag', { id: it.id }, { cls: 'btn-xs' }) : '',
        btn(it.locked ? '🔓' : '🔒', 'lock', { id: it.id }, { cls: 'btn-xs btn-ghost', title: '上鎖' }),
        btn(`出售 💰${g.equipment.sellValue(it)}`, 'sell', { id: it.id }, { cls: 'btn-xs', disabled: !!owner || it.locked }),
        btn('拆解', 'dismantle', { id: it.id }, { cls: 'btn-xs btn-ghost', disabled: !!owner || it.locked }),
      ].join('');
      return itemCard(it, { equippedBy: owner, carrier: owner ? null : carrier, actions });
    }).join('');
    const used = eq.storeUsed();
    const cap = eq.storeCap();
    const counts = {};
    g.state.inventory.items.forEach((i) => { counts[i.rarity] = (counts[i.rarity] || 0) + 1; });
    const rarities = [['all', '全部品級', '#fff'], ...RARITY_ORDER.map((r) => [r, `${RARITIES[r].name} ${counts[r] || 0}`, RARITIES[r].color])]
      .map(([k, n, c]) => `<button class="chip rchip ${this.rarityFilter === k ? 'active' : ''}" style="--rc:${c}" data-action="rfilter" data-r="${k}">${n}</button>`).join('');
    return `
      <p>📦 倉庫空間 <b class="${used >= cap ? 'neg' : ''}">${used} / ${cap}</b> 格 <small class="muted">（物品依大小佔格子；倉庫每升一級 +10 格，研究「倉儲擴建」再增加；穿戴中的裝備不佔格子）</small></p>
      <div class="chips">${filters}</div>
      <div class="chips">${rarities}</div>
      <div class="row-between"><div class="chips">
        <button class="chip ${this.sort === 'power' ? 'active' : ''}" data-action="sort" data-s="power">依戰力</button>
        <button class="chip ${this.sort === 'rarity' ? 'active' : ''}" data-action="sort" data-s="rarity">依品質</button></div>
        ${btn('一鍵出售劣質/一般', 'sellCommon', {}, { cls: 'btn-sm btn-ghost' })}</div>
      <div class="grid">${cards || '<p class="muted">沒有裝備。去探索或擊殺殭屍吧！</p>'}</div>`;
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
        <div class="row-between"><div class="costs">${costHtml(st, eq.craftCost(id))}</div>
        ${check.ok ? btn('製作', 'craft', { type: id }, { cls: 'btn-sm btn-primary' }) : `<span class="tag tag-red">🔒 ${check.reason}</span>`}</div>
      </div>`;
    }).join('');
    const bps = st.inventory.blueprints.filter((bp) => ITEM_MODELS[bp.model]).map((bp) => {
      const md = ITEM_MODELS[bp.model];
      const check = eq.canCraftModel(bp.model, true);
      return `<div class="card row-between">
        <div>📜 <b>${md.name}設計圖</b> <span class="rarity" style="--rc:${RARITIES[bp.rarity].color}">保底${RARITIES[bp.rarity].name}</span>
        <div class="costs">${costHtml(st, eq.craftCost(bp.model, true))}</div></div>
        ${btn('製作', 'craftBp', { id: bp.id, type: bp.model }, { cls: 'btn-sm btn-primary', disabled: !check.ok, title: check.reason || '' })}
      </div>`;
    }).join('');
    const odds = Object.entries(eq.rarityOdds())
      .map(([r, p]) => `<span class="odd" style="--rc:${RARITIES[r].color}">${RARITIES[r].name} ${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%</span>`).join('');
    return `
      <p>📦 倉庫空間 <b>${eq.storeUsed()} / ${eq.storeCap()}</b> 格（空間不足時無法製作）</p>
      <p class="muted">工作台 Lv${wb}：簡易製作不需要工作台；其餘裝備需要對應等級的工作台，工作台等級越高<b>可製作的型號越多</b>。槍械另需研究「槍械製造」。製作品級只受研究「製作技術」影響（Lv${eq.craftTech()}/10）。</p>
      <div class="odds"><small class="muted">製作品級機率：</small>${odds}</div>
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
      case 'sort': this.sort = data.s; break;
      case 'rfilter': this.rarityFilter = data.r; break;
      case 'lock': g.equipment.toggleLock(data.id); break;
      case 'sell': this.ui.result(g.equipment.sell(data.id)); break;
      case 'dismantle': this.ui.result(g.equipment.dismantle(data.id)); break;
      case 'sellCommon': {
        const ids = g.state.inventory.items.filter((i) => (i.rarity === 'poor' || i.rarity === 'common') && !i.locked && !g.equipment.equippedBy(i.id)).map((i) => i.id);
        let coins = 0;
        ids.forEach((id) => { coins += g.equipment.sellValue(g.equipment.getItem(id)); g.equipment.sell(id); });
        this.ui.result({ ok: true, msg: ids.length ? `出售 ${ids.length} 件，獲得 ${coins} 金錢` : '沒有可出售的劣質/一般裝備' });
        break;
      }
      case 'craft': this.showCraftResult(g.equipment.craft(data.type)); break;
      case 'craftBp': this.showCraftResult(g.equipment.craft(data.type, data.id)); break;
      case 'equipTo': this.pickSurvivor(data.id); break;
      case 'toStore': this.ui.result(g.equipment.moveToStore(data.id)); break;
      case 'toBag': this.pickSurvivor(data.id, 'carry'); break;
      case 'repair': this.ui.result(g.vehicles.repair(data.id)); break;
      case 'scrap': if (confirm('確定拆解這台載具？會回收部分金屬。')) this.ui.result(g.vehicles.scrap(data.id)); break;
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
