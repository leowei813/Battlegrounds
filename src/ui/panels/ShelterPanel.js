import { shareBtn, openShareDialog } from '../ShareDialog.js';
import { FACILITIES, FACILITY_MAX_LEVEL, OUTPOST_FACILITIES } from '../../config/facilities.js';
import { DEFENSES, DEFENSE_MAX_LEVEL, defenseBuildTime } from '../../config/defenses.js';
import { PRIMARY_DANGER_COEF, MAX_OUTPOSTS, SIEGE_SCALING } from '../../config/civilization.js';
import { openAbandonDialog } from '../AbandonDialog.js';
import { siegeDetailHtml, raidRewardHtml } from '../SiegeResult.js';
import { escapeHtml } from '../../utils/dom.js';
import { battlesSectionHtml } from '../BattleLog.js';
import {
  btn, costHtml, needHtml, timerBar, progressBar, metaOf, affordable,
} from '../components.js';
import { formatDuration, formatNumber } from '../../utils/math.js';
import { BUILD_QUEUE_SIZE } from '../../config/constants.js';
import { SUPPLIES } from '../../config/supplies.js';

/** 總覽的彈藥・藥品庫存：短名稱與偏低門檻 */
const STOCK_SHORT = {
  ammo9: '9mm', shell12: '霰彈', ammo556: '5.56', ammo762: '7.62', ammo308: '.308', arrow: '箭矢',
  smallKit: '小醫藥箱', mediumKit: '中醫藥箱', largeKit: '大醫藥箱',
};
const STOCK_LOW = { ammo: 50, med: 10 };

/**
 * 避難所分頁（側邊/底部抽屜）：設施升級、施工佇列、防禦建築、事件紀錄。
 */
