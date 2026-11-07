import { DG_PIN_SVG } from './DungeonView.js';
import { RESOURCES, CURRENCIES } from '../config/constants.js';
import {
  RARITIES, SLOTS, AFFIXES, ITEM_TYPES, ITEM_MODELS, itemWeight,
} from '../config/equipment.js';
import { CLASSES, JOBS, xpToNext } from '../config/survivors.js';
import { escapeHtml } from '../utils/dom.js';
import { formatNumber, formatDuration } from '../utils/math.js';
import { canAfford, amountOf } from '../systems/costUtils.js';
import { SUPPLIES } from '../config/supplies.js';

/** 共用 UI 片段（回傳 HTML 字串）。 */

const META = { ...RESOURCES, ...CURRENCIES, ...SUPPLIES };
/** 資源、貨幣、材料物品的名稱與圖示 */
export const metaOf = (k) => META[k] || { name: k, icon: '❔' };

export function costHtml(state, cost = {}) {
  return Object.entries(cost)
    .map(([k, v]) => {
      const have = amountOf(state, k);
      const ok = have >= v;
      const m = metaOf(k);
      // 材料物品顯示名稱，避免只看圖示分不出種類
      const label = SUPPLIES[k] ? `${m.icon}${m.name}×` : m.icon;
      return `<span class="cost ${ok ? '' : 'lack'}" title="${m.name}（擁有 ${formatNumber(have)}）">${label}${formatNumber(v)}</span>`;
    })
    .join('');
}

/** 所需材料：每項顯示「名稱 擁有/需要」，不夠的以紅色標示 */
export function needHtml(state, cost = {}, highlight = []) {
  return Object.entries(cost)
    .map(([k, v]) => {
      const have = amountOf(state, k);
      const m = metaOf(k);
      return `<span class="need ${have >= v ? (highlight.includes(k) ? 'prev' : '') : 'lack'}" title="${m.name}：擁有 ${formatNumber(have)}，需要 ${formatNumber(v)}">${m.icon} ${m.name} <b>${formatNumber(Math.floor(have))}</b>/${formatNumber(v)}</span>`;
    })
    .join('');
}

export function gainsHtml(gains = {}) {
  const parts = Object.entries(gains)
    .filter(([, v]) => Math.round(v) !== 0)
    .map(([k, v]) => `<span class="gain ${v < 0 ? 'neg' : ''}" title="${metaOf(k).name}">${metaOf(k).icon}${SUPPLIES[k] ? metaOf(k).name : ''}${v > 0 ? '+' : ''}${formatNumber(v)}</span>`);
  return parts.length ? parts.join('') : '<span class="muted">無</span>';
}

export const affordable = (state, cost) => canAfford(state, cost);

export function progressBar(ratio, cls = '', label = '') {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  return `<div class="bar ${cls}"><div class="bar-fill" style="width:${pct}%"></div>${label ? `<span>${label}</span>` : ''}</div>`;
}

export function timerBar(startAt, endAt, now = Date.now()) {
  const ratio = (now - startAt) / Math.max(1, endAt - startAt);
  return progressBar(ratio, 'timer', formatDuration(endAt - now));
}

export function rarityTag(rarity) {
  const r = RARITIES[rarity] || RARITIES.common;
  return `<span class="rarity r-${rarity}" style="--rc:${r.color}">${r.name}</span>`;
}

/** 素質（該品級範圍內的位置），例如「素質 132%（精良 120–145%）」 */
export function qualityTag(item) {
  if (!item.quality) return '';
  const r = RARITIES[item.rarity];
  const pos = Math.max(0, Math.min(1, (item.quality / 100 - r.min) / (r.max - r.min)));
  return `<span class="quality" title="${r.name}素質範圍 ${Math.round(r.min * 100)}–${Math.round(r.max * 100)}%">素質 ${item.quality}%<i style="--p:${Math.round(pos * 100)}%"></i></span>`;
}

