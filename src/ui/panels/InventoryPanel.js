import {
  SLOTS, ITEM_TYPES, RARITIES, RARITY_ORDER,
} from '../../config/equipment.js';
import { RESEARCH } from '../../config/research.js';
import { CLASSES } from '../../config/survivors.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, itemCard, costHtml, progressBar,
} from '../components.js';
import { VEHICLES, GARAGE_SIZE, PERSON_CARRY } from '../../config/vehicles.js';

/**
 * 背包分頁：裝備篩選/排序、裝備給隊員、出售、拆解、上鎖，以及工作台製作。
 */
export class InventoryPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.view = 'items';
    this.filter = 'all';
    this.rarityFilter = 'all';
    this.sort = 'power';
  }

  render() {
    const tabs = `<div class="seg">${btn('🎒 裝備', 'view', { v: 'items' }, { cls: this.view === 'items' ? 'active' : '' })}${btn('🛠️ 製作', 'view', { v: 'craft' }, { cls: this.view === 'craft' ? 'active' : '' })}${btn(`🚗 車庫 ${this.game.state.vehicles.length}/${GARAGE_SIZE}`, 'view', { v: 'garage' }, { cls: this.view === 'garage' ? 'active' : '' })}</div>`;
    const body = { items: () => this.renderItems(), craft: () => this.renderCraft(), garage: () => this.renderGarage() }[this.view]();
    return `<div class="panel-inner"><h2>🎒 背包 <small>${this.game.state.inventory.items.length} 件</small></h2>${tabs}${body}</div>`;
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
    const crafts = Object.entries(VEHICLES).filter(([, d]) => d.craft).map(([type, d]) => {
      const check = vs.canCraft(type);
      return `<div class="card row-between"><div><b>${d.icon} ${d.name}</b><small class="muted block">工作台 Lv${d.craft.workbench}・🪑${d.seats}・速度 ×${d.speed}・運載 ${d.cargo}</small><div class="costs">${costHtml(g.state, d.craft.cost)}</div></div>
        ${btn('製作', 'craftVehicle', { type }, { cls: 'btn-sm btn-primary', disabled: !check.ok, title: check.reason || '' })}</div>`;
    }).join('');
    return `
      <p class="muted">探索時可帶載具：所有隊員都有座位時全隊以載具速度移動；運載量讓隊伍帶回更多物資（每人徒步 ${PERSON_CARRY}）。每台至少一人駕駛，除滑板車與腳踏車外都會耗油，行駛與遇襲會磨損耐久。更多載具可在探索加油站、倉庫、工廠等地點時找到。</p>
      <div class="grid">${cards || '<p class="muted">車庫是空的。</p>'}</div>
      <h3>🛠️ 製作載具</h3>
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
    const cards = items.map((it) => {
      const owner = g.equipment.equippedBy(it.id);
      const actions = [
        btn('裝備', 'equipTo', { id: it.id }, { cls: 'btn-xs btn-primary' }),
        btn(it.locked ? '🔓' : '🔒', 'lock', { id: it.id }, { cls: 'btn-xs btn-ghost', title: '上鎖' }),
        btn(`出售 💰${g.equipment.sellValue(it)}`, 'sell', { id: it.id }, { cls: 'btn-xs', disabled: !!owner || it.locked }),
        btn('拆解', 'dismantle', { id: it.id }, { cls: 'btn-xs btn-ghost', disabled: !!owner || it.locked }),
      ].join('');
      return itemCard(it, { equippedBy: owner, actions });
    }).join('');
    const counts = {};
    g.state.inventory.items.forEach((i) => { counts[i.rarity] = (counts[i.rarity] || 0) + 1; });
    const rarities = [['all', '全部品級', '#fff'], ...RARITY_ORDER.map((r) => [r, `${RARITIES[r].name} ${counts[r] || 0}`, RARITIES[r].color])]
      .map(([k, n, c]) => `<button class="chip rchip ${this.rarityFilter === k ? 'active' : ''}" style="--rc:${c}" data-action="rfilter" data-r="${k}">${n}</button>`).join('');
    return `
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
    const wb = g.shelter.maxLevel('workbench');
    const types = Object.entries(ITEM_TYPES).map(([id, def]) => {
      const unlocked = g.equipment.canCraftType(id);
      return `<div class="fac-card ${unlocked ? '' : 'locked'}">
        <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b><small class="muted block">${SLOTS[def.slot].name}・製作等級 Lv${g.equipment.craftLevel()}</small></div></div>
        <div class="row-between"><div class="costs">${costHtml(st, g.equipment.craftCost(id))}</div>
        ${unlocked ? btn('製作', 'craft', { type: id }, { cls: 'btn-sm btn-primary', disabled: wb < 1 }) : `<span class="tag tag-red">🔒 需研究「${RESEARCH[def.requires].name}」</span>`}</div>
      </div>`;
    }).join('');
    const bps = st.inventory.blueprints.map((bp) => `
      <div class="card row-between">
        <div>📜 <b>${ITEM_TYPES[bp.itemType].name}設計圖</b> <span class="rarity" style="--rc:${RARITIES[bp.rarity].color}">保底${RARITIES[bp.rarity].name}</span>
        <div class="costs">${costHtml(st, g.equipment.craftCost(bp.itemType, true))}</div></div>
        ${btn('製作', 'craftBp', { id: bp.id, type: bp.itemType }, { cls: 'btn-sm btn-primary', disabled: wb < 1 })}
      </div>`).join('');
    const odds = (boost) => Object.entries(g.equipment.rarityOdds(boost))
      .map(([r, p]) => `<span class="odd" style="--rc:${RARITIES[r].color}">${RARITIES[r].name} ${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%</span>`).join('');
    return `
      <p class="muted">工作台 Lv${wb}：製作裝備等級 = 工作台等級 × 5。製作出的<b>品級與素質皆為隨機</b>，工作台等級越高越容易出現高品級。設計圖可無視研究限制，並保證最低品級。</p>
      <div class="odds"><small class="muted">目前製作品級機率：</small>${odds(g.equipment.craftBoost(false))}</div>
      ${bps ? `<h3>設計圖</h3>${bps}` : ''}
      <h3>基礎製作</h3><div class="grid">${types}</div>`;
  }

  onAction(action, data) {
    const g = this.game;
    switch (action) {
      case 'view': this.view = data.v; break;
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

  pickSurvivor(itemId) {
    const g = this.game;
    const item = g.equipment.getItem(itemId);
    const rows = g.state.survivors.map((sv) => {
      const cur = g.equipment.getItem(sv.equipment[item.slot]);
      const diff = item.power - (cur?.power || 0);
      return `<button class="pick-row" data-action="give" data-id="${sv.id}" ${sv.status === 'exploring' ? 'disabled' : ''}>
        <span>${CLASSES[sv.classId].icon} <b>${escapeHtml(sv.name)}</b> Lv${sv.level}</span>
        <small class="muted">目前：${cur ? escapeHtml(cur.name) : '無'}</small>
        <span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>
      </button>`;
    }).join('');
    this.ui.modal.open({
      title: `裝備「${item.name}」給…`,
      body: `<div class="pick-list">${rows}</div>`,
      onAction: (action, data, m) => {
        if (action === 'give') {
          const r = this.ui.result(g.equipment.equip(data.id, itemId));
          if (r.ok) m.close();
        }
      },
    });
  }
}