/** 避難所面板的分頁 */
const SHELTER_TABS = ['overview', 'facilities', 'defense', 'storage', 'garage'];
/** 避難所面板本身處理的操作（其餘在倉庫、車庫分頁時交給倉庫面板） */
const SHELTER_ACTIONS = ['shareDefense', 'gotoMap', 'upgrade', 'slot', 'viewBase', 'abandon', 'cancelBuild', 'toggleAlert', 'facFilter', 'gotoTab', 'defBuild', 'defDemolish', 'defGarrison'];

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
      <section class="sh-card civ-card2">
        <div class="row-between"><h3>${tier.icon} 文明度 ${b.total} <span class="tag tag-amber">${tier.name}</span></h3><small class="muted">${next ? `距「${next.name}」${next.min - b.total}` : '已達最高階段'}</small></div>
        ${progressBar(ratio, 'civ')}
        <div class="civ-grid"><div><small>建築</small><b>${b.buildings}</b></div><div><small>玩家等級</small><b>${b.player}</b></div><div><small>裝備</small><b>${b.equipment}</b></div><div><small>科技</small><b>${b.research}</b></div></div>
        <div class="row-between danger-row">
          <span>☠ 據點危險度 <b>${danger}</b>・<span class="zone-tag" style="--zc:${siege.zone().color}">${siege.zone().name}</span></span>
          <small class="muted">${siege.active() ? `殭屍 Lv${siege.zombieLevel()}・每波約 ${Math.round(siege.waveSize())} 隻` : `22:00 屍潮來襲・殭屍約 Lv${Math.min(SIEGE_SCALING.maxZombieLevel ?? Infinity, siege.zombieLevel() + 1)}`}</small>
        </div>
        <details class="civ-more" ${this.civOpen ? 'open' : ''}><summary>計算方式</summary>
          <p class="muted">屍潮強度隨文明度提升（殭屍 +${civ.levelBonus()} 級、頻率 ×${civ.spawnMul().toFixed(2)}），與天數無關；避難所屍潮倍率 ×${siege.sizeMul().toFixed(2)}（所有避難所相同）。危險度 = 建築基礎 ${baseDanger} + 文明度 ${b.total} × ${PRIMARY_DANGER_COEF}${isPrimary ? '' : '（前哨站不受文明度加成）'}；危險度越高，殭屍等級與屍潮頻率越高。</p>
        </details>
      </section>`;
  }

  /** 總覽：彈藥與藥品庫存（大字為倉庫，小字 +N 為倖存者背包裡帶著的） */
  stockStrip() {
    const g = this.game;
    const store = g.state.supplies || {};
    const bag = {};
    g.state.survivors.forEach((sv) => Object.entries(sv.bag || {}).forEach(([k, v]) => { bag[k] = (bag[k] || 0) + (v || 0); }));
    const line = (cat, label, tail = '') => {
      const chips = Object.entries(SUPPLIES).filter(([, d]) => d.cat === cat).map(([k, d]) => {
        const n = Math.floor(store[k] || 0);
        const b = Math.floor(bag[k] || 0);
        const cls = n <= 0 ? 'zero' : n < STOCK_LOW[cat] ? 'low' : '';
        return `<span class="stk-c ${cls}" title="${escapeHtml(d.name)}${d.heal ? `・回復 ${Math.round(d.heal * 100)}%` : ''}">${d.icon} ${escapeHtml(STOCK_SHORT[k] || d.name)} <b>${formatNumber(n)}</b>${b > 0 ? `<i>+${formatNumber(b)}</i>` : ''}</span>`;
      }).join('');
      return `<div class="stk-line"><span class="stk-lab">${label}</span>${tail}${chips}</div>`;
    };
    return `<section class="sh-card stk-strip">
      ${line('ammo', '🎯 彈藥', btn('🗄️ 倉庫', 'shelterTab', { t: 'storage' }, { cls: 'btn-xs btn-ghost stk-go' }))}
      ${line('med', '💊 藥品')}
    </section>`;
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
    const head = `<div class="drawer-head"><b>${sh && g.shelter.isPrimary(sh) ? '⭐' : '🏴'} ${escapeHtml(sh?.name || '避難所')}</b>
      </div>`;
    if (!sh) {
      return `${head}<div class="empty">尚未建立避難所。<br>${btn('🗺️ 前往地圖選擇建築', 'gotoMap', {}, { cls: 'btn-primary' })}</div>`;
    }
    const now = Date.now();
    const tabs = st.bases.map((b) => {
      return `<button class="chip ${b.id === sh.id ? 'active' : ''}" data-action="viewBase" data-id="${b.id}">${g.shelter.isPrimary(b) ? '⭐' : '🏴'} ${escapeHtml(b.name)}</button>`;
    }).join('');
    const baseActions = g.shelter.isPrimary(sh)
      ? `<small class="muted">⭐ 避難所：倖存者居住、生產、探索出發、駐守倖存者防衛於此。</small>${btn('🚚 搬遷', 'abandon', {}, { cls: 'btn-sm btn-ghost' })}`
      : `<small class="muted">🏴 前哨站：只有防禦功能，不能生產。</small>${btn('🏚️ 放棄前哨站', 'abandon', {}, { cls: 'btn-sm btn-ghost' })}`;
    const queue = sh.buildQueue.map((q, i) => {
      const name = q.kind === 'facility' ? FACILITIES[q.id].name : `${DEFENSES[q.id].name}（槽位 ${q.slot + 1}）`;
      const done = Math.min(1, Math.max(0, (now - (q.startAt || now)) / Math.max(1, q.endAt - (q.startAt || now))));
      return `<div class="queue-item"><div class="row-between"><span>🔨 ${name} → Lv${q.targetLevel}</span>${btn(`取消（退 ${Math.round(90 * (1 - done))}%）`, 'cancelBuild', { i }, { cls: 'btn-xs btn-ghost' })}</div>${timerBar(q.startAt || now, q.endAt, now)}</div>`;
    }).join('');

    const outpost = g.shelter.isOutpost(sh);
    const facFilter = this.facFilter || 'all';
    const facilities = Object.entries(FACILITIES).filter(([id]) => !outpost || OUTPOST_FACILITIES.includes(id)).map(([id, def]) => {
      const lv = sh.facilities[id].level;
      const busy = g.shelter.isFacilityBusy(sh, id);
      const max = lv >= FACILITY_MAX_LEVEL;
      const check = g.shelter.canUpgradeFacility(sh, id);
      if (facFilter === 'ready' && !check.ok) return '';
      if (facFilter === 'built' && lv === 0) return '';
      if (facFilter === 'unbuilt' && lv > 0) return '';
      const label = busy ? '施工中' : !check.ok && !max ? (check.reason?.includes('不足') ? '材料不足' : '無法升級') : lv === 0 ? '建造' : '升級';
      return `
      <div class="fac-card2 ${lv === 0 ? 'unbuilt' : ''}">
        <div class="fac2-head"><span class="fac-icon">${def.icon}</span><b>${def.name}</b><span class="muted">Lv ${lv}</span></div>
        <div class="fac2-effect">${lv > 0 ? def.effectText(lv) : '尚未建造'}${max ? '' : `<small class="muted block">下一級：${def.effectText(lv + 1)}</small>`}</div>
        ${id === 'cellar' && lv > 0 ? this.cellarNowHtml() : ''}
        ${max ? '<div class="tag">已達最高等級</div>' : `<div class="fac2-cost">
          <small class="muted">${busy ? '施工中（材料已扣除）' : `${lv === 0 ? '建造' : `升級到 Lv ${lv + 1}`}需要（擁有/需要）`}</small>
          ${busy ? '' : `<div class="needs">${needHtml(st, g.shelter.facilityCost(sh, id))}</div>`}
          <div class="row-between">${busy ? '<span></span>' : `<small class="muted">${check.ok ? '' : escapeHtml(check.reason || '')}</small>`}
          ${btn(label, 'upgrade', { id }, { cls: `btn-sm ${check.ok ? 'btn-primary' : label === '材料不足' ? 'btn-lack' : ''}`, disabled: !check.ok, title: check.reason || '' })}</div>
        </div>`}
      </div>`;
    }).join('');


    const siege = g.siege.of(sh.id);
    const wallRatio = g.shelter.wallHp(sh) / g.shelter.wallMax(sh);
    const z = g.shelter.sizeInfo(sh);
    const tab = SHELTER_TABS.includes(ui.shelterTab) ? ui.shelterTab : 'overview';
    const inv = ui.panels.inventory;
    const storeN = `${g.equipment.storeUsed()}/${g.equipment.storeCap()}`;
    // 分頁選單：網頁版在左側直排，手機版在上方一列可左右滑動
    const navItem = (id, label, extra = '') => `<button class="sh-nav-item ${tab === id ? 'active' : ''}" data-action="shelterTab" data-t="${id}"><span>${label}</span>${extra ? `<small>${extra}</small>` : ''}</button>`;
    const nav = `<nav class="sh-nav" aria-label="避難所分頁">
      <div class="sh-base">
        <b>${g.shelter.isPrimary(sh) ? '⭐' : '🏴'} ${escapeHtml(sh.name)}</b>
        ${st.bases.length > 1 ? `<div class="sh-bases">${tabs}</div>` : ''}
      </div>
      <div class="sh-nav-list">
        ${navItem('overview', '🏠 總覽')}
        ${navItem('facilities', '🏗️ 設施', `施工 ${sh.buildQueue.length}/${BUILD_QUEUE_SIZE}`)}
        ${navItem('defense', '🛡️ 防禦')}
        ${navItem('storage', '🗄️ 倉庫', storeN)}
        ${navItem('garage', '🚗 車庫', `${st.vehicles.length}/${g.vehicles.garageSize()}`)}
      </div>
    </nav>`;

    // 需要處理：可以直接點按鈕處理的事項
    const todo = [];
    const repairers = g.shelter.repairers().length;
    if (wallRatio < 0.999 && !repairers) {
      todo.push({ cls: 'warn', text: `圍牆 ${Math.round(wallRatio * 100)}%，沒有修繕人員`, sub: `每 100 點耗 ${Object.entries(g.shelter.repairCostPerHp()).map(([k, v]) => `${metaOf(k).name} ${+(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}`).join('・')}`, btn: btn('指派修繕', 'gotoTab', { tab: 'survivors' }, { cls: 'btn-sm btn-primary' }) });
    }
    const repairNote = this.repairWarn();
    if (repairNote) todo.push({ cls: 'warn', text: repairNote, sub: '', btn: '' });
    if (sh.buildQueue.length < BUILD_QUEUE_SIZE && g.shelter.isPrimary(sh)) {
      todo.push({ cls: 'info', text: `施工佇列還有空位（${sh.buildQueue.length}/${BUILD_QUEUE_SIZE}）`, sub: '', btn: btn('前往設施', 'shelterTab', { t: 'facilities' }, { cls: 'btn-sm' }) });
    }
    const storeRatio = g.equipment.storeUsed() / Math.max(1, g.equipment.storeCap());
    if (storeRatio >= 0.85) todo.push({ cls: storeRatio >= 1 ? 'warn' : 'info', text: `倉庫 ${storeN}${storeRatio >= 1 ? '，已經滿了' : '，快滿了'}`, sub: '探索帶回的物資會放不下', btn: btn('整理倉庫', 'shelterTab', { t: 'storage' }, { cls: 'btn-sm' }) });
    if (!g.research.actives().length && g.shelter.maxLevel('researchCenter') > 0) todo.push({ cls: 'info', text: '研究中心目前沒有研究', sub: '', btn: btn('前往研究', 'gotoTab', { tab: 'research' }, { cls: 'btn-sm' }) });
    const net = g.resources.rates().net;
    if ((net.food || 0) < 0) todo.push({ cls: 'warn', text: `食物每小時 ${Math.round(net.food)}`, sub: '升級農場或多探索食物來源', btn: '' });
    const todoHtml = todo.map((t) => `<div class="todo ${t.cls}"><div><span>${t.text}</span>${t.sub ? `<small class="muted block">${t.sub}</small>` : ''}</div>${t.btn}</div>`).join('')
      || '<p class="muted">目前沒有需要處理的事項。</p>';

    const queueBox = `<section class="sh-card"><h3>施工佇列 ${sh.buildQueue.length}/${BUILD_QUEUE_SIZE}</h3>${queue || ''}${Array.from({ length: Math.max(0, BUILD_QUEUE_SIZE - sh.buildQueue.length) }, () => '<div class="queue-empty">空位：點設施的「升級」加入</div>').join('')}</section>`;
    const rates = g.resources.rates().net;
    const ratesBox = `<section class="sh-card sh-rates"><h3>每小時產出</h3>${Object.entries(rates).filter(([, v]) => Math.round(v) !== 0).map(([k, v]) => `<div class="row-between"><span>${metaOf(k).icon} ${metaOf(k).name}</span><span class="${v < 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : ''}${Math.round(v)}</span></div>`).join('') || '<p class="muted">沒有產出</p>'}</section>`;

    const sections = {
      overview: `
        <div class="alert-strip ${g.shelter.alert ? 'on' : ''}"><span>${g.shelter.alert ? '🚨 <b>警戒中</b>・全部倖存者暫時為防禦駐守' : '🟢 正常・倖存者依指派的工作行動'}</span>${btn(g.shelter.alert ? '解除警戒' : '🚨 切換警戒', 'toggleAlert', {}, { cls: `btn-sm ${g.shelter.alert ? '' : 'btn-danger'}` })}</div>
        ${g.shelter.hasShelter() ? '' : `<div class="card warn">🏚️ 目前沒有避難所，無法生產與探索。${btn('🗺️ 到地圖選擇新的避難所', 'gotoMap', {}, { cls: 'btn-sm btn-primary' })}</div>`}
        <div class="kpi-grid">
          <div class="kpi wide"><div class="row-between"><small>圍牆</small><span><b>${Math.floor(g.shelter.wallHp(sh))}</b> / ${g.shelter.wallMax(sh)}</span></div>${progressBar(wallRatio, wallRatio < 0.3 ? 'danger' : '')}<small class="muted">不會自行修復・修繕 ${repairers} 人・每秒 +${g.shelter.repairRate().toFixed(1)}</small></div>
          <div class="kpi"><small>防禦 DPS</small><b class="big">${siege.defenseDps()}</b></div>
          <div class="kpi"><small>屍潮</small><b>${this.waveText(siege)}</b></div>
          <div class="kpi"><small>來襲殭屍</small><b class="big">${siege.zombies.length}</b></div>
        </div>
        ${this.stockStrip()}
        ${this.assistText(sh) ? `<div class="sh-card">${this.assistText(sh)}</div>` : ''}
        <div class="sh-cols">
          <section class="sh-card"><h3>需要處理</h3>${todoHtml}</section>
          ${this.renderCivilization(sh)}
        </div>
        ${queue ? queueBox : ''}
        <div class="sh-foot"><small class="muted">${g.shelter.isPrimary(sh) ? '⭐ 避難所：倖存者居住、生產、探索出發、駐守倖存者防衛於此。' : '🏴 前哨站：只有防禦功能，不能生產。'}</small>${btn(g.shelter.isPrimary(sh) ? '🚚 搬遷' : '🏚️ 放棄前哨站', 'abandon', {}, { cls: 'btn-xs btn-ghost' })}</div>`,
      facilities: `<div class="sh-fac">
        <div class="sh-fac-main">
          <div class="chips fac-filter">${[['all', '全部'], ['ready', '可升級'], ['built', '已建造'], ['unbuilt', '未建造']].map(([k, l]) => `<button class="chip ${facFilter === k ? 'active' : ''}" data-action="facFilter" data-f="${k}">${l}</button>`).join('')}</div>
          <div class="fac-grid">${facilities || '<p class="muted">沒有符合的設施。</p>'}</div>
        </div>
        <aside class="sh-fac-side">${queueBox}${ratesBox}</aside>
      </div>`,
      defense: `<p class="muted">${z.name}據點・防禦欄位 ${z.slots}・共可建造 ${z.total} 棟建築。空地按「建造」選擇要蓋的防禦建築，已建造的可直接升級、拆除或派人駐守。</p>
        <div class="kpi-grid def-kpis"><div class="kpi"><small>防禦 DPS</small><b class="big">${siege.defenseDps()}</b></div><div class="kpi"><small>欄位</small><b>${sh.defenses.filter((d) => d.type).length}/${sh.defenses.length}</b></div><div class="kpi"><small>屍潮</small><b>${this.waveText(siege)}</b></div></div>
        <div class="fac-grid def-grid">${sh.defenses.map((d, i) => this.defCard(sh, i)).join('')}</div>
        ${queue ? queueBox : ''}`,
      storage: tab === 'storage' ? `<h3 class="sh-title">🗄️ 物品倉庫（${storeN} 格）</h3>${inv.renderItems()}` : '',
      garage: tab === 'garage' ? inv.renderGarage() : '',
    };
    void head;
    return `<div class="sh-layout">${nav}<div class="sh-main">${sections[tab]}</div></div>`;
  }

  /** 友好玩家的協防（避難所）：誰在協防、火力與今晚累計戰果 */
  assistText(base) {
    const g = this.game;
    if (!g.shelter.isPrimary(base)) return '';
    const list = g.assist.incoming();
    const log = base.assistLog?.list || {};
    if (!list.length && !Object.keys(log).length) return '';
    const names = list.map((h) => `${escapeHtml(h.name)}${h.kind === 'cover' ? '（防禦設施）' : `（${h.count} 人）`} 每秒 ${h.dps}`).join('、');
    const done = Object.values(log).map((x) => `${escapeHtml(x.name)} 傷害 ${x.dmg}・擊殺 ${x.kills}`).join('、');
    return `<div class="wide"><small>🛡️ 友好協防</small><b>${names || '目前沒有'}</b>${done ? `<small class="muted block">今晚累計：${done}</small>` : ''}</div>`;
  }

  /** 據點遭襲紀錄：防禦成功或失敗、損失資源、毀損建築、受重傷的人 */
  /** 地窖目前實際藏起了多少 */
  cellarNowHtml() {
    const c = this.game.shelter.cellarStatus();
    const res = Object.entries(c.res).map(([k, v]) => `${metaOf(k).icon} ${formatNumber(v)}`).join('・');
    return `<div class="cellar-now">🕳️ 目前藏起：${res}・💰 ${formatNumber(c.coins)}${c.matKinds ? `<small class="block">🔩 零件與布料 ${c.matKinds} 種，共藏起 ${formatNumber(c.mats)} 個（每種最多 ${c.matCap}）</small>` : ''}</div>`;
  }

  defenseLogHtml(since = Infinity, openBattle = null) {
    const list = this.game.state.defenseLog || [];
    const rows = list.slice(0, 15).map((e) => this.defenseCardHtml(e, { since, openBattle })).join('');
    return `<h4>🛡️ 據點遭襲紀錄</h4>${rows || '<p class="muted">據點還沒有被攻擊過。</p>'}`;
  }

  /** 一筆據點紀錄的卡片。shared：聊天室分享的詳細（不顯示未讀、分享按鈕與戰鬥明細，明細展開） */
  defenseCardHtml(e, { since = Infinity, openBattle = null, shared = false } = {}) {
    {
      const t = new Date(e.at);
      const pad = (v) => String(v).padStart(2, '0');
      const when = `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      if (e.retreat) {
        return `<div class="card defense-log retreat">
        <div class="row-between"><b>${(e.at || 0) > since ? '<span class="tag tag-blue">未讀</span>' : ''}🏴‍☠️ 掠奪隊撤退</b><small class="muted">${when}</small></div>
        <div>${escapeHtml(e.attacker)}的掠奪隊見屍潮來襲，撤退了</div>
        <small class="muted block">目標：「${escapeHtml(e.baseName)}」・沒有交戰</small>
      </div>`;
      }
      const lost = Object.entries(e.lost || {}).map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name} −${v}`);
      if (e.coins) lost.push(`💰 −${e.coins}`);
      const lines = [
        e.waves ? `🌊 擋下 ${e.waves} 波` : '',
        e.kills ? `☠️ 擊殺 ${e.kills}` : '',
        e.siege?.wallPct != null && e.success ? `🧱 城牆剩 ${e.siege.wallPct}%` : e.wallLost ? `🧱 圍牆 −${e.wallLost}` : '',
      ].filter(Boolean).join('・');
      const html = `<div class="card defense-log ${e.success ? 'ok' : 'fail'}">
        <div class="row-between"><b>${(e.at || 0) > since ? '<span class="tag tag-blue">未讀</span>' : ''}${e.success ? '🛡️ 防禦成功' : '💥 防禦失敗'}</b><span class="row-gap">${e.id && !shared ? shareBtn(this.game, 'defense', e.id) : ''}<small class="muted">${when}</small></span></div>
        <div>「${escapeHtml(e.baseName)}」遭 ${escapeHtml(e.attacker)} 攻擊</div>
        ${lines ? `<small class="muted block">${lines}</small>` : ''}
        ${e.reward ? `${raidRewardHtml(e, 'summary')}<details class="sr-details"><summary>查看獎勵明細</summary>${raidRewardHtml(e, 'detail')}</details>` : ''}
        ${e.siege ? `${siegeDetailHtml(e, 'summary')}<details class="sr-details"><summary>查看${e.success ? '獎勵' : '損失'}明細</summary>${siegeDetailHtml(e, 'detail')}</details>` : `
        ${lost.length ? `<div class="neg">損失資源：${lost.join('、')}</div>` : (e.success ? '<div class="pos">沒有損失資源</div>' : '')}
        ${e.damaged?.length ? `<div class="neg">毀損建築：${e.damaged.map(escapeHtml).join('、')}</div>` : ''}
        ${e.injured?.length ? `<div class="neg">🩸 重傷：${e.injured.map(escapeHtml).join('、')}</div>` : ''}`}
        ${e.assists?.length ? `<div class="chips">${e.assists.map((x) => `<span class="ally-chip">🛡️ 協防：${escapeHtml(x.name)}${x.cover ? ' 防禦設施' : ''}${x.dmg ? ` ${x.dmg.toLocaleString()} 傷害` : ''}${x.kills ? `・擊殺 ${x.kills}` : ''}${x.down ? `・${x.down} 人重傷` : ''}</span>`).join('')}</div>` : ''}
        ${e.note ? `<small class="muted block">${escapeHtml(e.note)}</small>` : ''}
        ${shared ? '' : battlesSectionHtml(this.game, e.battleIds, openBattle)}
      </div>`;
      return shared ? html.replace(/<details class="sr-details">/g, '<details class="sr-details" open>') : html;
    }
  }

  onAction(action, data) {
    const g = this.game;
    if (action === 'gotoMap') this.ui.switchTab('map');
    const base = this.ui.viewBase();
    if (action === 'upgrade') this.ui.result(g.shelter.upgradeFacility(base, data.id));
    if (action === 'cancelBuild' && confirm('取消施工？依完成度退還材料，完成度越高退得越少。')) this.ui.result(g.shelter.cancelBuild(base, +data.i));
    if (action === 'slot') this.openSlot(+data.slot);
    if (action === 'defBuild') this.ui.result(g.shelter.buildDefense(base, +data.slot, data.type));
    if (action === 'defDemolish' && confirm('確定拆除？（不退還資源）')) this.ui.result(g.shelter.demolish(base, +data.slot));
    if (action === 'defGarrison') this.ui.result(g.shelter.garrison(base, +data.slot, data.id || null));
    if (action === 'viewBase') this.ui.setViewBase(data.id);
    if (action === 'abandon') openAbandonDialog(this.ui, base);
    if (action === 'toggleAlert') this.ui.result(g.shelter.setAlert(!g.shelter.alert));
    if (action === 'shareDefense') { openShareDialog(this.ui, 'defense', data.id); return; }
    if (action === 'facFilter') {
      this.facFilter = data.f;
      this.ui.refresh(true);
      return;
    }
    if (action === 'gotoTab') {
      this.ui.switchTab(data.tab);
      return;
    }
    const tab = this.ui.shelterTab;
    const root = this.ui.panelEl;
    if ((tab === 'storage' || tab === 'garage') && !SHELTER_ACTIONS.includes(action)) {
      const inv = this.ui.panels.inventory;
      const input = root?.querySelector('#inv-drop-qty');
      if (input) inv.dropQty = Number(input.value) || 1;
      inv.onAction(action, data);
      this.ui.refresh(true);
      // 手機上詳細資訊在格子下方：選取後捲動到可見位置
      if (action === 'selSupply' || action === 'selItem') root?.querySelector('.inv-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /** 保留輸入中的值（面板每秒重新繪製） */
  afterRender(el) {
    // 每秒重新繪製：保留手機版分頁列的捲動位置與「計算方式」的展開狀態
    const list = el.querySelector('.sh-nav-list');
    if (list) {
      list.scrollLeft = this.navScroll || 0;
      list.addEventListener('scroll', () => { this.navScroll = list.scrollLeft; }, { passive: true });
    }
    el.querySelector('.civ-more')?.addEventListener('toggle', (e) => { this.civOpen = e.target.open; });
    if (this.boundEl === el) return;
    this.boundEl = el;
    el.addEventListener('change', (e) => {
      if (this.ui.tab !== 'shelter' || !e.target.classList?.contains('def-gar-sel')) return;
      this.ui.result(this.game.shelter.garrison(this.ui.viewBase(), +e.target.dataset.slot, e.target.value || null));
      this.game.changed?.();
      this.ui.refresh(true);
    });
    const save = (e) => {
      if (e.target.id === 'inv-drop-qty') this.ui.panels.inventory.dropQty = Number(e.target.value) || 1;
    };
    el.addEventListener('input', save);
    el.addEventListener('change', save);
  }

  /** 防禦槽位卡片：數值（目前→下一級）、升級材料、時間、升級／拆除／駐守都直接顯示 */
  defCard(base, slot) {
    const g = this.game;
    const st = g.state;
    const d = base.defenses[slot];
    const busy = g.shelter.isSlotBusy(base, slot);
    const q = busy ? base.buildQueue.find((x) => x.kind === 'defense' && x.slot === slot) : null;
    if (!d.type && !q) {
      const can = Object.keys(DEFENSES).filter((t) => !g.shelter.defenseLockReason(t)).map((t) => DEFENSES[t].name);
      return `<div class="fac-card2 unbuilt def-card">
        <div class="fac2-head"><span class="fac-icon">➕</span><b>空地</b><small class="muted">槽位 ${slot + 1}</small></div>
        <small class="muted">${can.length ? `可建造：${can.join('、')}` : '目前沒有可建造的防禦建築'}</small>
        <div class="row-between"><span></span>${btn('建造', 'slot', { slot }, { cls: 'btn-sm btn-primary' })}</div>
      </div>`;
    }
    const type = d.type || q.id;
    const def = DEFENSES[type];
    const lv = d.level || 0;
    const s = lv > 0 ? def.stats(lv) : null;
    const max = lv >= DEFENSE_MAX_LEVEL;
    const n = max ? null : def.stats(lv + 1);
    const rows = [];
    const row = (k, cur, next) => rows.push(`<div class="row-between"><span class="muted">${k}</span><span>${cur ?? '—'}${next != null && next !== cur ? ` <span class="pos">→ ${next}</span>` : ''}</span></div>`);
    const pick = (o, f) => (o ? f(o) : null);
    if ((s || n)?.damage) row('傷害', pick(s, (x) => x.damage), pick(n, (x) => x.damage));
    if ((s || n)?.fireRate && !(s || n).garrison) row('攻速', pick(s, (x) => `${x.fireRate}/秒`), pick(n, (x) => `${x.fireRate}/秒`));
    if ((s || n)?.wallBonus) row('圍牆', pick(s, (x) => `+${x.wallBonus}`), pick(n, (x) => `+${x.wallBonus}`));
    if ((s || n)?.garrisonMul) row('駐守倍率', pick(s, (x) => `×${x.garrisonMul.toFixed(2)}`), pick(n, (x) => `×${x.garrisonMul.toFixed(2)}`));
    const powered = g.siege.of(base.id).powered();
    const power = def.power ? `<small class="${powered ? 'pos' : 'neg'}">⚡ ${powered ? '發電機運轉中，電網通電' : '沒有電！需要發電機運轉才會作用'}</small>` : '';
    let garrison = '';
    if (def.stats(1).garrison && lv > 0) {
      const cur = d.garrisonId ? g.survivors.get(d.garrisonId) : null;
      const ts = g.shelter.towerStatus(base, d);
      const chip = { on: '<span class="tw-st on">🟢 在塔上</span>', standby: '<span class="tw-st off">⚪ 待命</span>', none: '<span class="tw-st off">未設定</span>' }[ts.state];
      garrison = `<div class="def-gar"><div class="row-between"><small class="muted">👤 駐守人員：${cur ? `${g.survivors.classIcon(cur)} ${escapeHtml(cur.name)}（攻擊 ${g.survivors.stats(cur).atk}）` : '未設定'}</small>${chip}</div>
        ${ts.why ? `<small class="${ts.state === 'on' ? 'pos' : 'warn-text'} block">${escapeHtml(ts.why)}</small>` : ''}
        <select class="def-gar-sel" data-slot="${slot}" aria-label="駐守人員"><option value="">${cur ? '清除設定' : '選擇駐守人員'}</option>${st.survivors.filter((sv) => sv.id === d.garrisonId || !sv.severe).map((sv) => `<option value="${sv.id}" ${sv.id === d.garrisonId ? 'selected' : ''}>${g.survivors.classIcon(sv)} ${escapeHtml(sv.name)}</option>`).join('')}</select></div>`;
    }
    const cost = max ? null : g.shelter.defenseCost(type, lv + 1);
    const lack = cost && !affordable(st, cost);
    let foot;
    if (q) foot = `<div class="fac2-cost"><small class="muted">🔨 施工中（Lv${q.targetLevel}）</small>${timerBar(q.startAt, q.endAt)}</div>`;
    else if (max) foot = '<div class="row-between"><span class="tag tag-amber">MAX</span>' + btn('拆除', 'defDemolish', { slot }, { cls: 'btn-sm btn-ghost' }) + '</div>';
    else {
      foot = `<div class="fac2-cost"><div class="needs">${needHtml(st, cost)}</div>
        <div class="row-between"><small class="muted">⏱ ${formatDuration(g.shelter.buildSeconds(defenseBuildTime(lv + 1)) * 1000)}</small>
          <span class="btn-row">${btn('拆除', 'defDemolish', { slot }, { cls: 'btn-sm btn-ghost' })}${btn(lack ? '材料不足' : `升到 Lv${lv + 1}`, 'defBuild', { slot, type }, { cls: `btn-sm ${lack ? 'btn-lack' : 'btn-primary'}`, disabled: lack })}</span></div></div>`;
    }
    return `<div class="fac-card2 def-card">
      <div class="fac2-head"><span class="fac-icon">${def.icon}</span><b>${def.name}</b>${lv ? `<span class="rs-lv on">Lv${lv}</span>` : ''}<small class="muted">槽位 ${slot + 1}</small></div>
      <small class="muted">${def.desc}</small>
      ${rows.length ? `<div class="def-stats">${rows.join('')}</div>` : ''}
      ${power}${garrison}${foot}
    </div>`;
  }

  slotBody(base, slot) {
    const g = this.game;
    const st = g.state;
    const d = base.defenses[slot];
    const busy = g.shelter.isSlotBusy(base, slot);
    if (!d.type) {
      return `<p class="muted">選擇要在此槽位建造的防禦建築：</p>
      ${Object.entries(DEFENSES).map(([type, def]) => {
        const lock = g.shelter.defenseLockReason(type) || g.shelter.defenseLimitReason(base, slot, type);
        const s = def.stats(1);
        return `<div class="fac-card ${lock ? 'locked' : ''}">
          <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b>${def.limit ? ` <small class="tag">每個據點限 ${def.limit} 座</small>` : ''}<small class="muted block">${def.desc}</small></div></div>
          <div class="muted">${s.damage ? `傷害 ${s.damage}・` : ''}${s.fireRate ? `攻速 ${s.fireRate}/秒・` : ''}${s.wallBonus ? `圍牆 +${s.wallBonus}` : ''}</div>
          ${def.power ? `<div class="${g.siege.of(this.ui.viewBase()?.id).powered() ? 'pos' : 'neg'}">⚡ 需要發電機運轉${g.siege.of(this.ui.viewBase()?.id).powered() ? '（目前有電）' : '（目前沒電：建造發電機並保持燃料）'}</div>` : ''}
          <div class="row-between"><div class="costs">${costHtml(st, g.shelter.defenseCost(type, 1))}</div>
          ${lock ? `<span class="tag tag-red">🔒 ${lock}</span>` : btn('建造', 'build', { type }, { cls: 'btn-sm btn-primary' })}</div>
        </div>`;
      }).join('')}`;
    }
    const def = DEFENSES[d.type];
    const powerNote = def.power ? `<p class="${g.siege.of(this.ui.viewBase()?.id).powered() ? 'pos' : 'neg'}">⚡ ${g.siege.of(this.ui.viewBase()?.id).powered() ? '發電機運轉中，電網通電' : '沒有電！電網需要發電機運轉（建造發電機並保持燃料）才會作用'}</p>` : '';
    const s = d.level > 0 ? def.stats(d.level) : null;
    const n = def.stats(d.level + 1);
    const max = d.level >= DEFENSE_MAX_LEVEL;
    let garrison = '';
    if (d.type === 'watchPost' && d.level > 0) {
      const cur = d.garrisonId ? g.survivors.get(d.garrisonId) : null;
      const ts = g.shelter.towerStatus(this.ui.viewBase(), d);
      garrison = `<h4>駐守人員</h4>
        <p>${cur ? `設定：${g.survivors.classIcon(cur)} ${escapeHtml(cur.name)}（攻擊 ${g.survivors.stats(cur).atk}）・${ts.state === 'on' ? '🟢 在塔上' : '⚪ 待命'}` : '未設定'}</p>
        ${ts.why ? `<small class="muted block">${escapeHtml(ts.why)}</small>` : ''}
        <div class="chips">${st.survivors.filter((sv) => sv.status !== 'exploring').map((sv) => `<button class="chip ${sv.id === d.garrisonId ? 'active' : ''}" data-action="garrison" data-id="${sv.id}">${g.survivors.classIcon(sv)} ${escapeHtml(sv.name)}</button>`).join('')}
        ${cur ? '<button class="chip" data-action="garrison" data-id="">撤回</button>' : ''}</div>`;
    }
    return `
      <div class="fac-head"><span class="fac-icon">${def.icon}</span><div><b>${def.name}</b> Lv${d.level} ${busy ? '<span class="tag tag-amber">施工中</span>' : ''}<small class="muted block">${def.desc}</small></div></div>
      ${powerNote}
      ${s ? `<p>目前：${s.damage ? `傷害 ${s.damage}・` : ''}${s.fireRate ? `攻速 ${s.fireRate}・` : ''}${s.wallBonus ? `圍牆 +${s.wallBonus}` : ''}${s.garrisonMul ? `・駐守倍率 ×${s.garrisonMul.toFixed(2)}` : ''}</p>` : ''}
      ${max ? '<p class="tag">MAX</p>' : `<p class="muted">下一級：${n.damage ? `傷害 ${n.damage}・` : ''}${n.wallBonus ? `圍牆 +${n.wallBonus}` : ''}</p>
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

  /** 修繕狀態提示：缺零件改用純木材、木材不足無法修繕 */
  repairWarn() {
    const g = this.game;
    const rs = g.shelter.repairStatus();
    if (rs.mode === 'woodOnly') return `<small class="block" style="color:#ffb74d">⚠️ 缺少${rs.missing.map((k) => `${metaOf(k).icon}${metaOf(k).name}`).join('、')}，改用純木材修繕（每點耗木材 ×1.5、速度減半）</small>`;
    if (rs.mode === 'noWood') return '<small class="neg block">⚠️ 木材不足，無法修繕圍牆</small>';
    return '';
  }
}

