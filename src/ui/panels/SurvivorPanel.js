import { formatDuration } from '../../utils/math.js';
import {
  CLASSES, JOBS, QUALITY_KEYS, QUALITY_NAMES, xpToNext, survivorRarityTable, FOOD_PER_SURVIVOR_HOUR, FOOD_PER_SURVIVOR_HOUR_OFFLINE, FOOD_LEVEL_STEP, MAX_SURVIVORS,
} from '../../config/survivors.js';
import { RESOURCE_KEYS } from '../../config/constants.js';
import { SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS, unitWeight } from '../../config/supplies.js';
import { SLOT_KEYS, SLOTS } from '../../config/equipment.js';
import { escapeHtml } from '../../utils/dom.js';
import { LOADOUT_MAX } from '../../systems/SurvivorSystem.js';
import {
  btn, costHtml, survivorCard, compareHtml, itemCard, statLine, progressBar, rarityTag, hpBar, survivorStatus, metaOf, affixChips, towerTag,
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

  /** 素質標籤：100% 以金色顯示 */
  qTag(q, label = '素質') {
    return `<span class="sv-q ${q >= 100 ? 'max' : ''}">${label} ${q}%</span>`;
  }

  /** 能力卡：每項能力的數值與素質（首領不顯示素質） */
  abilityRows(sv, s) {
    const g = this.game;
    const fmt = {
      hp: () => s.hp, atk: () => s.atk, def: () => s.def,
      crit: () => `${(s.crit * 100).toFixed(1)}%`, dodge: () => `${(s.dodge * 100).toFixed(1)}%`, atkSpeed: () => s.atkSpeed,
    };
    return `<div class="ab-rows">${QUALITY_KEYS.map((k) => {
      const q = g.survivors.qualityOf(sv, k);
      const per = ['hp', 'atk', 'def'].includes(k) ? `每級 +${g.survivors.growthPerLevel(sv, k).toFixed(1)}` : '';
      return `<div class="ab-row ${sv.isLeader ? 'leader' : ''}"><span class="muted">${QUALITY_NAMES[k]}</span><b>${fmt[k]()}</b>
        ${sv.isLeader ? `<small class="muted">${per}</small>` : `<span class="ab-bar ${q >= 100 ? 'max' : q >= 70 ? 'hi' : q >= 40 ? 'mid' : ''}"><i style="width:${q}%"></i></span>
        <span class="ab-q ${q >= 100 ? 'max' : ''}">素質 ${q}% <small class="muted">${per}</small></span>`}</div>`;
    }).join('')}</div>`;
  }

  /** 候選人的能力格：每格同時顯示數值與素質（素質條＋百分比，100% 金色） */
  abilityGrid(sv, s) {
    const g = this.game;
    const val = {
      hp: s.hp, atk: s.atk, def: s.def, crit: `${(s.crit * 100).toFixed(1)}%`, dodge: `${(s.dodge * 100).toFixed(1)}%`, atkSpeed: s.atkSpeed,
    };
    const avg = g.survivors.avgQuality(sv);
    const cls = (q) => (q >= 100 ? 'max' : q >= 70 ? 'hi' : q >= 40 ? 'mid' : 'lo');
    return `<div class="ab-grid-head"><span>能力</span><span class="ab-avg ${cls(avg)}">平均素質 <b>${avg}%</b></span></div>
      <div class="ab-grid">${QUALITY_KEYS.map((k) => {
        const q = g.survivors.qualityOf(sv, k);
        return `<div class="ab-cell ${cls(q)}"><small>${QUALITY_NAMES[k]}</small><b>${val[k]}</b>
          <span class="ab-bar ${q >= 100 ? 'max' : q >= 70 ? 'hi' : q >= 40 ? 'mid' : ''}"><i style="width:${q}%"></i></span><small class="ab-cq">素質 ${q}%</small></div>`;
      }).join('')}</div>
      <small class="muted ab-legend">素質 0～100%：越高能力與升級成長越好（招募後不會改變）</small>`;
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
      ${this.abilityGrid(c, s)}
      <small class="muted">可解放技能 ${g.survivors.skillSlots(c)}/${cls.skills.length}・${cls.skills[0].name}：${cls.skills[0].desc}</small>
      <div class="btn-row">${actions}</div>
    </div>`;
  }

  /** 招募頁（列表下方的「招募倖存者」） */
  recruitHtml() {
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
    const nextOdds = tech < 15 ? fmtOdds(survivorRarityTable(tech + 1)) : '';
    const cap = g.survivors.housingBreakdown();
    const { net } = g.resources.rates();
    return `<div class="sv-pane-head">${btn('‹ 返回', 'svBack', {}, { cls: 'btn-sm sv-back' })}<h3>📻 招募倖存者</h3></div>
      ${fullNote}
      ${offer ? `<h4>📻 招募候選人（三選一）</h4><div class="grid">${offer}</div><div class="btn-row">${btn('放棄此次招募（不退費）', 'abandon', {}, { cls: 'btn-ghost btn-sm' })}</div>` : `
      <div class="card row-between">
        <div><b>📻 廣播招募</b><small class="muted block">支付廣播費用後出現 3 位隨機職業與品級的倖存者，會停留 1 小時；選擇後還要支付雇用費，也可以放棄（廣播費用不退還）。</small><div class="costs">${costHtml(st, cost)}</div></div>
        ${btn('招募', 'recruit', {}, { cls: 'btn-primary' })}
      </div>`}
      ${pool ? `<h4>🙋 等待加入（探索中遇到，停留 1 小時）</h4><div class="grid">${pool}</div>` : ''}
      <h4>🏕️ 附近的倖存者 <small class="muted">每小時更新（${formatDuration(Math.max(0, st.recruitBoard.refreshAt - Date.now()))}後）</small></h4>
      <div class="grid">${board || '<p class="muted">目前沒有人。</p>'}</div>
      <div class="card odds-card"><b>🎲 招募品級機率</b>
        <div class="odds">${fmtOdds(g.survivors.rarityOdds())}</div>
        <small class="muted block">研究「招募技術」可提高高品級機率：目前 Lv${tech}/15${tech < 15 ? '，升到下一級後：' : '（已滿級）'}</small>
        ${nextOdds ? `<div class="odds dim">${nextOdds}</div>` : ''}
      </div>
      <details class="civ-more" data-keep="cap" ${this.keepOpen?.cap ? 'open' : ''}><summary>人數上限與食物說明</summary><p class="muted">人數上限 = 基本 ${cap.base} + 領袖等級 ÷ 3（${cap.leader}），最多 ${cap.max} 人，且不能超過🛏️宿舍可住人數（${cap.dormLv ? `Lv${cap.dormLv}：${cap.dorm} 人` : `尚未建造：最多 ${cap.dorm} 人`}）。生命只會在據點內休息時回復，速度取決於🩺診療室等級。每人每小時吃 ${FOOD_PER_SURVIVOR_HOUR} 食物（離線時 ${FOOD_PER_SURVIVOR_HOUR_OFFLINE}），等級越高吃得越多（每高 1 級 +${Math.round(FOOD_LEVEL_STEP * 100)}%），目前食物淨收入 ${net.food >= 0 ? '+' : ''}${net.food.toFixed(1)}/時。</p></details>`;
  }

  /** 列表中每位倖存者的狀態分類 */
  stateOf(sv) {
    if (sv.severe) return 'hurt';
    if (sv.status === 'exploring') return 'out';
    return 'home';
  }

  /** 卡片血條：8px 粗條＋生命（一律顯示 目前/上限），依血量變色 */
  hpRow(sv, ratio) {
    const g = this.game;
    const r = Math.max(0, Math.min(1, ratio));
    const pct = Math.round(r * 100);
    const cls = r >= 0.7 ? 'ok' : r >= 0.3 ? 'mid' : 'low';
    return `<span class="sv-mini-hp-row"><span class="sv-mini-hp"><i style="width:${pct}%" class="${cls}"></i></span><b class="sv-mini-hpn ${cls}">❤️ ${Math.floor(g.survivors.hpOf(sv))}/${g.survivors.maxHp(sv)}</b></span>`;
  }

  /**
   * 列表的小卡片（一列兩位），每張固定 5 行：
   * ①名字＋品級＋狀態 ②職業 Lv・戰力 ③血條 ④目前在做什麼（外出顯示倒數；在家右側為換裝按鈕） ⑤背包・素質
   */
  rosterCard(sv) {
    const g = this.game;
    const cls = CLASSES[sv.classId];
    const s = g.survivors.stats(sv);
    const hp = g.survivors.hpOf(sv) / g.survivors.maxHp(sv);
    const k = this.stateOf(sv);
    const exp = k === 'out' ? g.state.expeditions.find((e) => e.memberIds.includes(sv.id)) : null;
    const act = k === 'hurt'
      ? '<span class="sv-mini-job hurt">🩸 重傷・需要治療</span>'
      : exp
        ? `<span class="sv-mini-job cd">⏱ ${formatDuration(Math.max(0, exp.endAt - Date.now()))}</span>`
        : `<span class="sv-mini-job">${JOBS[sv.job]?.icon || ''} ${JOBS[sv.job]?.name || '閒置'}</span>${towerTag(g, sv)}`;
    const tag = { home: '<span class="sv-tag home">在家</span>', out: '<span class="sv-tag out">外出</span>', hurt: '<span class="sv-tag hurt">重傷</span>' }[k];
    const load = Math.floor(g.survivors.bagLoad(sv));
    const r = sv.isLeader ? '#ffd54f' : (RARITIES[sv.rarity] || RARITIES.common).color;
    const qe = sv.status === 'idle' ? `<span class="sv-qe">
        <span class="sv-qe-btn up" role="button" data-action="miniQuickEquip" data-id="${sv.id}" title="快速換裝">👕<i>▲</i></span>
        <span class="sv-qe-btn down" role="button" data-action="miniQuickUnequip" data-id="${sv.id}" title="快速脫裝">👕<i>▼</i></span></span>` : '';
    return `<button class="sv-mini v2 ${this.selId === sv.id ? 'on' : ''}" data-action="selSv" data-id="${sv.id}" data-sv="${sv.id}" style="--rc:${r}" title="長按可拖移調整順序">
      <span class="sv-mini-top"><b>${cls.icon} ${escapeHtml(sv.name)}${sv.isLeader ? ' 👑' : ''}</b>${sv.isLeader ? '' : rarityTag(sv.rarity)}<i class="sv-mini-sp"></i>${tag}</span>
      <small class="muted sv-mini-sub">${cls.name} Lv${sv.level}・戰力 <b>${s.power}</b></small>
      ${this.hpRow(sv, hp)}
      <span class="sv-mini-act"><span class="sv-mini-actl">${act}</span>${qe}</span>
      <span class="sv-mini-foot"><small class="muted">🎒 ${load}/${g.survivors.bagCap(sv)}</small>${sv.isLeader ? '' : this.qTag(g.survivors.avgQuality(sv))}</span>
    </button>`;
  }

  /**
   * 拖移排序：長按卡片（約 0.45 秒）後拖到其他卡片上放開（滑鼠與觸控共用 Pointer 事件）。
   * 長按前移動手指就當作一般捲動。
   */
  bindDrag() {
    const root = this.ui.panelEl;
    if (!root || this.dragBound) return;
    this.dragBound = true;
    const HOLD_MS = 450;
    let drag = null;
    let hold = null;
    const clear = () => root.querySelectorAll('.sv-mini.drop-before, .sv-mini.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    // 長按期間暫停畫面每秒重繪（否則按住的卡片會被換掉）
    const cancelHold = () => { if (hold) { clearTimeout(hold.timer); if (!drag) this.ui.dragging = false; } hold = null; };
    root.addEventListener('pointerdown', (e) => {
      let card = e.target.closest?.('.sv-mini[data-sv]');
      if (!card || e.target.closest('.sv-qe-btn') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      cancelHold();
      const sid = card.dataset.sv;
      this.ui.dragging = true;
      hold = { x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => {
        const h = hold;
        hold = null;
        card = card.isConnected ? card : root.querySelector(`.sv-mini[data-sv="${sid}"]`);
        if (!h || !card) { this.ui.dragging = false; return; }
        drag = { id: card.dataset.sv, card, target: null, after: false };
        card.classList.add('dragging');
        this.ui.dragging = true;
        navigator.vibrate?.(30);
        try { card.setPointerCapture?.(h.id); } catch { /* 已放開 */ }
      }, HOLD_MS) };
    });
    // 拖移中擋掉觸控捲動
    root.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    root.addEventListener('contextmenu', (e) => { if (drag || e.target.closest?.('.sv-mini[data-sv]')) e.preventDefault(); });
    root.addEventListener('pointermove', (e) => {
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) cancelHold();
      if (!drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sv-mini');
      clear();
      if (!el || el === drag.card || !el.dataset.sv) { drag.target = null; return; }
      const r = el.getBoundingClientRect();
      // 兩欄排列：依滑到卡片的左右（同一列）或上下半決定放在前面或後面
      drag.after = e.clientY > r.top + r.height * 0.75 || (e.clientY > r.top + r.height * 0.25 && e.clientX > r.left + r.width / 2);
      drag.target = el.dataset.sv;
      el.classList.add(drag.after ? 'drop-after' : 'drop-before');
    });
    const end = () => {
      cancelHold();
      if (!drag) return;
      const d = drag;
      drag = null;
      this.ui.dragging = false;
      d.card.classList.remove('dragging');
      clear();
      // 拖移結束後擋掉這次點擊（不要打開詳情）
      this.dragEndAt = Date.now();
      if (d.target && this.game.survivors.move(d.id, d.target, d.after).ok) this.game.requestSave(); // 順序立即存檔
      this.ui.refresh(true);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }

  render() {
    this.bindDrag();
    const g = this.game;
    const st = g.state;
    const list = st.survivors;
    if (!list.some((sv) => sv.id === this.selId)) this.selId = list[0]?.id || null;
    const filter = this.filter || 'all';
    const counts = { home: 0, out: 0, hurt: 0 };
    list.forEach((sv) => { counts[this.stateOf(sv)] += 1; });
    const shown = list.filter((sv) => filter === 'all' || this.stateOf(sv) === filter);
    const chip = (id, label) => `<button class="chip ${filter === id ? 'active' : ''}" data-action="svFilter" data-f="${id}">${label}</button>`;
    const recruitAll = [...(st.recruitOffer || []), ...(st.recruitPool || []), ...(st.recruitBoard?.list || [])];
    const recruitN = recruitAll.length;
    const recruitLegend = recruitAll.some((c) => c.rarity === 'legendary');
    const roster = `<aside class="sv-roster">
      <div class="sv-roster-head"><h3>👥 倖存者 ${list.length}/${g.survivors.housing()}</h3>${(() => { const n = g.survivors.healableAtHome().length; return `<button class="sv-heal-chip ${n ? '' : 'off'}" data-action="healAll" ${n ? '' : 'disabled'} title="${n ? `用倉庫的藥品，從低階開始治療 ${n} 位在家、生命沒滿的倖存者（不溢出）` : '沒有需要治療的人，或倉庫沒有不會溢出的藥品'}">💊 全員治療${n ? ` <span class="n">${n}</span>` : ''}</button>`; })()}<button class="sv-recruit-chip ${this.view === 'recruit' ? 'on' : ''} ${recruitLegend ? 'legend' : ''}" data-action="svRecruit" title="${recruitLegend ? '有傳說倖存者等待招募！' : '可招募的候選人數'}">📻 招募 <span class="n">${recruitN}</span></button></div>
      ${g.survivors.housing() >= MAX_SURVIVORS && list.length >= MAX_SURVIVORS ? `<div class="sv-max-note">已達最高人數 ${MAX_SURVIVORS} 人（領袖 Lv15、宿舍 Lv7 以上）。宿舍繼續升級可提升休息回復、減少食物消耗、增加招募候選人。</div>` : ''}
      <div class="chips">${chip('all', '全部')}${chip('home', `在家 ${counts.home}`)}${chip('out', `外出 ${counts.out}`)}${chip('hurt', `重傷 ${counts.hurt}`)}</div>
      ${g.survivors.isStarving() ? '<div class="card warn">🍽️ <b>食物耗盡，全員飢餓中！</b>每分鐘流失 4% 生命直到重傷；飢餓時仍可治療，但生命會持續流失。</div>' : ''}
      <div class="sv-mini-grid">${shown.map((sv) => this.rosterCard(sv)).join('') || '<p class="muted">沒有符合的倖存者。</p>'}</div>
    </aside>`;
    const pane = this.view === 'recruit' ? this.recruitHtml() : this.detailBody(this.selId);
    return `<div class="sv-layout ${this.paneOpen ? 'pane-open' : ''}">${roster}<section class="sv-pane">${pane}</section></div>`;
  }

  onAction(action, data, el) {
    const g = this.game;
    const id = this.selId;
    const sel = (k) => this.ui.panelEl?.querySelector(k);
    if (action === 'selSv') {
      if (Date.now() - (this.dragEndAt || 0) < 400 || el?.closest?.('.sv-drag') || data.drag) return;
      this.selId = data.id;
      this.view = 'detail';
      this.paneOpen = true;
      this.bagSel = null;
      this.ui.refresh(true);
      this.ui.panelEl.scrollTop = 0;
      return;
    }
    if (action === 'svFilter') this.filter = data.f;
    if (action === 'svRecruit') {
      this.view = 'recruit';
      this.paneOpen = true;
      this.ui.refresh(true);
      this.ui.panelEl.scrollTop = 0;
      return;
    }
    if (action === 'svBack') {
      this.paneOpen = false;
      this.view = 'detail';
    }
    if (action === 'svTab') this.tab = data.t;
    if (action === 'accept') this.ui.result(g.survivors.acceptCandidate(data.id));
    if (action === 'reject') this.ui.result(g.survivors.rejectCandidate(data.id));
    if (action === 'recruit') this.ui.result(g.survivors.recruitRoll());
    if (action === 'pick') this.ui.result(g.survivors.pickRecruit(data.id));
    if (action === 'hire') this.ui.result(g.survivors.hireFromBoard(data.id));
    if (action === 'abandon' && confirm('放棄此次招募？已支付的費用不會退還。')) this.ui.result(g.survivors.abandonRecruit());
    if (action === 'healOpen') this.openHeal(id);
    if (action === 'dismiss') {
      if (this.confirmDismiss(id)) this.paneOpen = false;
    }
    // 背包：點格子選取，下方操作區處理
    if (action === 'bagSel') this.bagSel = this.bagSel === data.k ? null : data.k;
    const qty = () => Math.max(1, Math.floor(Number(sel('.bag-qty')?.value) || 1));
    if (action === 'bagStep') {
      const input = sel('.bag-qty');
      if (input) {
        const max = Number(input.max) || 1;
        this.bagQty = Math.min(max, Math.max(1, qty() + Number(data.d)));
      }
    }
    if (action === 'bagMax') this.bagQty = Number(sel('.bag-qty')?.max) || 1;
    if (action === 'bagIn') {
      const r = g.survivors.deposit(id, data.key, qty());
      if (!r.ok) this.ui.toastEl.show(r.reason, 'danger');
    }
    if (action === 'bagDrop') {
      const n = qty();
      if (confirm(`確定丟棄 ${metaOf(data.key).name}×${n}？丟棄後無法復原。`)) this.ui.result(g.survivors.discardBag(id, data.key, n));
    }
    if (action === 'bagAll') {
      const sv = g.survivors.get(id);
      const r = g.survivors.depositAll(id);
      g.equipment.bagItems(sv).forEach((it) => g.equipment.moveToStore(it.id));
      this.ui.result(r.ok || !g.equipment.bagItems(sv).length ? { ok: true, msg: '已存入倉庫' } : r);
    }
    if (action === 'bagDismantle') {
      const it = g.equipment.getItem(data.item);
      if (it && confirm(`確定拆解「${it.name}」？`)) this.ui.result(g.equipment.dismantle(data.item));
    }
    if (action === 'bagDropItem') {
      const it = g.equipment.getItem(data.item);
      if (it && confirm(`確定丟棄「${it.name}」？丟棄後無法復原。`)) this.ui.result(g.equipment.discardItem(data.item));
    }
    if (action === 'loLoad') {
      const key = el?.closest('.loadout-slot')?.querySelector('.lo-key')?.value;
      if (key) this.ui.result(g.survivors.loadSlot(id, data.kind, key));
    }
    if (action === 'loUnload') this.ui.result(g.survivors.unloadSlot(id, data.kind));
    if (action === 'equipBag') this.ui.result(g.equipment.equip(id, data.item));
    if (action === 'itemToStore') this.ui.result(g.equipment.moveToStore(data.item));
    if (action === 'pickFromStore') this.pickFromStore(id);
    if (action === 'job') this.ui.result(g.survivors.setJob(id, data.job));
    if (action === 'heal') this.ui.result(g.survivors.heal(id, data.key || null));
    if (action === 'unequip') this.ui.result(g.equipment.unequip(id, data.slot));
    if (action === 'quickEquip') {
      const r = g.equipment.quickEquip(id);
      if (r.ok && r.warn) this.ui.toastEl.show(r.msg, 'warn', 6000);
      else this.ui.result(r);
    }
    if (action === 'quickUnequip') this.ui.result(g.equipment.unequipAll(id));
    if (action === 'healAll') {
      this.ui.result(g.survivors.healAll());
      this.ui.refresh(true);
      return;
    }
    // 名單卡片上的快速換裝／脫裝：只換裝，不切換右側詳細資料
    if (action === 'miniQuickEquip' || action === 'miniQuickUnequip') {
      const sid = data.id;
      if (action === 'miniQuickEquip') {
        const r = g.equipment.quickEquip(sid);
        const name = g.survivors.get(sid)?.name || '';
        if (r.ok && r.warn) this.ui.toastEl.show(`${name}：${r.msg}`, 'warn', 6000);
        else this.ui.result(r.ok ? { ...r, msg: `${name}：${r.msg}` } : r);
      } else this.ui.result(g.equipment.unequipAll(sid));
      this.ui.refresh(true);
      return;
    }
    if (action === 'pickItem') this.pickItem(id, data.slot);
    this.ui.refresh(true);
  }

  /** 從其他頁面打開某位倖存者 */
  openDetail(id) {
    this.selId = id;
    this.view = 'detail';
    this.paneOpen = true;
    this.ui.switchTab('survivors');
  }

  /** 保留輸入中的數量；彈藥／藥品自動補給開關 */
  afterRender(el) {
    if (this.boundEl === el) return;
    this.boundEl = el;
    el.addEventListener('input', (e) => {
      if (e.target.classList?.contains('bag-qty')) this.bagQty = Number(e.target.value) || 1;
    });
    // 畫面每秒更新，記住說明是否展開，避免剛展開就被重畫關閉
    el.addEventListener('toggle', (e) => {
      const key = e.target?.dataset?.keep;
      if (key) this.keepOpen = { ...(this.keepOpen || {}), [key]: e.target.open };
    }, true);
    el.addEventListener('change', (e) => {
      if (this.ui.tab !== 'survivors') return;
      if (e.target.classList?.contains('lo-auto')) {
        const kind = e.target.dataset.kind;
        const key = e.target.checked ? e.target.closest('.loadout-slot').querySelector('.lo-key').value : null;
        this.ui.result(this.game.survivors.setSupply(this.selId, kind, key));
        this.game.changed();
      }
    });
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
    return `<div class="job-now">${cur.icon} <b>${cur.name}</b>${towerTag(this.game, sv) ? ` ${towerTag(this.game, sv)}` : ''}：${cur.desc || ''}</div>
      <details class="job-help" data-keep="jobs" ${this.keepOpen?.jobs ? 'open' : ''}><summary>ℹ️ 所有工作說明（含這位倖存者的每小時產出）</summary><ul class="skill-list">${rows}</ul></details>`;
  }

  /** 右側（手機版為全頁）的倖存者詳情：概要／裝備／背包／技能 */
  detailBody(id) {
    const g = this.game;
    const sv = g.survivors.get(id);
    if (!sv) return '<p class="muted">沒有倖存者。</p>';
    const cls = CLASSES[sv.classId];
    const s = g.survivors.stats(sv);
    const tab = ['overview', 'gear', 'bag', 'skills'].includes(this.tab) ? this.tab : 'overview';
    const skillSlots = g.survivors.skillSlots(sv);
    const hp = g.survivors.hpOf(sv);
    const max = g.survivors.maxHp(sv);
    const load = g.survivors.bagLoad(sv);
    const cap = g.survivors.bagCap(sv);
    const eq = g.equipment;
    const bar = (label, v, m, cls2, text) => `<div class="sv-bar"><small>${label}</small>${progressBar(m ? v / m : 0, cls2)}<small>${text}</small></div>`;
    const hurt = hp < max;
    const starving = g.survivors.isStarving();
    const tabBtn = (t, label) => `<button class="sv-tab ${tab === t ? 'active' : ''}" data-action="svTab" data-t="${t}">${label}</button>`;
    const head = `<div class="sv-pane-head">
        ${btn('‹', 'svBack', {}, { cls: 'btn-sm sv-back', title: '返回列表' })}
        <span class="sv-icon big" style="--cc:${cls.color}">${cls.icon}</span>
        <div class="grow"><b class="sv-name">${escapeHtml(sv.name)}${sv.isLeader ? ' <small class="tag tag-amber">👑 領袖</small>' : ''}</b>
          <small class="muted block">${sv.isLeader ? '' : rarityTag(sv.rarity)} ${cls.name} Lv${sv.level}・戰力 ${s.power}・成長 ×${g.survivors.growthMul(sv)}${sv.isLeader ? '' : `・平均素質 ${g.survivors.avgQuality(sv)}%`}</small></div>
        ${survivorStatus(g, sv)}
        ${hurt ? btn('💊 治療', 'healOpen', {}, { cls: 'btn-sm', title: starving ? '飢餓中：治療後生命仍會持續流失' : '' }) : ''}
        ${sv.status === 'idle' ? btn('⚡ 快速換裝', 'quickEquip', {}, { cls: 'btn-sm btn-primary', title: '從倉庫與在家隊員的背包，每個部位換上戰力最高的裝備' }) : ''}
        ${sv.status === 'idle' ? btn('🧺 快速脫裝', 'quickUnequip', {}, { cls: 'btn-sm btn-ghost', title: '卸下身上全部裝備放回倉庫（倉庫滿了放自己的背包）', disabled: !SLOT_KEYS.some((k) => sv.equipment[k]) }) : ''}
      </div>
      <div class="sv-bars">
        ${bar('生命', hp, max, sv.severe || hp / max < 0.3 ? 'danger' : 'hp', `${Math.floor(hp)}/${max}${sv.severe ? '（30% 脫離重傷）' : ''}`)}
        ${bar('經驗', sv.xp, xpToNext(sv.level), 'xp', `${sv.xp}/${xpToNext(sv.level)}`)}
        ${bar('負重', load, cap, load >= cap ? 'danger' : 'load', `${Math.floor(load)}/${cap}・${eq.bagSlotsUsed(sv)}/${eq.bagSlotCap(sv)} 格`)}
      </div>
      <div class="sv-tabs">${tabBtn('overview', '概要')}${tabBtn('gear', '裝備')}${tabBtn('bag', `背包 ${eq.bagSlotsUsed(sv)}/${eq.bagSlotCap(sv)}`)}${tabBtn('skills', `技能 ${Math.min(skillSlots, cls.skills.length)}/${cls.skills.length}`)}</div>`;
    const jobs = Object.entries(JOBS).map(([jid, j]) => {
      const bonus = j.classBonus?.[sv.classId];
      return `<button class="chip ${sv.job === jid ? 'active' : ''}" data-action="job" data-job="${jid}" title="${escapeHtml(j.desc || '')}">${j.icon} ${j.name}${bonus ? ` ×${bonus}` : ''}</button>`;
    }).join('');
    const jobsCard = `<section class="sh-card"><h3>工作指派 <small class="muted">（閒置在避難所時生效）</small></h3><div class="chips">${jobs}</div>${this.jobsHelp(sv)}</section>`;
    const statsCard = `<section class="sh-card"><h3>能力 <small class="muted">${sv.isLeader ? '' : '素質越高，基礎能力與每次升級的成長越多'}</small></h3>${this.abilityRows(sv, s)}<small class="muted">暴傷 +${Math.round((s.critDmg - 1) * 100)}%${s.lifeSteal ? `・吸血 ${(s.lifeSteal * 100).toFixed(1)}%` : ''}${sv.isLeader ? '' : '・素質 100% 以金色顯示，招募時決定、之後不會改變'}</small>
      ${hurt ? `<div class="heal-box ${sv.severe ? 'warn' : ''}"><div class="row-between">${sv.severe ? '🩸 重傷：無法行動，生命回到 30% 才能脫離' : '🩹 受傷：有診療室或醫生照護時才會慢慢恢復，也可以直接用藥'}${starving ? '<span class="tag tag-red">🍽️ 飢餓中：生命會持續流失</span>' : ''}</div>
      <div class="label">💊 治療：選擇要使用的藥品</div>${this.medsHtml(sv)}</div>` : ''}</section>`;
    const gearCard = `<section class="sh-card"><h3>裝備</h3>${this.gearGrid(sv)}${this.supplyHtml(sv)}</section>`;
    const bagCard = `<section class="sh-card">${this.bagHtml(sv)}</section>`;
    const skills = cls.skills.map((sk, i) => {
      const locked = i >= skillSlots;
      const on = !locked && sv.level >= sk.unlock;
      return `<li class="${on ? 'on' : 'off'}"><b>${sk.name}</b>（Lv${sk.unlock}）${sk.desc}${locked ? ' <span class="tag">🔒 品級不足</span>' : ''}</li>`;
    }).join('');
    const skillsCard = `<section class="sh-card"><h3>技能 <small class="muted">（品級可解放 ${skillSlots}/${cls.skills.length} 個）</small></h3><ul class="skill-list">${skills}</ul></section>`;
    const foot = sv.isLeader ? '' : `<div class="btn-row end">${btn('🚪 驅逐', 'dismiss', {}, { cls: 'btn-ghost btn-sm', disabled: sv.status === 'exploring' })}</div>`;
    const body = {
      // 概要：工作指派與能力（裝備、背包在各自的分頁）
      overview: `<div class="sv-ov"><div class="sv-ov-col">${jobsCard}</div><div class="sv-ov-col">${statsCard}</div></div>${foot}`,
      gear: gearCard,
      bag: bagCard,
      skills: skillsCard,
    }[tab];
    return `<div class="sv-detail2" style="--cc:${cls.color}">${head}${body}</div>`;
  }

  /** 裝備欄：兩欄小方塊（部位、名稱、品級與戰力），點擊更換 */
  gearGrid(sv) {
    const g = this.game;
    const away = sv.status !== 'idle';
    return `<div class="gear-grid">${SLOT_KEYS.map((slot) => {
      const item = g.equipment.getItem(sv.equipment[slot]);
      const n = this.candidates(sv.id, slot).length;
      const r = item ? RARITIES[item.rarity] : null;
      const aw = slot === 'weapon' && item ? g.equipment.ammoWarn(item, sv) : null;
      return `<div class="gear-cell ${item ? '' : 'empty'} ${aw ? 'noammo' : ''}" style="--rc:${r?.color || '#666'}">
        <small class="muted">${SLOTS[slot].icon} ${SLOTS[slot].name}</small>
        <b>${item ? escapeHtml(item.name) : '— 空 —'}${aw ? ` <span class="ammo-badge">⚠️ ${aw.level === 'low' ? '彈藥不足' : '無彈藥'}</span>` : ''}</b>
        ${aw ? `<small class="neg">需要${escapeHtml(aw.name)}：${aw.level === 'low' ? '不夠一場戰鬥使用' : '沒有彈藥時戰鬥只能用近戰武器'}</small>` : ''}
        <small class="muted">${item ? `${r.name}・戰力 ${item.power}` : n ? `有 ${n} 件可裝備` : '沒有可裝備的物品'}</small>
        ${item ? `<div class="gear-stats">${statLine(item.stats)}</div>${item.affixes?.length ? `<div class="gear-affixes">${affixChips(item)}</div>` : ''}` : ''}
        ${away ? '' : `<span class="gear-acts">${btn(item ? '更換' : '裝備', 'pickItem', { slot }, { cls: 'btn-xs', disabled: !n })}${item ? btn('卸下', 'unequip', { slot }, { cls: 'btn-xs btn-ghost' }) : ''}</span>`}
      </div>`;
    }).join('')}</div>${away ? '<small class="muted block">已派出，回到避難所後才能更換裝備。</small>' : ''}`;
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
        <span class="med-icon">${m.icon}</span><span class="grow"><b>${m.name}</b><small class="muted block">回復 ${Math.round(m.heal * 100)}%（+${amt}${amt > lost ? `，<b class="overflow">⚠️ 會溢出 ${amt - Math.round(lost)}</b>` : ''}）・${where}</small></span></button>`;
    }).join('')}</div>`;
  }

  /** 治療彈窗：選擇藥品；生命回滿後自動關閉 */
  openHeal(id) {
    const g = this.game;
    const body = () => {
      const sv = g.survivors.get(id);
      if (!sv) return '<p class="muted">找不到倖存者</p>';
      return `${hpBar(g, sv)}
        ${g.survivors.isStarving() ? '<p class="tag tag-red">🍽️ 飢餓中：治療後生命仍會持續流失，請盡快補充食物</p>' : ''}${this.medsHtml(sv)}`;
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
  /** 彈藥欄（最多 100）與藥品欄（最多 10），以及自動補給（各一種） */
  supplyHtml(sv) {
    const g = this.game;
    const svs = g.survivors;
    const lo = svs.loadout(sv);
    const rules = svs.supplyRules(sv);
    const home = svs.atShelter(sv);
    const need = svs.ammoNeed(sv);
    const store = g.state.supplies || {};
    const slot = (kind, label, max, keys) => {
      const cur = lo[kind];
      const opts = keys.map((k) => `<option value="${k}" ${(cur?.key || rules[kind] || (kind === 'ammo' ? need?.ammo : 'bandage')) === k ? 'selected' : ''}>${SUPPLIES[k].icon} ${SUPPLIES[k].name}（倉庫 ${Math.floor(store[k] || 0)}・背包 ${Math.floor(sv.bag?.[k] || 0)}）</option>`).join('');
      return `<div class="card loadout-slot" data-kind="${kind}">
        <div class="row-between"><b>${label}</b><span>${cur ? `${SUPPLIES[cur.key].icon} ${SUPPLIES[cur.key].name} <b>${cur.qty}</b> / ${max}` : '<span class="muted">— 空 —</span>'}</span></div>
        <div class="trade-row"><select class="lo-key">${opts}</select>
          ${btn('裝填', 'loLoad', { kind }, { cls: 'btn-xs btn-primary', disabled: !home && !keys.some((k) => sv.bag?.[k] > 0) })}${cur ? btn('卸下', 'loUnload', { kind }, { cls: 'btn-xs btn-ghost' }) : ''}</div>
        <label class="toggle"><input type="checkbox" class="lo-auto" data-kind="${kind}" ${rules[kind] ? 'checked' : ''}> 🔄 自動補給${rules[kind] ? `：${SUPPLIES[rules[kind]].name}` : ''}（回到避難所或探索找到時自動補滿）</label>
      </div>`;
    };
    const ammoKeys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === 'ammo');
    const medKeys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === 'med' && (SUPPLIES[k].heal || 0) > 0);
    return `<h4>🎯 彈藥與 💊 藥品欄</h4>
      <p class="muted">戰鬥時優先使用遠程武器，彈藥不足時自動改用近戰武器${need ? `（目前遠程武器使用 ${SUPPLIES[need.ammo].name}，每場約 ${need.perFight} 發）` : ''}。生命低於 35% 時自動使用藥品欄的藥。</p>
      <div class="grid">${slot('ammo', '🎯 彈藥欄', LOADOUT_MAX.ammo, ammoKeys)}${slot('med', '💊 藥品欄', LOADOUT_MAX.med, medKeys)}</div>`;
  }

  /** 背包：方格排列，點一格後在下方操作（數量、存入倉庫、丟棄…） */
  bagHtml(sv) {
    const g = this.game;
    const eq = g.equipment;
    const bag = g.survivors.bagOf(sv);
    const home = g.survivors.atShelter(sv);
    const slots = eq.bagSlotCap(sv);
    const stacks = Object.keys(bag).filter((k) => bag[k] >= 1);
    const items = eq.bagItems(sv);
    if (this.bagSel && !stacks.includes(this.bagSel) && !items.some((it) => `item:${it.id}` === this.bagSel)) this.bagSel = null;
    const cells = [
      ...stacks.map((k) => `<button class="bag-tile ${this.bagSel === k ? 'on' : ''}" data-action="bagSel" data-k="${k}" title="${metaOf(k).name}">
        <span class="bag-ico">${metaOf(k).icon}</span><small>${metaOf(k).name}</small><b>×${Math.floor(bag[k])}</b></button>`),
      ...items.map((it) => `<button class="bag-tile item ${this.bagSel === `item:${it.id}` ? 'on' : ''}" data-action="bagSel" data-k="item:${it.id}" style="--rc:${RARITIES[it.rarity].color}" title="${escapeHtml(it.name)}">
        <span class="bag-ico">${ITEM_MODELS[it.model]?.icon || ITEM_TYPES[it.type]?.icon || '❔'}</span><small>${escapeHtml(it.name)}</small><b>戰力 ${it.power}</b></button>`),
    ];
    const used = eq.bagSlotsUsed(sv);
    for (let i = used; i < slots; i += 1) cells.push('<span class="bag-tile empty"></span>');
    let action = '<p class="muted bag-hint">點選上方的物品來存入倉庫、丟棄或裝備。</p>';
    if (this.bagSel && !this.bagSel.startsWith('item:')) {
      const k = this.bagSel;
      const have = Math.floor(bag[k]);
      const q = Math.min(have, Math.max(1, Math.floor(this.bagQty || have)));
      action = `<div class="bag-act">
        <div class="row-between"><b>${metaOf(k).icon} ${metaOf(k).name} ×${have}</b><small class="muted">每個重 ${unitWeight(k)}</small></div>
        <div class="bag-qty-row">${btn('−', 'bagStep', { d: -1 }, { cls: 'btn-sm', title: '減少' })}<input class="bag-qty" type="number" min="1" max="${have}" value="${q}" inputmode="numeric" aria-label="數量">${btn('+', 'bagStep', { d: 1 }, { cls: 'btn-sm', title: '增加' })}${btn('全部', 'bagMax', {}, { cls: 'btn-sm btn-ghost' })}</div>
        <div class="bag-act-btns">${home ? btn('存入倉庫', 'bagIn', { key: k }, { cls: 'btn-sm btn-primary' }) : '<small class="muted">不在避難所，無法存入倉庫</small>'}${btn('🗑️ 丟棄', 'bagDrop', { key: k }, { cls: 'btn-sm btn-danger' })}</div>
      </div>`;
    } else if (this.bagSel) {
      const it = eq.getItem(this.bagSel.slice(5));
      if (it) {
        action = `<div class="bag-act">${itemCard(it, { compact: true })}
          <div class="bag-act-btns">${sv.status === 'idle' ? btn('裝備', 'equipBag', { item: it.id }, { cls: 'btn-sm btn-primary' }) : ''}${home ? btn('存入倉庫', 'itemToStore', { item: it.id }, { cls: 'btn-sm' }) : ''}${btn('🔨 拆解', 'bagDismantle', { item: it.id }, { cls: 'btn-sm', disabled: it.locked, title: it.locked ? '已上鎖' : `拆解可得：${Object.entries(eq.dismantleValue(it)).map(([kk, v]) => `${metaOf(kk).name}×${v}`).join('、')}` })}${btn('🗑️ 丟棄', 'bagDropItem', { item: it.id }, { cls: 'btn-sm btn-danger', disabled: it.locked })}</div>
        </div>`;
      }
    }
    return `<div class="row-between"><h3>🎒 背包 <small class="muted">${used}/${slots} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))}/${g.survivors.bagCap(sv)}</small></h3>
        <span class="btn-row">${home ? `${btn('📦 從倉庫拿取', 'pickFromStore', {}, { cls: 'btn-xs' })}${used ? btn('全部存入倉庫', 'bagAll', {}, { cls: 'btn-xs' }) : ''}` : ''}</span></div>
      <div class="bag-grid2">${cells.join('')}</div>
      ${action}
      ${home ? '' : '<small class="muted block">不在避難所，無法存取倉庫。</small>'}`;
  }

  /** 從倉庫拿取：消耗品可選數量或全部；裝備一件一格 */
  pickFromStore(svId) {
    const g = this.game;
    const eq = g.equipment;
    const body = () => {
      const sv = g.survivors.get(svId);
      const res = g.state.resources;
      const head = `<div class="btn-row">${btn('← 完成', 'back', {}, { cls: 'btn-sm' })}</div><p class="muted">${escapeHtml(sv?.name || '')} 的背包 ${eq.bagSlotsUsed(sv)} / ${eq.bagSlotCap(sv)} 格・負重 ${Math.floor(g.survivors.bagLoad(sv))} / ${g.survivors.bagCap(sv)}</p>`;
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
          m.close();
          this.ui.refresh(true);
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
          return itemCard(it, {
            equippedBy: owner,
            carrier,
            ammoWarn: slot === 'weapon' ? g.equipment.ammoWarn(it, sv) : null,
            actions: `${btn('裝備', 'equip', { id: it.id }, { cls: 'btn-sm btn-primary' })}${compareHtml(g, it, cur)}`,
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
          m.close();
          this.ui.refresh(true);
          return;
        }
        if (action === 'equip') {
          const r = this.ui.result(g.equipment.equip(svId, data.id));
          if (r.ok) {
            m.close();
            this.ui.refresh(true);
          } else m.update(body());
        }
      },
    });
  }
}
