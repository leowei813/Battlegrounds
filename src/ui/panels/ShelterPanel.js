import { FACILITIES, FACILITY_MAX_LEVEL } from '../../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL } from '../../config/defenses.js';
import { CLASSES } from '../../config/survivors.js';
import { escapeHtml } from '../../utils/dom.js';
import { btn, costHtml, timerBar, progressBar } from '../components.js';

/**
 * 避難所分頁（側邊/底部抽屜）：設施升級、施工佇列、防禦建築、事件紀錄。
 */
export class ShelterPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const sh = st.shelter;
    const head = `<div class="drawer-head" data-action="toggleDrawer"><b>🏠 ${escapeHtml(sh.name || '避難所')}</b><span>${this.ui.drawerCollapsed ? '▲ 展開' : '▼ 收合'}</span></div>`;
    if (!g.shelter.hasShelter()) {
      return `${head}<div class="empty">尚未建立避難所。<br>${btn('🗺️ 前往地圖選擇建築', 'gotoMap', {}, { cls: 'btn-primary' })}</div>`;
    }
    const now = Date.now();
    const queue = sh.buildQueue.map((q) => {
      const name = q.kind === 'facility' ? FACILITIES[q.id].name : `${DEFENSES[q.id].name}（槽位 ${q.slot + 1}）`;
      return `<div class="queue-item">🔨 ${name} → Lv${q.targetLevel}${timerBar(q.startAt || now, q.endAt, now)}</div>`;
    }).join('');

    const facilities = Object.entries(FACILITIES).map(([id, def]) => {
      const lv = sh.facilities[id].level;
      const busy = g.shelter.isFacilityBusy(id);
      const max = lv >= FACILITY_MAX_LEVEL;
      const check = g.shelter.canUpgradeFacility(id);
      return `
      <div class="fac-card ${lv === 0 ? 'unbuilt' : ''}">
        <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b> <small>Lv${lv}</small><small class="muted block">${def.desc}</small></div></div>
        <div class="fac-effect">${lv > 0 ? def.effectText(lv) : '尚未建造'}${max ? '' : `<span class="next">→ ${def.effectText(lv + 1)}</span>`}</div>
        ${max ? '<div class="tag">MAX</div>' : `<div class="row-between"><div class="costs">${costHtml(st, g.shelter.facilityCost(id))}</div>
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

    const wallRatio = g.shelter.wallHp() / g.shelter.wallMax();
    const logs = st.log.slice(0, 10).map((l) => `<li class="log-${l.type}"><time>${new Date(l.t).toLocaleTimeString().slice(0, 5)}</time>${escapeHtml(l.msg)}</li>`).join('');
    return `${head}
      <div class="drawer-body">
        <div class="stat-grid">
          <div><small>圍牆</small>${progressBar(wallRatio, wallRatio < 0.3 ? 'danger' : '', `${Math.floor(g.shelter.wallHp())}/${g.shelter.wallMax()}`)}</div>
          <div><small>防禦 DPS</small><b>${g.siege.defenseDps()}</b></div>
          <div><small>來襲殭屍</small><b>${g.siege.zombies.length}</b></div>
          <div><small>屍潮間隔</small><b>${g.siege.spawnInterval().toFixed(1)} 秒</b></div>
        </div>
        ${queue ? `<h4>施工佇列</h4>${queue}` : ''}
        <h4>防禦建築 <small class="muted">（點擊場景中的槽位也可建造）</small></h4>
        <div class="slot-grid">${defenses}</div>
        <h4>設施</h4>
        <div class="fac-list">${facilities}</div>
        <h4>事件紀錄</h4>
        <ul class="log-list">${logs}</ul>
      </div>`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'gotoMap') this.ui.switchTab('map');
    if (action === 'upgrade') this.ui.result(g.shelter.upgradeFacility(data.id));
    if (action === 'slot') this.openSlot(+data.slot);
  }

  slotBody(slot) {
    const g = this.game;
    const st = g.state;
    const d = st.shelter.defenses[slot];
    const busy = g.shelter.isSlotBusy(slot);
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
    if (!g.shelter.hasShelter()) {
      this.ui.toastEl.show('請先建立避難所', 'danger');
      return;
    }
    this.ui.modal.open({
      title: `🛡️ 防禦槽位 ${slot + 1}`,
      body: this.slotBody(slot),
      live: () => this.slotBody(slot),
      onAction: (action, data, m) => {
        if (action === 'build') this.ui.result(g.shelter.buildDefense(slot, data.type));
        if (action === 'demolish' && confirm('確定拆除？（不退還資源）')) this.ui.result(g.shelter.demolish(slot));
        if (action === 'garrison') this.ui.result(g.shelter.garrison(slot, data.id || null));
        m.update(this.slotBody(slot));
      },
    });
  }
}

