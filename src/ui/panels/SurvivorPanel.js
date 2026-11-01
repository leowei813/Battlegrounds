import { formatDuration } from '../../utils/math.js';
import {
  CLASSES, JOBS, xpToNext, survivorRarityTable, FOOD_PER_SURVIVOR_HOUR, FOOD_PER_SURVIVOR_HOUR_OFFLINE,
} from '../../config/survivors.js';
import { RESOURCE_KEYS } from '../../config/constants.js';
import { SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS } from '../../config/supplies.js';
import { SLOT_KEYS, SLOTS } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import {
  btn, costHtml, survivorCard, itemCard, statLine, progressBar, rarityTag, hpBar, survivorStatus, metaOf,
} from '../components.js';
import {
  RARITIES, ITEM_MODELS, ITEM_TYPES, itemWeight, STACK_MAX,
} from '../../config/equipment.js';

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
      <small class="muted">可解放技能 ${g.survivors.skillSlots(c)}/${cls.skills.length}・${cls.skills[0].name}：${cls.skills[0].desc}</small>
      <div class="btn-row">${actions}</div>
    </div>`;
  }

  render() {
    const g = this.game;
    const st = g.state;
    const full = g.survivors.isFull();
    const now = Date.now();
    const stay = (at) => `<span class="tag">⏱ ${formatDuration(Math.max(0, (at || now) - now))}後離開</span>`;
    const pool = st.recruitPool.map((c) => this.candidateCard(c,
      `${btn('✅ 接納', 'accept', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full, title: full ? g.survivors.fullReason() : '' })}${btn('拒絕', 'reject', { id: c.id }, { cls: 'btn-sm btn-ghost' })}${stay(c.leaveAt)}`)).join('');
    const offer = (st.recruitOffer || []).map((c) => this.candidateCard(c,
      `${btn(`✅ 雇用 💰${g.survivors.hireCost(c).coins}`, 'pick', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full, title: full ? g.survivors.fullReason() : '' })}${stay(st.recruitOfferUntil)}`)).join('');
    const fullNote = full ? `<div class="card warn">🛏️ 人數已滿：${escapeHtml(g.survivors.fullReason())}。候選人會停留 1 小時，期間擴充宿舍或空出位置就能雇用。</div>` : '';
    const cost = g.survivors.currentRecruitCost();
    const board = (st.recruitBoard?.list || []).map((c) => this.candidateCard(c,
      btn(`✅ 雇用 💰${g.survivors.hireCost(c).coins}`, 'hire', { id: c.id }, { cls: 'btn-sm btn-primary', disabled: full }))).join('');
    const fmtOdds = (table) => Object.entries(table)
      .map(([r, p]) => `<span class="odd" style="--rc:${RARITIES[r].color}">${RARITIES[r].name} ${p < 1 ? p.toFixed(2) : p.toFixed(1)}%</span>`).join('');
    const tech = g.research.level('r_tech');
    const odds = fmtOdds(g.survivors.rarityOdds());
    const nextOdds = tech < 15 ? fmtOdds(survivorRarityTable(tech + 1)) : '';
    const oddsCard = `<div class="card odds-card"><b>🎲 招募品級機率</b> <small class="muted">（廣播招募、附近的倖存者、探索遇到的都適用）</small>
      <div class="odds">${odds}</div>
      <small class="muted block">研究「招募技術」可提高高品級機率：目前 Lv${tech}/15${tech < 15 ? '，升到下一級後：' : '（已滿級）'}</small>
      ${nextOdds ? `<div class="odds dim">${nextOdds}</div>` : ''}
      <small class="muted block">滿級時：${fmtOdds(survivorRarityTable(15))}</small></div>`;
    const cap = g.survivors.housingBreakdown();
    const list = st.survivors.map((sv) => survivorCard(g, sv, {
      actions: `${btn('詳情 / 裝備', 'detail', { id: sv.id }, { cls: 'btn-sm' })}${g.survivors.hpOf(sv) < g.survivors.maxHp(sv) ? btn('💊 治療', 'heal', { id: sv.id }, { cls: 'btn-sm btn-primary', disabled: g.survivors.isStarving(), title: g.survivors.isStarving() ? '飢餓中無法治療' : '' }) : ''}${sv.isLeader ? '' : btn('🚪 驅逐', 'dismiss', { id: sv.id }, { cls: 'btn-sm btn-ghost', disabled: sv.status === 'exploring' })}`,
    })).join('');
    const { net } = g.resources.rates();
    return `<div class="panel-inner">
      <h2>👥 倖存者 <small>${st.survivors.length}/${g.survivors.housing()} 人（上限 ${cap.max}）</small></h2>
      <p class="muted">人數上限 = 基本 ${cap.base} + 領袖等級 ÷ 5（${cap.leader}）+ 各據點等級（${cap.bases}），最多 ${cap.max} 人，且不能超過🛏️宿舍可住人數（${cap.dormLv ? `Lv${cap.dormLv}：${cap.dorm} 人` : `尚未建造：最多 ${cap.dorm} 人`}）。生命只會在據點內休息時回復，速度取決於🩺診療室等級（${g.shelter.maxLevel('clinic') ? `Lv${g.shelter.maxLevel('clinic')}` : '<b class="neg">尚未建造，不會自然回復</b>'}），主要仍需藥品治療。每人每小時吃 ${FOOD_PER_SURVIVOR_HOUR} 食物（離線時 ${FOOD_PER_SURVIVOR_HOUR_OFFLINE}），目前食物淨收入 <b class="${net.food < 0 ? 'neg' : 'pos'}">${net.food >= 0 ? '+' : ''}${net.food.toFixed(1)}/時</b>。</p>
      ${oddsCard}
      ${g.survivors.isStarving() ? '<div class="card warn">🍽️ <b>食物耗盡，全員飢餓中！</b>每分鐘流失 4% 生命直到重傷，飢餓時無法治療。重傷且持續飢餓滿遊戲內 3 天的隊員會永久死亡（領袖除外）。</div>' : ''}
      ${fullNote}
      ${offer ? `<h3>📻 招募候選人（三選一）</h3><div class="grid">${offer}</div><div class="btn-row">${btn('放棄此次招募（不退費）', 'abandon', {}, { cls: 'btn-ghost btn-sm' })}</div>` : `
      <div class="card row-between">
        <div><b>📻 廣播招募</b><small class="muted block">支付廣播費用後出現 3 位隨機職業與品級的倖存者，會停留 1 小時（現實時間）；選擇後還要支付雇用費，也可以放棄（廣播費用不退還）。人數已滿也可以廣播，等有空位再雇用。</small><div class="costs">${costHtml(st, cost)}</div></div>
        ${btn('招募', 'recruit', {}, { cls: 'btn-primary' })}
      </div>`}
      ${pool ? `<h3>🙋 等待加入（探索中遇到，停留 1 小時）</h3><div class="grid">${pool}</div>` : ''}
      <h3>🏕️ 附近的倖存者 <small class="muted">每小時更新（${formatDuration(Math.max(0, st.recruitBoard.refreshAt - Date.now()))}後）・雇用需支付金錢</small></h3>
      <div class="grid">${board || '<p class="muted">目前沒有人。</p>'}</div>
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
    if (action === 'heal') this.openHeal(data.id);
    if (action === 'dismiss') this.confirmDismiss(data.id);
    if (action === 'detail') this.openDetail(data.id);
  }

  confirmDismiss(id) {
    const sv = this.game.survivors.get(id);
    if (!sv) return false;
    if (!confirm(`確定驅逐「${sv.name}」？此動作無法復原，身上的裝備會留在背包。`)) return false;
    return this.ui.result(this.game.survivors.dismiss(id)).ok;
  }

  /** 工作說明：每項工作的內容與這位倖存者的每小時產出 */
  jobsHelp(sv) {
    const lvMul = 1 + sv.level * 0.03;
    const rows = Object.entries(JOBS).map(([jid, j]) => {
      const mul = (j.classBonus?.[sv.classId] || 1) * lvMul;
      const out = Object.entries(j.produce).map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name} ${(v * mul).toFixed(1)}`).join('、');
      return `<li class="${sv.job === jid ? 'on' : ''}"><b>${j.icon} ${j.name}</b>${j.classBonus?.[sv.classId] ? ` <span class="tag">本職業 ×${j.classBonus[sv.classId]}</span>` : ''}：${j.desc || ''}${out ? `<small class="muted block">每小時約：${out}</small>` : ''}</li>`;
    }).join('');
    const cur = JOBS[sv.job] || JOBS.idle;
    return `<div class="job-now">${cur.icon} <b>${cur.name}</b>：${cur.desc || ''}</div>
      <details class="job-help"><summary>ℹ️ 所有工作說明（含這位倖存者的每小時產出）</summary><ul class="skill-list">${rows}</ul></details>`;
  }

  detailBody(id) {
    const g = this.game;
    const sv = g.survivors.get(id);
    if (!sv) return '<p>已離開</p>';
    const cls = CLASSES[sv.classId];
    const s = g.survivors.stats(sv);
    const now = Date.now();
    const slots = g.survivors.skillSlots(sv);
    const skills = cls.skills.map((sk, i) => {
      const locked = i >= slots;
      const on = !locked && sv.level >= sk.unlock;
      return `<li class="${on ? 'on' : 'off'}"><b>${sk.name}</b>（Lv${sk.unlock}）${sk.desc}${locked ? ' <span class="tag">🔒 品級不足</span>' : ''}</li>`;
    }).join('');
    const slots = SLOT_KEYS.map((slot) => {
      const item = g.equipment.getItem(sv.equipment[slot]);
      return `<div class="equip-slot">
        <div class="row-between"><small>${SLOTS[slot].icon} ${SLOTS[slot].name}</small>
        <span>${btn('更換', 'pickItem', { slot }, { cls: 'btn-xs', disabled: !this.candidates(sv.id, slot).length, title: this.candidates(sv.id, slot).length ? '' : '沒有可以裝備的物品' })}${item ? btn('卸下', 'unequip', { slot }, { cls: 'btn-xs btn-ghost' }) : ''}</span></div>
        ${item ? itemCard(item, { compact: true }) : '<div class="muted">— 空 —</div>'}
      </div>`;
    }).join('');
    const jobs = Object.entries(JOBS).map(([jid, j]) => {
      const bonus = j.classBonus?.[sv.classId];
      return `<button class="chip ${sv.job === jid ? 'active' : ''}" data-action="job" data-job="${jid}" title="${escapeHtml(j.desc || '')}">${j.icon} ${j.name}${bonus ? ` ×${bonus}` : ''}</button>`;
    }).join('');
    const hurt = g.survivors.hpOf(sv) < g.survivors.maxHp(sv);
    const starving = g.survivors.isStarving();
    void now;
    return `
      <div class="sv-detail" style="--cc:${cls.color}">
        <div class="sv-head"><span class="sv-icon big">${cls.icon}</span><div><b>${escapeHtml(sv.name)}</b> ${sv.isLeader ? '👑 領袖' : ''}<small class="block">${sv.isLeader ? '' : rarityTag(sv.rarity)} ${cls.name} Lv${sv.level}・戰力 ${s.power}・升級成長 ×${g.survivors.growthMul(sv)}</small></div>${survivorStatus(g, sv)}</div>
        ${hpBar(g, sv)}
        ${progressBar(sv.xp / xpToNext(sv.level), 'xp', `XP ${sv.xp}/${xpToNext(sv.level)}`)}
        <div class="stat-line">${statLine({ hp: s.hp, atk: s.atk, def: s.def, crit: s.crit, critDmg: s.critDmg - 1, dodge: s.dodge })}<span>攻速 ${s.atkSpeed}</span></div>
        ${hurt ? `<div class="heal-box ${sv.severe ? 'warn' : ''}"><div class="row-between">${sv.severe ? '🩸 重傷：無法行動，生命回到 30% 才能脫離' : '🩹 受傷：有診療室或醫生照護時才會慢慢恢復，也可以直接用藥'}${starving ? '<span class="tag tag-red">🍽️ 飢餓中無法治療</span>' : ''}</div>
        ${starving ? '' : `<div class="label">💊 治療：選擇要使用的藥品</div>${this.medsHtml(sv)}`}</div>` : ''}
        <h4>技能 <small class="muted">（品級可解放 ${slots}/${cls.skills.length} 個）</small></h4><ul class="skill-list">${skills}</ul>
        <h4>工作指派 <small class="muted">（閒置在避難所時生效）</small></h4><div class="chips">${jobs}</div>
        ${this.jobsHelp(sv)}
        <h4>裝備</h4><div class="equip-grid">${slots}</div>
        ${this.bagHtml(sv)}
        ${sv.isLeader ? '' : `<div class="btn-row end">${btn('🚪 驅逐', 'dismiss', {}, { cls: 'btn-ghost btn-sm', disabled: sv.status === 'exploring' })}</div>`}
      </div>`;
  }

  /** 可使用的藥品：每種藥品回復不同比例的生命（大型醫藥箱 100%），由玩家選擇要用哪一種 */
  medsHtml(sv) {
    const g = this.game;
    const meds = g.survivors.medicines(sv).filter((m) => m.bag > 0 || g.survivors.atShelter(sv));
    if (!meds.length) return `<p class="muted">沒有可用的藥品${g.survivors.atShelter(sv) ? '' : '（不在避難所時只能用身上帶的）'}。探索住宅、商店、超市、醫院可找到紗布、繃帶、醫藥箱等。</p>`;
    const lost = g.survivors.maxHp(sv) - g.survivors.hpOf(sv);
    return `<div class="med-list">${meds.map((m) => {
      const amt = Math.round(g.survivors.healAmount(sv, m.key));
      const where = [m.bag ? `身上 ${m.bag}` : '', m.store && g.survivors.atShelter(sv) ? `倉庫 ${m.store}` : ''].filter(Boolean).join('・');
      return `<button class="med-btn" data-action="heal" data-key="${m.key}">
        <span class="med-icon">${m.icon}</span><span class="grow"><b>${m.name}</b><small class="muted block">回復 ${Math.round(m.heal * 100)}%（+${amt}${amt > lost ? `，會溢出 ${amt - Math.round(lost)}` : ''}）・${where}</small></span></button>`;
    }).join('')}</div>`;
  }

  /** 治療彈窗：選擇藥品；生命回滿後自動關閉 */
  openHeal(id) {
    const g = this.game;
    const body = () => {
      const sv = g.survivors.get(id);
      if (!sv) return '<p class="muted">找不到倖存者</p>';
      return `${hpBar(g, sv)}
        ${g.survivors.isStarving() ? '<p class="tag tag-red">🍽️ 飢餓中無法治療，請先補充食物</p>' : this.medsHtml(sv)}`;
    };
    this.ui.modal.open({
      title: `💊 治療：${escapeHtml(g.survivors.get(id)?.name || '')}`,
      body: body(),
      onAction: (action, data, m) => {
        if (action !== 'heal') return;
        const r = this.ui.result(g.survivors.heal(id, data.key));
        const sv = g.survivors.get(id);
        if (r.ok && sv && g.survivors.hpOf(sv) >= g.survivors.maxHp(sv)) {
          m.close();
          return;
        }
        m.update(body());
      },
    });
  }

  /**
   * 個人背包（資源與負重）；在避難所時右側顯示倉庫，可存入／取出。
   * 倉庫的每種基本物資都是固定格子，只能改變存取數量。
   */
  bagHtml(sv) {
    const g = this.game;
    const eq = g.equipment;
    const bag = g.survivors.bagOf(sv);
    const load = g.survivors.bagLoad(sv);
    const cap = g.survivors.bagCap(sv);
    const home = g.survivors.atShelter(sv);
    const slots = eq.bagSlotCap(sv);
    // 背包格子：每件裝備一格；同種類消耗品堆疊在一格
    const cells = [
      // 每格最多堆疊 999，超過時分成多格顯示
      ...Object.keys(bag).filter((k) => bag[k] > 0).flatMap((k) => Array.from({ length: Math.ceil(bag[k] / STACK_MAX) }, (_, i) => [k, Math.min(STACK_MAX, bag[k] - i * STACK_MAX)])).map(([k, qty]) => `
        <div class="slot-cell stack">
          <div class="slot-main"><span class="slot-icon">${metaOf(k).icon}</span><b>${metaOf(k).name}</b><span class="slot-qty">×${Math.floor(qty)}</span></div>
          ${home ? `<div class="slot-ctrl"><input type="number" min="1" step="1" value="${Math.floor(bag[k])}" inputmode="numeric" aria-label="數量">
            ${btn('存入倉庫', 'bagIn', { key: k }, { cls: 'btn-xs' })}${btn('全部', 'bagInAll', { key: k }, { cls: 'btn-xs btn-ghost' })}</div>` : ''}
        </div>`),
      ...eq.bagItems(sv).map((it) => `
        <div class="slot-cell item" style="--rc:${RARITIES[it.rarity].color}">
          <div class="slot-main"><span class="slot-icon">${ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔'}</span><b>${escapeHtml(it.name)}</b><small class="muted">戰力 ${it.power}・⚖️${itemWeight(it)}</small></div>
          <div class="slot-ctrl">${btn('裝備', 'equipBag', { item: it.id }, { cls: 'btn-xs btn-primary' })}${home ? btn('存入倉庫', 'itemToStore', { item: it.id }, { cls: 'btn-xs' }) : ''}</div>
        </div>`),
    ];
    while (cells.length < slots) cells.push('<div class="slot-cell empty">空</div>');
    return `<h4>🎒 背包 <small class="muted">${eq.bagSlotsUsed(sv)} / ${slots} 格・負重 ${Math.floor(load)} / ${cap}</small></h4>
      ${progressBar(cap ? load / cap : 0, load >= cap ? 'danger' : '', `負重 ${Math.floor(load)}/${cap}`)}
      <div class="slot-grid-bag">${cells.join('')}</div>
      <small class="muted block">每件裝備佔 1 格、不可堆疊；同種類消耗品每格最多堆疊 ${STACK_MAX}。背包裝備可增加格數與負重。</small>
      ${home ? `<div class="btn-row">${btn('📦 從倉庫拿取', 'pickFromStore', {}, { cls: 'btn-sm btn-primary' })}${eq.bagSlotsUsed(sv) ? btn('全部存入倉庫', 'bagAll', {}, { cls: 'btn-sm' }) : ''}</div>` : '<p class="muted">不在避難所，無法存取倉庫。</p>'}`;
  }

  openDetail(id) {
    const g = this.game;
    this.ui.modal.open({
      title: '倖存者資料',
      wide: true,
      body: this.detailBody(id),
      live: () => this.detailBody(id),
      onAction: (action, data, m, el) => {
        if (action === 'bagIn' || action === 'bagInAll') {
          const n = action === 'bagInAll' ? Infinity : Math.max(1, Math.floor(+el.closest('.slot-cell').querySelector('input').value || 1));
          const r = g.survivors.deposit(id, data.key, n);
          if (!r.ok) this.ui.toastEl.show(r.reason, 'danger');
          g.changed();
        }
        if (action === 'bagAll') {
          const sv = g.survivors.get(id);
          const r = g.survivors.depositAll(id);
          g.equipment.bagItems(sv).forEach((it) => g.equipment.moveToStore(it.id));
          this.ui.result(r.ok || !g.equipment.bagItems(sv).length ? { ok: true, msg: '已存入倉庫' } : r);
        }
        if (action === 'equipBag') this.ui.result(g.equipment.equip(id, data.item));
        if (action === 'itemToStore') this.ui.result(g.equipment.moveToStore(data.item));
        if (action === 'pickFromStore') {
          this.pickFromStore(id);
          return;
        }
        if (action === 'job') this.ui.result(g.survivors.setJob(id, data.job));
        if (action === 'heal') this.ui.result(g.survivors.heal(id, data.key || null));
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

  /** 從倉庫拿取：消耗品可選數量或全部；裝備一件一格 */
  pickFromStore(svId) {
    const g = this.game;
    const eq = g.equipment;
    const body = () => {
      const sv = g.survivors.get(svId);
      const res = g.state.resources;
      const head = `<div class="btn-row">${btn('← 返回背包', 'back', {}, { cls: 'btn-sm' })}</div><p class="muted">${escapeHtml(sv?.name || '')} 的背包 ${eq.bagSlotsUsed(sv)} / ${eq.bagSlotCap(sv)} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))} / ${g.survivors.bagCap(sv)}</p>`;
      const stack = (k, have) => `
        <div class="slot-cell stack">
          <div class="slot-main"><span class="slot-icon">${metaOf(k).icon}</span><b>${metaOf(k).name}</b><span class="slot-qty">倉庫 ${Math.floor(have)}</span></div>
          <div class="slot-ctrl"><input type="number" min="1" step="1" value="10" inputmode="numeric" aria-label="數量">
            ${btn('放入背包', 'take', { key: k }, { cls: 'btn-xs btn-primary' })}${btn('全部', 'takeAll', { key: k }, { cls: 'btn-xs btn-ghost' })}</div>
        </div>`;
      const stacks = RESOURCE_KEYS.filter((k) => res[k] >= 1).map((k) => stack(k, res[k])).join('');
      const sup = g.state.supplies || {};
      const supplyHtml = Object.entries(SUPPLY_CATS).map(([cat, c]) => {
        const keys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === cat && sup[k] > 0);
        return keys.length ? `<h4>${c.icon} ${c.name}</h4><div class="slot-grid-bag">${keys.map((k) => stack(k, sup[k])).join('')}</div>` : '';
      }).join('');
      const list = eq.storeItems();
      const items = list.map((it) => itemCard(it, { compact: true, actions: btn('放入背包', 'takeItem', { id: it.id }, { cls: 'btn-xs btn-primary' }) })).join('');
      return `${head}<h4>🥫 消耗品</h4><div class="slot-grid-bag">${stacks || '<p class="muted">倉庫沒有消耗品。</p>'}</div>${supplyHtml}
        <h4>🎒 裝備（倉庫 ${eq.storeUsed()} / ${eq.storeCap()} 格）</h4><div class="grid">${items || '<p class="muted">倉庫沒有裝備。</p>'}</div>`;
    };
    this.ui.modal.open({
      title: '📦 從倉庫拿取',
      wide: true,
      body: body(),
      onAction: (action, data, m, el) => {
        if (action === 'back') {
          this.openDetail(svId);
          return;
        }
        let r = null;
        if (action === 'take' || action === 'takeAll') {
          const n = action === 'takeAll' ? Infinity : Math.max(1, Math.floor(+el.closest('.slot-cell').querySelector('input').value || 1));
          r = g.survivors.withdraw(svId, data.key, n);
        }
        if (action === 'takeItem') r = eq.moveToBag(data.id, svId);
        if (r && !r.ok) this.ui.toastEl.show(r.reason, 'danger');
        g.changed();
        m.update(body());
      },
    });
  }

  /** 可換上的裝備：同部位、不是這位倖存者身上已穿的（其他人身上的也可以換過來） */
  candidates(svId, slot) {
    const g = this.game;
    return g.state.inventory.items.filter((i) => i.slot === slot && g.equipment.equippedBy(i.id)?.id !== svId);
  }

  /** 裝備選擇頁：有返回按鈕，返回時回到倖存者的裝備頁 */
  pickItem(svId, slot) {
    const g = this.game;
    const sv = g.survivors.get(svId);
    const cur = g.equipment.getItem(sv?.equipment[slot]);
    const body = () => {
      const items = this.candidates(svId, slot).sort((a, b) => b.power - a.power);
      const list = items.length
        ? items.map((it) => {
          const owner = g.equipment.equippedBy(it.id);
          const carrier = !owner && it.loc && it.loc !== 'store' ? g.survivors.get(it.loc) : null;
          const diff = it.power - (cur?.power || 0);
          return itemCard(it, {
            equippedBy: owner,
            carrier,
            actions: `${btn('裝備', 'equip', { id: it.id }, { cls: 'btn-sm btn-primary' })}<span class="${diff >= 0 ? 'pos' : 'neg'}">戰力 ${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`,
          });
        }).join('')
        : '<p class="muted">沒有可以裝備的物品。</p>';
      return `<div class="btn-row">${btn('← 返回', 'back', {}, { cls: 'btn-sm' })}</div>
        <p class="muted">${escapeHtml(sv?.name || '')} 目前的${SLOTS[slot].name}：${cur ? `<b>${escapeHtml(cur.name)}</b>（戰力 ${cur.power}）` : '無'}</p>
        <div class="grid">${list}</div>`;
    };
    this.ui.modal.open({
      title: `${SLOTS[slot].icon} 選擇${SLOTS[slot].name}`,
      wide: true,
      body: body(),
      onAction: (action, data, m) => {
        if (action === 'back') {
          this.openDetail(svId);
          return;
        }
        if (action === 'equip') {
          const r = this.ui.result(g.equipment.equip(svId, data.id));
          if (r.ok) this.openDetail(svId);
          else m.update(body());
        }
      },
    });
  }
}