const STAT_FMT = {
  atk: ['攻擊', (v) => Math.round(v)], def: ['防禦', (v) => Math.round(v)], hp: ['生命', (v) => Math.round(v)],
  crit: ['暴擊', (v) => `${(v * 100).toFixed(1)}%`], critDmg: ['暴傷', (v) => `+${(v * 100).toFixed(0)}%`],
  dodge: ['閃避', (v) => `${(v * 100).toFixed(1)}%`], atkSpeed: ['攻速', (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))],
  lootBonus: ['搜刮', (v) => `+${(v * 100).toFixed(0)}%`],
  lifeSteal: ['吸血', (v) => `${(v * 100).toFixed(1)}%`],
  exploreSpeed: ['探索速度', (v) => `+${(v * 100).toFixed(1)}%`],
  carry: ['運載', (v) => `+${v}`],
  slots: ['背包格', (v) => `+${v}`],
};

export function statLine(stats) {
  return Object.entries(stats)
    .filter(([k]) => STAT_FMT[k])
    .map(([k, v]) => `<span>${STAT_FMT[k][0]} ${STAT_FMT[k][1](v)}</span>`)
    .join('');
}

/**
 * 與目前裝備比較：列出所有能力（含附加詞條）的差異，較好▲綠、較差▼紅。
 * @param {object} game
 * @param {object} item 候選裝備
 * @param {object|null} cur 目前的裝備
 */
export function compareHtml(game, item, cur) {
  const a = game.equipment.itemStats(item);
  const b = cur ? game.equipment.itemStats(cur) : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => STAT_FMT[k]);
  const rows = keys.map((k) => {
    const d = (a[k] || 0) - (b[k] || 0);
    if (Math.abs(d) < 1e-9) return '';
    const [name, f] = STAT_FMT[k];
    const good = k === 'weight' ? d < 0 : d > 0;
    return `<span class="${good ? 'pos' : 'neg'}">${name} ${d > 0 ? '▲' : '▼'}${f(Math.abs(d))}</span>`;
  }).filter(Boolean);
  const pd = (item.power || 0) - (cur?.power || 0);
  return `<div class="compare"><b class="${pd >= 0 ? 'pos' : 'neg'}">戰力 ${pd >= 0 ? '▲' : '▼'}${Math.abs(pd)}</b>${rows.join('') || '<span class="muted">能力相同</span>'}</div>`;
}

/** 能力範圍（最小值～最大值） */
export function statRangeLine(range) {
  return Object.entries(range)
    .filter(([k]) => STAT_FMT[k])
    .map(([k, [a, b]]) => {
      const [name, f] = STAT_FMT[k];
      return `<span>${name} ${a === b ? f(a) : `${f(a)}～${f(b)}`}</span>`;
    })
    .join('');
}

/** 詞條素質：數值落在該品級可擲出範圍內的位置（0～100%） */
export function affixQuality(item, { id, value }) {
  const a = AFFIXES[id];
  const r = RARITIES[item.rarity];
  if (!a || !r) return null;
  const base = a.value + (a.perLevel || 0) * ((item.level || 1) - 1);
  if (!(base > 0) || r.max <= r.min) return null;
  return Math.round(Math.max(0, Math.min(1, (value / base - r.min) / (r.max - r.min))) * 100);
}

/** 附加詞條（裝備欄）：數值與素質，滿素質（100%）才以金色底標示 */
export function affixChips(item) {
  return (item.affixes || []).map((af) => {
    const a = AFFIXES[af.id];
    if (!a) return '';
    const { value } = af;
    const v = a.pct ? `${(value * 100).toFixed(1)}%` : value < 1 ? value.toFixed(2) : Math.round(value);
    const q = affixQuality(item, af);
    return `<span class="affix-chip ${q === 100 ? 'max' : ''}">✦ ${a.name.replace('%', '')} +${v}${q != null ? `<small>素質 ${q}%</small>` : ''}</span>`;
  }).join('');
}

