import { FACILITIES, FACILITY_MAX_LEVEL, OUTPOST_FACILITIES } from '../../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL } from '../../config/defenses.js';
import { CLASSES } from '../../config/survivors.js';
import { PRIMARY_DANGER_COEF, MAX_OUTPOSTS, BASE_SIZES } from '../../config/civilization.js';
import { openAbandonDialog } from '../AbandonDialog.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, costHtml, timerBar, progressBar, metaOf,
} from '../components.js';

/**
 * 避難所分頁（側邊/底部抽屜）：設施升級、施工佇列、防禦建築、事件紀錄。
 */
export class ShelterPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  /** 文明度卡片 */
  renderCivilization(base) {
    const g = this.game;
    const civ = g.civilization;
    const b = civ.breakdown();
    const tier = civ.tier(b.total);
    const next = tier.next;
    const ratio = next ? (b.total - tier.min) / (next.min - tier.min) : 1;
    const siege = g.siege.of(base.id);
    const isPrimary = g.shelter.isPrimary(base);
    const baseDanger = g.shelter.baseDanger(base);
    const danger = g.shelter.dangerLevel(base);
    return `
      <div class="civ-card">
        <div class="row-between"><b>${tier.icon} 文明度 ${b.total}</b><span class="tag tag-amber">${tier.name}</span></div>
        ${progressBar(ratio, 'civ', next ? `距「${next.name}」${next.min - b.total}` : '已達最高階段')}
        <div class="civ-parts"><span>🏗️ 建築 ${b.buildings}</span><span>👑 玩家等級 ${b.player}</span><span>🎒 裝備 ${b.equipment}</span></div>
        <small class="muted block">屍潮強度隨文明度提升（殭屍 +${civ.levelBonus()} 級、頻率 ×${civ.spawnMul().toFixed(2)}），與天數無關。</small>
        <div class="row-between danger-row">
          <span>☠ 據點危險度 <b>${danger}</b>・<span class="zone-tag" style="--zc:${siege.zone().color}">${siege.zone().name}</span></span>
          <small class="muted">${isPrimary ? `基礎 ${baseDanger} + 文明度 ${b.total} × ${PRIMARY_DANGER_COEF}` : `基礎 ${baseDanger}（前哨站不受文明度加成）`}</small>
        </div>
        <small class="muted block">${BASE_SIZES[base.size]?.name || ''}據點屍潮 ×${siege.sizeMul().toFixed(2)}（據點越大、區域越危險，屍潮越多）</small>
        <small class="muted block">${siege.active()
    ? `本據點殭屍 Lv${siege.zombieLevel()}・每波約 ${Math.round(siege.waveSize())} 隻`
    : `☀️ 白天殭屍躲在建築內；入夜後本據點殭屍約 Lv${siege.zombieLevel() + 1}`}</small>
      </div>`;
  }

  waveText(siege) {
    const w = siege.waveInfo();
    if (siege.quiet()) return '💥 防線已破，今晚不再來襲';
    if (!w.active) return '☀️ 白天無屍潮';
    if (w.attacking) return `第 ${w.wave}/${w.maxWaves} 波進攻中（剩 ${w.left} 隻）`;
    if (w.wave >= w.maxWaves) return `✅ 今晚 ${w.maxWaves} 波屍潮已全部擊退`;
    return `下一波 ${w.nextIn} 秒後（今晚共 ${w.maxWaves} 波）`;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const sh = this.ui.viewBase();
    const ui = this.ui;
    const head = `<div class="drawer-head"><b data-action="toggleDrawer">${sh && g.shelter.isPrimary(sh) ? '⭐' : '🏴'} ${escapeHtml(sh?.name || '避難所')}</b>
      <span class="drawer-ctrl">${ui.drawerCollapsed ? '' : `<button class="btn btn-xs btn-ghost mobile-only" data-action="drawerFull">${ui.drawerFull ? '⤓ 縮小' : '⤢ 全螢幕'}</button>`}<button class="btn btn-xs btn-ghost" data-action="toggleDrawer">${ui.drawerCollapsed ? '▲ 展開' : '▼ 收合'}</button></span></div>`;
    if (!sh) {
      return `${head}<div class="empty">尚未建立避難所。<br>${btn('🗺️ 前往地圖選擇建築', 'gotoMap', {}, { cls: 'btn-primary' })}</div>`;
    }
    const now = Date.now();
    const tabs = st.bases.map((b) => {
      return `<button class="chip ${b.id === sh.id ? 'active' : ''}" data-action="viewBase" data-id="${b.id}">${g.shelter.isPrimary(b) ? '⭐' : '🏴'} ${escapeHtml(b.name)}</button>`;
    }).join('');
    const baseActions = g.shelter.isPrimary(sh)
      ? `<small class="muted">⭐ 避難所：倖存者居住、生產、探索出發、駐守倖存者防衛於此。</small>${btn('🏚️ 放棄避難所（搬家）', 'abandon', {}, { cls: 'btn-sm btn-ghost' })}`
      : `<small class="muted">🏴 前哨站：只有防禦功能，不能生產。</small>${btn('🏚️ 放棄前哨站', 'abandon', {}, { cls: 'btn-sm btn-ghost' })}`;
    const queue = sh.buildQueue.map((q) => {
      const name = q.kind === 'facility' ? FACILITIES[q.id].name : `${DEFENSES[q.id].name}（槽位 ${q.slot + 1}）`;
      return `<div class="queue-item">🔨 ${name} → Lv${q.targetLevel}${timerBar(q.startAt || now, q.endAt, now)}</div>`;
    }).join('');

    const outpost = g.shelter.isOutpost(sh);
    const facilities = Object.entries(FACILITIES).filter(([id]) => !outpost || OUTPOST_FACILITIES.includes(id)).map(([id, def]) => {
      const lv = sh.facilities[id].level;
      const busy = g.shelter.isFacilityBusy(sh, id);
      const max = lv >= FACILITY_MAX_LEVEL;
      const check = g.shelter.canUpgradeFacility(sh, id);
      return `
      <div class="fac-card ${lv === 0 ? 'unbuilt' : ''}">
        <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b> <small>Lv${lv}</small><small class="muted block">${def.desc}</small></div></div>
        <div class="fac-effect">${lv > 0 ? def.effectText(lv) : '尚未建造'}${max ? '' : `<span class="next">→ ${def.effectText(lv + 1)}</span>`}</div>
        ${max ? '<div class="tag">MAX</div>' : `<div class="row-between"><div class="costs">${costHtml(st, g.shelter.facilityCost(sh, id))}</div>
          ${btn(busy ? '施工中' : lv === 0 ? '建造' : '升級', 'upgrade', { id }, { cls: 'btn-sm btn-primary', disabled: !check.ok, title: check.reason || '' })}</div>`}
      </div>`;
    }).join('');

    const defenses = sh.defenses.map((d, i) => {
      const def = d.type ? DEFENSES[d.type] : null;
      const gar = d.garrisonId ? g.survivors.get(d.garrisonId) : null;
      return `<button class="slot-btn ${def ? '' : 'empty'}" data-action="slot" data-slot="${i}">
        <span>${def ? def.icon : '➕'}</span><small>${def ? `${def.name} Lv${d.level}` : `空地 ${i + 1}`}</small>${gar ? `<small>👤${escapeHtml(gar.name)}</small>` : ''}
      </button>`;
    }).join('');

    const siege = g.siege.of(sh.id);
    const wallRatio = g.shelter.wallHp(sh) / g.shelter.wallMax(sh);
    const logs = st.log.slice(0, 10).map((l) => `<li class="log-${l.type}"><time>${new Date(l.t).toLocaleTimeString().slice(0, 5)}</time>${escapeHtml(l.msg)}</li>`).join('');
    const z = g.shelter.sizeInfo(sh);
    const tab = ['overview', 'facilities', 'defense', 'log'].includes(ui.shelterTab) ? ui.shelterTab : 'overview';
    const tabBtn = (id, label) => `<button class="seg-btn ${tab === id ? 'active' : ''}" data-action="shelterTab" data-t="${id}">${label}</button>`;
    const tabs2 = `<div class="drawer-tabs">${tabBtn('overview', '🏠 總覽')}${tabBtn('facilities', `🏗️ 設施${queue ? ' 🔨' : ''}`)}${tabBtn('defense', '🛡️ 防禦')}${tabBtn('log', '📜 紀錄')}</div>`;
    const sections = {
      overview: `
        <div class="label">避難所 ${g.shelter.hasShelter() ? 1 : 0}/1・前哨站 ${g.shelter.outposts().length}/${g.shelter.outpostLimit()} <small>（研究「擴張科技」最多 ${MAX_OUTPOSTS} 座，在地圖點選建築建立）</small></div>
        ${g.shelter.hasShelter() ? '' : `<div class="card warn">🏚️ 目前沒有避難所，無法生產與探索。${btn('🗺️ 到地圖選擇新的避難所', 'gotoMap', {}, { cls: 'btn-sm btn-primary' })}</div>`}
        <div class="chips">${tabs}</div>
        <div class="stat-grid">
          <div class="wide"><small>圍牆（不會自行修復）</small>${progressBar(wallRatio, wallRatio < 0.3 ? 'danger' : '', `${Math.floor(g.shelter.wallHp(sh))}/${g.shelter.wallMax(sh)}`)}
            <small class="muted block">🔨 修繕人員 ${g.shelter.repairers().length}・每秒 +${g.shelter.repairRate().toFixed(1)}・每 100 點耗 ${Object.entries(g.shelter.repairCostPerHp()).map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name}${Math.round(v * 100)}`).join(' ')}${g.shelter.repairers().length ? '' : '（到倖存者頁指派「修繕圍牆」工作）'}</small></div>
          <div><small>防禦 DPS</small><b>${siege.defenseDps()}</b></div>
          <div><small>來襲殭屍</small><b>${siege.zombies.length}</b></div>
          <div class="wide"><small>屍潮波次</small><b>${this.waveText(siege)}</b></div>
        </div>
        ${queue ? `<h4>施工佇列</h4>${queue}` : ''}
        <div class="btn-row">${btn(`🗄️ 物品倉庫（裝備 ${st.inventory.items.length}）`, 'openStorage', {}, { cls: 'btn-sm' })}${btn(`🚗 車庫 ${st.vehicles.length}/${g.vehicles.garageSize()}`, 'openGarage', {}, { cls: 'btn-sm' })}</div>
        ${this.renderCivilization(sh)}
        <div class="btn-row">${baseActions}</div>`,
      facilities: `${queue ? `<h4>施工佇列</h4>${queue}` : ''}<div class="fac-list">${facilities}</div>`,
      defense: `<p class="muted">${z.name}據點・防禦欄位 ${z.slots}・共可建造 ${z.total} 棟建築。點空地建造，點已建造的防禦建築升級或派人駐守（也可以直接點上方場景中的槽位）。</p>
        <div class="slot-grid">${defenses}</div>
        <div class="stat-grid"><div><small>防禦 DPS</small><b>${siege.defenseDps()}</b></div><div><small>屍潮波次</small><b>${this.waveText(siege)}</b></div></div>`,
      log: `<ul class="log-list">${logs}</ul>`,
    };
    return `<div class="drawer-top">${head}${ui.drawerCollapsed ? '' : tabs2}</div>
      <div class="drawer-body">${sections[tab]}</div>`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'gotoMap') this.ui.switchTab('map');
    const base = this.ui.viewBase();
    if (action === 'upgrade') this.ui.result(g.shelter.upgradeFacility(base, data.id));
    if (action === 'slot') this.openSlot(+data.slot);
    if (action === 'viewBase') this.ui.setViewBase(data.id);
    if (action === 'abandon') openAbandonDialog(this.ui, base);
    if (action === 'openStorage') this.ui.panels.inventory.openStorage();
    if (action === 'openGarage') this.ui.panels.inventory.openGarage();
  }

  slotBody(base, slot) {
    const g = this.game;
    const st = g.state;
    const d = base.defenses[slot];
    const busy = g.shelter.isSlotBusy(base, slot);
    if (!d.type) {
      return `<p class="muted">選擇要在此槽位建造的防禦建築：</p>
      ${Object.entries(DEFENSES).map(([type, def]) => {
        const lock = g.shelter.defenseLockReason(type);
        const s = def.stats(1);
        return `<div class="fac-card ${lock ? 'locked' : ''}">
          <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b><small class="muted block">${def.desc}</small></div></div>
          <div class="muted">${s.damage ? `傷害 ${s.damage}・` : ''}${s.fireRate ? `攻速 ${s.fireRate}/秒・` : ''}射程 ${s.range}${s.wallBonus ? `・圍牆 +${s.wallBonus}` : ''}</div>
          <div class="row-between"><div class="costs">${costHtml(st, g.shelter.defenseCost(type, 1))}</div>
          ${lock ? `<span class="tag tag-red">🔒 ${lock}</span>` : btn('建造', 'build', { type }, { cls: 'btn-sm btn-primary' })}</div>
        </div>`;
      }).join('')}`;
    }
    const def = DEFENSES[d.type];
    const s = d.level > 0 ? def.stats(d.level) : null;
    const n = def.stats(d.level + 1);
    const max = d.level >= DEFENSE_MAX_LEVEL;
    let garrison = '';
    if (d.type === 'watchPost' && d.level > 0) {
      const cur = d.garrisonId ? g.survivors.get(d.garrisonId) : null;
      garrison = `<h4>駐守人員</h4>
        <p>${cur ? `目前：${CLASSES[cur.classId].icon} ${escapeHtml(cur.name)}（攻擊 ${g.survivors.stats(cur).atk}）` : '無人駐守'}</p>
        <div class="chips">${st.survivors.filter((sv) => sv.status !== 'exploring').map((sv) => `<button class="chip ${sv.id === d.garrisonId ? 'active' : ''}" data-action="garrison" data-id="${sv.id}">${CLASSES[sv.classId].icon} ${escapeHtml(sv.name)}</button>`).join('')}
        ${cur ? '<button class="chip" data-action="garrison" data-id="">撤回</button>' : ''}</div>`;
    }
    return `
      <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b> Lv${d.level} ${busy ? '<span class="tag tag-amber">施工中</span>' : ''}<small class="muted block">${def.desc}</small></div></div>
      ${s ? `<p>目前：${s.damage ? `傷害 ${s.damage}・` : ''}${s.fireRate ? `攻速 ${s.fireRate}・` : ''}射程 ${s.range}${s.wallBonus ? `・圍牆 +${s.wallBonus}` : ''}${s.garrisonMul ? `・駐守倍率 ×${s.garrisonMul.toFixed(2)}` : ''}</p>` : ''}
      ${max ? '<p class="tag">MAX</p>' : `<p class="muted">下一級：${n.damage ? `傷害 ${n.damage}・` : ''}射程 ${n.range}${n.wallBonus ? `・圍牆 +${n.wallBonus}` : ''}</p>
      <div class="row-between"><div class="costs">${costHtml(st, g.shelter.defenseCost(d.type, d.level + 1))}</div>${btn('升級', 'build', { type: d.type }, { cls: 'btn-primary btn-sm', disabled: busy })}</div>`}
      ${garrison}
      <div class="btn-row end">${btn('拆除', 'demolish', {}, { cls: 'btn-ghost btn-sm', disabled: busy })}</div>`;
  }

  openSlot(slot) {
    const g = this.game;
    const base = this.ui.viewBase();
    if (!base) {
      this.ui.toastEl.show('請先建立避難所', 'danger');
      return;
    }
    this.ui.modal.open({
      title: `🛡️ ${base.name}・防禦槽位 ${slot + 1}`,
      body: this.slotBody(base, slot),
      live: () => this.slotBody(base, slot),
      onAction: (action, data, m) => {
        if (action === 'build') this.ui.result(g.shelter.buildDefense(base, slot, data.type));
        if (action === 'demolish' && confirm('確定拆除？（不退還資源）')) this.ui.result(g.shelter.demolish(base, slot));
        if (action === 'garrison') this.ui.result(g.shelter.garrison(base, slot, data.id || null));
        m.update(this.slotBody(base, slot));
      },
    });
  }
}

