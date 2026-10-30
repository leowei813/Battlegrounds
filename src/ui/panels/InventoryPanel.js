import {
  SLOTS, ITEM_TYPES, RARITIES, RARITY_ORDER,
} from '../../config/equipment.js';
import { RESEARCH } from '../../config/research.js';
import { CLASSES } from '../../config/survivors.js';
import { escapeHtml } from '../../utils/dom.js';
import { btn, itemCard, costHtml } from '../components.js';

/**
 * 背包分頁：裝備篩選/排序、裝備給隊員、出售、拆解、上鎖，以及工作台製作。
 */
export class InventoryPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.view = 'items';
    this.filter = 'all';
    this.sort = 'power';
  }

  render() {
    const tabs = `<div class="seg">${btn('🎒 裝備', 'view', { v: 'items' }, { cls: this.view === 'items' ? 'active' : '' })}${btn('🛠️ 製作', 'view', { v: 'craft' }, { cls: this.view === 'craft' ? 'active' : '' })}</div>`;
    return `<div class="panel-inner"><h2>🎒 背包 <small>${this.game.state.inventory.items.length} 件</small></h2>${tabs}${this.view === 'items' ? this.renderItems() : this.renderCraft()}</div>`;
  }

  renderItems() {
    const g = this.game;
    let items = [...g.state.inventory.items];
    if (this.filter !== 'all') items = items.filter((i) => i.slot === this.filter);
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
    return `
      <div class="chips">${filters}</div>
      <div class="row-between"><div class="chips">
        <button class="chip ${this.sort === 'power' ? 'active' : ''}" data-action="sort" data-s="power">依戰力</button>
        <button class="chip ${this.sort === 'rarity' ? 'active' : ''}" data-action="sort" data-s="rarity">依品質</button></div>
        ${btn('一鍵出售普通', 'sellCommon', {}, { cls: 'btn-sm btn-ghost' })}</div>
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
    return `
      <p class="muted">工作台 Lv${wb}：製作裝備等級 = 工作台等級 × 5。設計圖可無視研究限制，並保證品質。</p>
      ${bps ? `<h3>設計圖</h3>${bps}` : ''}
      <h3>基礎製作</h3><div class="grid">${types}</div>`;
  }

  onAction(action, data) {
    const g = this.game;
    switch (action) {
      case 'view': this.view = data.v; break;
      case 'filter': this.filter = data.f; break;
      case 'sort': this.sort = data.s; break;
      case 'lock': g.equipment.toggleLock(data.id); break;
      case 'sell': this.ui.result(g.equipment.sell(data.id)); break;
      case 'dismantle': this.ui.result(g.equipment.dismantle(data.id)); break;
      case 'sellCommon': {
        const ids = g.state.inventory.items.filter((i) => i.rarity === 'common' && !i.locked && !g.equipment.equippedBy(i.id)).map((i) => i.id);
        let coins = 0;
        ids.forEach((id) => { coins += g.equipment.sellValue(g.equipment.getItem(id)); g.equipment.sell(id); });
        this.ui.result({ ok: true, msg: ids.length ? `出售 ${ids.length} 件，獲得 ${coins} 金錢` : '沒有可出售的普通裝備' });
        break;
      }
      case 'craft': this.showCraftResult(g.equipment.craft(data.type)); break;
      case 'craftBp': this.showCraftResult(g.equipment.craft(data.type, data.id)); break;
      case 'equipTo': this.pickSurvivor(data.id); break;
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
