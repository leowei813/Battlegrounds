import { formatDuration } from '../../utils/math.js';
import { CLASSES, JOBS, xpToNext } from '../../config/survivors.js';
import { RESOURCES, RESOURCE_KEYS } from '../../config/constants.js';
import { SLOT_KEYS, SLOTS } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, costHtml, survivorCard, itemCard, statLine, progressBar, rarityTag, hpBar, survivorStatus,
} from '../components.js';
import { RARITIES } from '../../config/equipment.js';

/**
 * 倖存者分頁：招募、隊員列表、詳細資料（技能/裝備/工作指派）。
 */
export class SurvivorPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
  }

  /** 候選人卡片（招募三選一與探索遭遇共用） */
  candidateCard(c, actions) {
    const g = this.game;
    const cls = CLASSES[c.classId];
    const r = RARITIES[c.rarity] || RARITIES.common;
    const s = g.survivors.stats(c);
    return `<div class="card recruit sv-card r-${c.rarity}" style="--rc:${r.color};--cc:${cls.color}">
      <div class="sv-head"><span class="sv-icon">${cls.icon}</span>
        <div class="sv-title"><b>${escapeHtml(c.name)}</b><small>${rarityTag(c.rarity)} ${cls.name} Lv${c.level}・成長 ×${g.survivors.growthMul(c)}</small></div></div>
      <div class="stat-line">${statLine({ hp: s.hp, atk: s.atk, def: s.def, crit: s.crit, dodge: s.dodge })}</div>
      <small class="muted">${cls.skills[0].name}：${cls.skills[0].desc}</small>
      <div class="btn-row">${actions}</div>
    </div>`;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const full = g.survivors.isFull();
    const pool = st.recruitPool.map((c) => this.candidateCard(c,
      `${btn('✅ 接納', 'accept', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full })}${btn('拒絕', 'reject', { id: c.id }, { cls: 'btn-sm btn-ghost' })}`)).join('');
    const offer = (st.recruitOffer || []).map((c) => this.candidateCard(c,
      btn(`✅ 雇用 💰${g.survivors.hireCost(c).coins}`, 'pick', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full }))).join('');
    const cost = g.survivors.currentRecruitCost();
    const board = (st.recruitBoard?.list || []).map((c) => this.candidateCard(c,
      btn(`✅ 雇用 💰${g.survivors.hireCost(c).coins}`, 'hire', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full }))).join('');
    const odds = Object.entries(g.survivors.rarityOdds())
      .map(([r, p]) => `<span class="odd" style="--rc:${RARITIES[r].color}">${RARITIES[r].name} ${p < 1 ? p.toFixed(2) : p.toFixed(1)}%</span>`).join('');
    const cap = g.survivors.housingBreakdown();
    const list = st.survivors.map((sv) => survivorCard(g, sv, {
      actions: `${btn('詳情 / 裝備', 'detail', { id: sv.id }, { cls: 'btn-sm' })}${sv.severe && !g.survivors.isStarving() ? btn(`💊 治療（藥品 ${g.survivors.healCost().medicine}）`, 'heal', { id: sv.id }, { cls: 'btn-sm btn-primary' }) : ''}${sv.isLeader ? '' : btn('🚪 驅逐', 'dismiss', { id: sv.id }, { cls: 'btn-sm btn-ghost', disabled: sv.status === 'exploring' })}`,
    })).join('');
    const { net } = g.resources.rates();
    return `<div class="panel-inner">
      <h2>👥 倖存者 <small>${st.survivors.length}/${g.survivors.housing()} 人（上限 ${cap.max}）</small></h2>
      <p class="muted">人數上限 = 基本 ${cap.base} + 領袖等級 ÷ 5（${cap.leader}）+ 各據點等級（${cap.bases}），最多 ${cap.max} 人。每人每小時吃 3 食物，目前食物淨收入 <b class="${net.food < 0 ? 'neg' : 'pos'}">${net.food >= 0 ? '+' : ''}${net.food.toFixed(1)}/時</b>。</p>
      ${g.survivors.isStarving() ? '<div class="card warn">🍽️ <b>食物耗盡，全員飢餓中！</b>每分鐘流失 4% 生命直到重傷，飢餓時無法治療。重傷且持續飢餓滿遊戲內 3 天的隊員會永久死亡（領袖除外）。</div>' : ''}
      ${offer ? `<h3>📻 招募候選人（三選一）</h3><div class="grid">${offer}</div><div class="btn-row">${btn('放棄此次招募（不退費）', 'abandon', {}, { cls: 'btn-ghost btn-sm' })}</div>` : `
      <div class="card row-between">
        <div><b>📻 廣播招募</b><small class="muted block">支付廣播費用後出現 3 位隨機職業與品級的倖存者，選擇後還要支付雇用費；也可以放棄（廣播費用不退還）</small><div class="costs">${costHtml(st, cost)}</div></div>
        ${btn(full ? '人數已達上限' : '招募', 'recruit', {}, { cls: 'btn-primary', disabled: full })}
      </div>`}
      ${pool ? `<h3>🙋 等待加入（探索中遇到）</h3><div class="grid">${pool}</div>` : ''}
      <h3>🏕️ 附近的倖存者 <small class="muted">每小時更新（${formatDuration(Math.max(0, st.recruitBoard.refreshAt - Date.now()))}後）・雇用需支付金錢</small></h3>
      <div class="grid">${board || '<p class="muted">目前沒有人。</p>'}</div>
      <div class="odds"><small class="muted">倖存者品級機率（招募技術 Lv${g.research.level('r_tech')}/10）：</small>${odds}</div>
      <div class="grid">${list}</div>
    </div>`;
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'accept') this.ui.result(g.survivors.acceptCandidate(data.id));
    if (action === 'reject') this.ui.result(g.survivors.rejectCandidate(data.id));
    if (action === 'recruit') this.ui.result(g.survivors.recruitRoll());
    if (action === 'pick') this.ui.result(g.survivors.pickRecruit(data.id));
    if (action === 'hire') this.ui.result(g.survivors.hireFromBoard(data.id));
    if (action === 'abandon' && confirm('放棄此次招募？已支付的費用不會退還。')) this.ui.result(g.survivors.abandonRecruit());
    if (action === 'heal') this.ui.result(g.survivors.heal(data.id));
    if (action === 'dismiss') this.confirmDismiss(data.id);
    if (action === 'detail') this.openDetail(data.id);
  }

  confirmDismiss(id) {
    const sv = this.game.survivors.get(id);
    if (!sv) return false;
    if (!confirm(`確定驅逐「${sv.name}」？此動作無法復原，身上的裝備會留在背包。`)) return false;
    return this.ui.result(this.game.survivors.dismiss(id)).ok;
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
    const hurt = g.survivors.hpOf(sv) < g.survivors.maxHp(sv);
    const starving = g.survivors.isStarving();
    void now;
    return `
      <div class="sv-detail" style="--cc:${cls.color}">
        <div class="sv-head"><span class="sv-icon big">${cls.icon}</span><div><b>${escapeHtml(sv.name)}</b> ${sv.isLeader ? '👑 領袖' : ''}<small class="block">${rarityTag(sv.rarity)} ${cls.name} Lv${sv.level}・戰力 ${s.power}・升級成長 ×${g.survivors.growthMul(sv)}</small></div>${survivorStatus(g, sv)}</div>
        ${hpBar(g, sv)}
        ${progressBar(sv.xp / xpToNext(sv.level), 'xp', `XP ${sv.xp}/${xpToNext(sv.level)}`)}
        <div class="stat-line">${statLine({ hp: s.hp, atk: s.atk, def: s.def, crit: s.crit, critDmg: s.critDmg - 1, dodge: s.dodge })}<span>攻速 ${s.atkSpeed}</span></div>
        ${hurt ? `<div class="row-between ${sv.severe ? 'warn' : ''}">${sv.severe ? '🩸 重傷：無法行動，生命回到 30% 才能脫離' : '🩹 受傷：生命會自然恢復'}${starving ? '<span class="tag tag-red">🍽️ 飢餓中無法治療</span>' : btn(`💊 治療 +50%（藥品 ${g.survivors.healCost().medicine}）`, 'heal', {}, { cls: 'btn-sm btn-primary' })}</div>` : ''}
        <h4>技能</h4><ul class="skill-list">${skills}</ul>
        <h4>工作指派 <small class="muted">（閒置在避難所時生效）</small></h4><div class="chips">${jobs}</div>
        <h4>裝備</h4><div class="equip-grid">${slots}</div>
        ${this.bagHtml(sv)}
        ${sv.isLeader ? '' : `<div class="btn-row end">${btn('🚪 驅逐', 'dismiss', {}, { cls: 'btn-ghost btn-sm', disabled: sv.status === 'exploring' })}</div>`}
      </div>`;
  }

  /**
   * 個人背包（資源與負重）；在避難所時右側顯示倉庫，可存入／取出。
   * 倉庫的每種基本物資都是固定格子，只能改變存取數量。
   */
  bagHtml(sv) {
    const g = this.game;
    const bag = g.survivors.bagOf(sv);
    const load = g.survivors.bagLoad(sv);
    const cap = g.survivors.bagCap(sv);
    const home = g.survivors.atShelter(sv);
    const res = g.state.resources;
    const storage = g.resources.storageCap();
    const rows = RESOURCE_KEYS.map((k) => `
      <div class="bag-row" data-key="${k}">
        <div class="bag-cell ${bag[k] ? '' : 'empty'}"><span>${RESOURCES[k].icon}</span><small>${RESOURCES[k].name}</small><b>${Math.floor(bag[k] || 0)}</b></div>
        ${home ? `<div class="bag-ctrl">
          ${btn('◀', 'bagOut', { key: k }, { cls: 'btn-xs', title: '從倉庫取出' })}
          <input type="number" min="1" step="1" value="10" inputmode="numeric" aria-label="數量">
          ${btn('▶', 'bagIn', { key: k }, { cls: 'btn-xs', title: '存入倉庫' })}
        </div>
        <div class="bag-cell store"><span>${RESOURCES[k].icon}</span><small>倉庫</small><b>${Math.floor(res[k])}</b></div>` : ''}
      </div>`).join('');
    return `<h4>🎒 背包 <small class="muted">負重 ${Math.floor(load)} / ${cap}（徒步 ${g.vehicles.personCarry()} + 背包裝備）</small></h4>
      ${progressBar(cap ? load / cap : 0, load >= cap ? 'danger' : '', `${Math.floor(load)}/${cap}`)}
      ${home ? `<div class="row-between bag-head"><small>隊員背包</small><small>◀ 取出・存入 ▶</small><small>📦 倉庫（上限 ${storage}）</small></div>` : '<p class="muted">不在避難所，無法存取倉庫。</p>'}
      <div class="bag-grid ${home ? 'with-store' : ''}">${rows}</div>
      ${home && load ? `<div class="btn-row end">${btn('全部存入倉庫', 'bagAll', {}, { cls: 'btn-sm' })}</div>` : ''}`;
  }

  openDetail(id) {
    const g = this.game;
    this.ui.modal.open({
      title: '倖存者資料',
      wide: true,
      body: this.detailBody(id),
      live: () => this.detailBody(id),
      onAction: (action, data, m, el) => {
        if (action === 'bagIn' || action === 'bagOut') {
          const n = Math.max(1, Math.floor(+el.closest('.bag-row').querySelector('input').value || 1));
          const r = action === 'bagIn' ? g.survivors.deposit(id, data.key, n) : g.survivors.withdraw(id, data.key, n);
          if (!r.ok) this.ui.toastEl.show(r.reason, 'danger');
          g.changed();
        }
        if (action === 'bagAll') this.ui.result(g.survivors.depositAll(id));
        if (action === 'job') this.ui.result(g.survivors.setJob(id, data.job));
        if (action === 'heal') this.ui.result(g.survivors.heal(id));
        if (action === 'unequip') this.ui.result(g.equipment.unequip(id, data.slot));
        if (action === 'dismiss') {
          if (this.confirmDismiss(id)) m.close();
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