export function affixLines(item) {
  return item.affixes
    .map(({ id, value }) => {
      const a = AFFIXES[id];
      const v = a.pct ? `${(value * 100).toFixed(1)}%` : value < 1 ? value.toFixed(2) : Math.round(value);
      return `<li>+${v} ${a.name.replace('%', '')}</li>`;
    })
    .join('');
}

export function itemCard(item, {
  actions = '', equippedBy = null, compact = false, carrier = null, ammoWarn = null,
} = {}) {
  if (!item) return '';
  const r = RARITIES[item.rarity];
  return `
  <div class="item-card r-${item.rarity} ${compact ? 'compact' : ''} ${ammoWarn ? 'noammo' : ''}" style="--rc:${r.color}">
    <div class="item-head">
      <span class="item-icon">${ITEM_MODELS[item.model]?.icon || ITEM_TYPES[item.type]?.icon || '❔'}</span>
      <div class="item-title">
        <b>${escapeHtml(item.name)}</b>${item.locked ? ' 🔒' : ''}${ammoWarn ? ` <span class="ammo-badge">⚠️ ${ammoWarn.level === 'low' ? '彈藥不足' : '無彈藥'}</span>` : ''}
        <small>${rarityTag(item.rarity)} ${ITEM_TYPES[item.type]?.name || ''}${item.tier ? ` T${item.tier}` : ''} · Lv${item.level} · 戰力 ${item.power} · ⚖️${itemWeight(item)} ${compact ? '' : qualityTag(item)}</small>
      </div>
    </div>
    ${compact ? '' : `<div class="stat-line">${statLine(item.stats)}</div>
    ${item.affixes.length ? `<ul class="affixes">${affixLines(item)}</ul>` : ''}`}
    ${ammoWarn ? `<small class="neg block">需要${escapeHtml(ammoWarn.name)}：${ammoWarn.level === 'low' ? '不夠一場戰鬥使用' : '沒有彈藥時戰鬥只能用近戰武器'}</small>` : ''}
    ${equippedBy ? `<div class="equipped-by">已裝備：${escapeHtml(equippedBy.name)}</div>` : carrier ? `<div class="equipped-by">🎒 ${escapeHtml(carrier.name)} 攜帶中</div>` : ''}
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

/** 瞭望塔標示：在塔上（棕色）或設定了但待命（灰色） */
export function towerTag(game, sv) {
  if (!game.shelter.garrisonOf(sv.id)) return '';
  return game.shelter.onTower(sv.id) ? '<span class="tag tw-tag">🛖 瞭望塔</span>' : '<span class="tag tw-tag off">🛖 瞭望塔待命</span>';
}

/** 外出中的倖存者正在做什麼（依所在隊伍的任務類型） */
const OUT_LABELS = {
  rally: '🚩 集結中', raid: '⚔️ 攻打中', pvp: '⚔️ 突襲中', infect: '☣️ 淨化中', assist: '🛡️ 協防中', intercept: '🎯 攔截中', hunt: '🧟 獵殺中',
};
export function outLabel(game, sv) {
  const ex = (game.state.expeditions || []).find((e) => e.memberIds?.includes(sv.id));
  if (sv.dungeon && !ex) return `<span class="dg-ic-inline">${DG_PIN_SVG}</span>副本中`;
  return flagText(OUT_LABELS[ex?.kind] || '探索中');
}

export function survivorStatus(game, sv, now = Date.now()) {
  const tags = [];
  const death = game.survivors.deathCountdown(sv, now);
  if (death != null) tags.push(`<span class="tag tag-red blink">⚰️ ${formatDuration(death)} 後死亡</span>`);
  if (sv.severe) tags.push('<span class="tag tag-red">🩸 重傷</span>');
  if (game.survivors.isStarving()) tags.push('<span class="tag tag-red">🍽️ 飢餓</span>');
  if (sv.status === 'exploring') tags.push(`<span class="tag tag-blue">${outLabel(game, sv)}</span>`);
  else if (!sv.severe) tags.push(`<span class="tag">${JOBS[sv.job]?.icon || ''} ${JOBS[sv.job]?.name || '閒置'}</span>`);
  // 副本：今天已報名（還沒結算）
  const dg = !sv.dungeon && game.dungeon?.signedDungeon(sv.id, now);
  if (dg && !game.dungeon.state.sign[`${dg}-${game.dungeon.constructor.dayKey(now)}`]?.settled) tags.push(`<span class="tag tag-dg" title="今天報名地下感染區，17:50 鎖定"><span class="dg-ic-inline">${DG_PIN_SVG}</span>副本${game.dungeon.isLocked(sv, now) ? '・已鎖定' : ''}</span>`);
  const tw = towerTag(game, sv);
  if (tw) tags.push(tw);
  return `<span class="tags">${tags.join('')}</span>`;
}

/** 生命條（重傷時顯示脫離重傷的門檻） */
export function hpBar(game, sv) {
  const max = game.survivors.maxHp(sv);
  const hp = game.survivors.hpOf(sv);
  const cls = sv.severe || hp / max < 0.3 ? 'danger' : 'hp';
  return progressBar(hp / max, cls, `❤️ ${Math.floor(hp)}/${max}${sv.severe ? '（30% 脫離重傷）' : ''}`);
}

export function survivorCard(game, sv, { actions = '', selected = false } = {}) {
  const cls = CLASSES[sv.classId];
  const s = game.survivors.stats(sv);
  const r = sv.isLeader ? { color: '#ffd54f' } : RARITIES[sv.rarity] || RARITIES.common;
  return `
  <div class="sv-card r-${sv.rarity} ${sv.severe ? 'severe' : ''} ${selected ? 'selected' : ''}" style="--cc:${cls.color};--rc:${r.color}">
    <div class="sv-head">
      <span class="sv-icon">${cls.icon}</span>
      <div class="sv-title">
        <b>${escapeHtml(sv.name)}${sv.isLeader ? ' 👑' : ''}</b>
        <small>${sv.isLeader ? '' : rarityTag(sv.rarity)} ${cls.name} Lv${sv.level} · 戰力 ${s.power} · 成長 ×${game.survivors.growthMul(sv)}</small>
      </div>
    </div>
    <div class="sv-status">${survivorStatus(game, sv)}</div>
    ${hpBar(game, sv)}
    ${progressBar(sv.xp / xpToNext(sv.level), 'xp', `XP ${sv.xp}/${xpToNext(sv.level)}`)}
    ${(() => {
    // 負重狀況
    const load = Math.floor(game.survivors.bagLoad(sv));
    const cap = game.survivors.bagCap(sv);
    return progressBar(cap ? load / cap : 0, load >= cap ? 'danger' : 'load', `🎒 負重 ${load}/${cap}・格子 ${game.equipment.bagSlotsUsed(sv)}/${game.equipment.bagSlotCap(sv)}`);
  })()}
    <div class="stat-line">${statLine({ hp: s.hp, atk: s.atk, def: s.def, crit: s.crit, dodge: s.dodge })}<span>攻速 ${s.atkSpeed}</span></div>
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

export function slotName(slot) {
  return `${SLOTS[slot].icon} ${SLOTS[slot].name}`;
}

export function btn(label, action, data = {}, { cls = '', disabled = false, title = '' } = {}) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`).join(' ');
  return `<button class="btn ${cls}" data-action="${action}" ${attrs} ${disabled ? 'disabled' : ''} ${title ? `title="${escapeHtml(title)}"` : ''}>${label}</button>`;
}

/** 集結戰旗小圖示（紫底金框＋金旗，與地圖上的集結圖示相同；不用表情符號，各種手機顯示一致） */
export function rallyFlag(size = 16) {
  return `<svg class="rally-flag" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#311b92" stroke="#ffd54f" stroke-width="2.5"/><path d="M8 5v14" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M9 5h9l-2.6 3.5L18 12H9z" fill="#ffd54f"/></svg>`;
}

/** 文字中的 🚩（集結）換成集結戰旗小圖示；傳入的字串必須已經過 escapeHtml */
export function flagText(html, size = 14) {
  return String(html).replace(/🚩/g, rallyFlag(size));
}
