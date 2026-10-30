import { CLASSES, JOBS, xpToNext } from '../../config/survivors.js';
import { SLOT_KEYS, SLOTS } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, costHtml, survivorCard, itemCard, statLine, progressBar,
} from '../components.js';

/**
 * 倖存者分頁：招募、隊員列表、詳細資料（技能/裝備/工作指派）。
 */
export class SurvivorPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const pool = st.recruitPool.map((c) => `
      <div class="card recruit">
        <div class="row-between"><b>${CLASSES[c.classId].icon} ${escapeHtml(c.name)}</b><small>${CLASSES[c.classId].name} Lv${c.level}</small></div>
        <small class="muted">${CLASSES[c.classId].skills[0].name}：${CLASSES[c.classId].skills[0].desc}</small>
        <div class="btn-row">${btn('✅ 接納', 'accept', { id: c.id }, { cls: 'btn-sm btn-primary' })}${btn('拒絕', 'reject', { id: c.id }, { cls: 'btn-sm btn-ghost' })}</div>
      </div>`).join('');
    const cost = g.survivors.currentRecruitCost();
    const full = st.survivors.length >= g.survivors.housing();
    const list = st.survivors.map((sv) => survivorCard(g, sv, {
      actions: btn('詳情 / 裝備', 'detail', { id: sv.id }, { cls: 'btn-sm' }),
    })).join('');
    return `<div class="panel-inner">
      <h2>👥 倖存者 <small>${st.survivors.length}/${g.survivors.housing()} 床位</small></h2>
      ${pool ? `<h3>🙋 等待加入（探索中遇到）</h3><div class="grid">${pool}</div>` : ''}
      <div class="card row-between">
        <div><b>📻 廣播招募</b><small class="muted block">隨機職業的倖存者會前來投靠</small><div class="costs">${costHtml(st, cost)}</div></div>
        ${btn(full ? '床位已滿' : '招募', 'recruit', {}, { cls: 'btn-primary', disabled: full })}
      </div>
      <div class="grid">${list}</div>
    </div>`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'accept') this.ui.result(g.survivors.acceptCandidate(data.id));
    if (action === 'reject') this.ui.result(g.survivors.rejectCandidate(data.id));
    if (action === 'recruit') this.ui.result(g.survivors.recruitRandom());
    if (action === 'detail') this.openDetail(data.id);
  }

  detailBody(id) {
    const g = this.game;
    const sv = g.survivors.get(id);
    if (!sv) return '<p>已離開</p>';
    const cls = CLASSES[sv.classId];
    const s = g.survivors.stats(sv);
    const now = Date.now();
    const skills = cls.skills.map((sk) => `<li class="${sv.level >= sk.unlock ? 'on' : 'off'}"><b>${sk.name}</b>（Lv${sk.unlock}）${sk.desc}</li>`).join('');
    const slots = SLOT_KEYS.map((slot) => {
      const item = g.equipment.getItem(sv.equipment[slot]);
      return `<div class="equip-slot">
        <div class="row-between"><small>${SLOTS[slot].icon} ${SLOTS[slot].name}</small>
        <span>${btn('更換', 'pickItem', { slot }, { cls: 'btn-xs' })}${item ? btn('卸下', 'unequip', { slot }, { cls: 'btn-xs btn-ghost' }) : ''}</span></div>
        ${item ? itemCard(item, { compact: true }) : '<div class="muted">— 空 —</div>'}
      </div>`;
    }).join('');
    const jobs = Object.entries(JOBS).map(([jid, j]) => {
      const bonus = j.classBonus?.[sv.classId];
      return `<button class="chip ${sv.job === jid ? 'active' : ''}" data-action="job" data-job="${jid}">${j.icon} ${j.name}${bonus ? ` ×${bonus}` : ''}</button>`;
    }).join('');
    const injured = sv.injuredUntil > now;
    return `
      <div class="sv-detail" style="--cc:${cls.color}">
        <div class="sv-head"><span class="sv-icon big">${cls.icon}</span><div><b>${escapeHtml(sv.name)}</b> ${sv.isLeader ? '👑 領袖' : ''}<small class="block">${cls.name} Lv${sv.level}・戰力 ${s.power}</small></div></div>
        ${progressBar(sv.xp / xpToNext(sv.level), 'xp', `XP ${sv.xp}/${xpToNext(sv.level)}`)}
        <div class="stat-line">${statLine({ hp: s.hp, atk: s.atk, def: s.def, crit: s.crit, critDmg: s.critDmg - 1, dodge: s.dodge })}<span>攻速 ${s.atkSpeed}</span></div>
        ${injured ? `<div class="row-between warn">🩸 受傷中 ${btn(`治療 💊${g.survivors.healCost().medicine}`, 'heal', {}, { cls: 'btn-sm btn-primary' })}</div>` : ''}
        <h4>技能</h4><ul class="skill-list">${skills}</ul>
        <h4>工作指派 <small class="muted">（閒置在避難所時生效）</small></h4><div class="chips">${jobs}</div>
        <h4>裝備</h4><div class="equip-grid">${slots}</div>
        ${sv.isLeader ? '' : `<div class="btn-row end">${btn('遣散', 'dismiss', {}, { cls: 'btn-ghost btn-sm' })}</div>`}
      </div>`;
  }

  openDetail(id) {
    const g = this.game;
    this.ui.modal.open({
      title: '倖存者資料',
      wide: true,
      body: this.detailBody(id),
      live: () => this.detailBody(id),
      onAction: (action, data, m) => {
        if (action === 'job') this.ui.result(g.survivors.setJob(id, data.job));
        if (action === 'heal') this.ui.result(g.survivors.heal(id));
        if (action === 'unequip') this.ui.result(g.equipment.unequip(id, data.slot));
        if (action === 'dismiss' && confirm('確定遣散？裝備會留在背包。')) {
          this.ui.result(g.survivors.dismiss(id));
          m.close();
          return;
        }
        if (action === 'pickItem') {
          this.pickItem(id, data.slot);
          return;
        }
        m.update(this.detailBody(id));
      },
    });
  }

  /** 選擇裝備的子彈窗 */
  pickItem(svId, slot) {
    const g = this.game;
    const items = g.state.inventory.items.filter((i) => i.slot === slot).sort((a, b) => b.power - a.power);
    const body = items.length
      ? items.map((it) => {
        const owner = g.equipment.equippedBy(it.id);
        return itemCard(it, { equippedBy: owner, actions: btn('裝備', 'equip', { id: it.id }, { cls: 'btn-sm btn-primary', disabled: owner?.id === svId }) });
      }).join('')
      : '<p class="muted">背包中沒有此部位的裝備。</p>';
    this.ui.modal.open({
      title: `選擇${SLOTS[slot].name}`,
      body: `<div class="grid">${body}</div>`,
      onAction: (action, data) => {
        if (action === 'equip') {
          const r = this.ui.result(g.equipment.equip(svId, data.id));
          if (r.ok) this.openDetail(svId);
        }
      },
    });
  }
}
