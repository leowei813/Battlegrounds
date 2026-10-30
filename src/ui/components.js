import { RESOURCES, CURRENCIES } from '../config/constants.js';
import {
  RARITIES, SLOTS, AFFIXES, ITEM_TYPES, ITEM_MODELS, itemSize, itemWeight,
} from '../config/equipment.js';
import { CLASSES, JOBS, xpToNext } from '../config/survivors.js';
import { escapeHtml } from '../utils/dom.js';
import { formatNumber, formatDuration } from '../utils/math.js';
import { canAfford } from '../systems/costUtils.js';

/** 共用 UI 片段（回傳 HTML 字串）。 */

const META = { ...RESOURCES, ...CURRENCIES };

export function costHtml(state, cost = {}) {
  return Object.entries(cost)
    .map(([k, v]) => {
      const have = k in state.resources ? state.resources[k] : state.player[k] ?? 0;
      const ok = have >= v;
      return `<span class="cost ${ok ? '' : 'lack'}" title="${META[k]?.name || k}">${META[k]?.icon || k}${formatNumber(v)}</span>`;
    })
    .join('');
}

export function gainsHtml(gains = {}) {
  const parts = Object.entries(gains)
    .filter(([, v]) => Math.round(v) !== 0)
    .map(([k, v]) => `<span class="gain ${v < 0 ? 'neg' : ''}">${META[k]?.icon || k}${v > 0 ? '+' : ''}${formatNumber(v)}</span>`);
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

export function statLine(stats) {
  const fmt = {
    atk: ['攻擊', (v) => Math.round(v)], def: ['防禦', (v) => Math.round(v)], hp: ['生命', (v) => Math.round(v)],
    crit: ['暴擊', (v) => `${(v * 100).toFixed(1)}%`], critDmg: ['暴傷', (v) => `+${(v * 100).toFixed(0)}%`],
    dodge: ['閃避', (v) => `${(v * 100).toFixed(1)}%`], atkSpeed: ['攻速', (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))],
    lootBonus: ['搜刮', (v) => `+${(v * 100).toFixed(0)}%`],
    lifeSteal: ['吸血', (v) => `${(v * 100).toFixed(1)}%`],
    exploreSpeed: ['探索速度', (v) => `+${(v * 100).toFixed(1)}%`],
    carry: ['運載', (v) => `+${v}`],
  };
  return Object.entries(stats)
    .filter(([k]) => fmt[k])
    .map(([k, v]) => `<span>${fmt[k][0]} ${fmt[k][1](v)}</span>`)
    .join('');
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
  actions = '', equippedBy = null, compact = false, carrier = null,
} = {}) {
  if (!item) return '';
  const r = RARITIES[item.rarity];
  return `
  <div class="item-card r-${item.rarity} ${compact ? 'compact' : ''}" style="--rc:${r.color}">
    <div class="item-head">
      <span class="item-icon">${ITEM_MODELS[item.model]?.icon || ITEM_TYPES[item.type]?.icon || '❔'}</span>
      <div class="item-title">
        <b>${escapeHtml(item.name)}</b>${item.locked ? ' 🔒' : ''}
        <small>${rarityTag(item.rarity)} ${ITEM_TYPES[item.type]?.name || ''}${item.tier ? ` T${item.tier}` : ''} · Lv${item.level} · 戰力 ${item.power} · 📦${itemSize(item)}格 ⚖️${itemWeight(item)} ${compact ? '' : qualityTag(item)}</small>
      </div>
    </div>
    ${compact ? '' : `<div class="stat-line">${statLine(item.stats)}</div>
    ${item.affixes.length ? `<ul class="affixes">${affixLines(item)}</ul>` : ''}`}
    ${equippedBy ? `<div class="equipped-by">已裝備：${escapeHtml(equippedBy.name)}</div>` : carrier ? `<div class="equipped-by">🎒 ${escapeHtml(carrier.name)} 攜帶中</div>` : ''}
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

export function survivorStatus(game, sv, now = Date.now()) {
  const tags = [];
  const death = game.survivors.deathCountdown(sv, now);
  if (death != null) tags.push(`<span class="tag tag-red blink">⚰️ ${formatDuration(death)} 後死亡</span>`);
  if (sv.severe) tags.push('<span class="tag tag-red">🩸 重傷</span>');
  if (game.survivors.isStarving()) tags.push('<span class="tag tag-red">🍽️ 飢餓</span>');
  if (sv.status === 'exploring') tags.push('<span class="tag tag-blue">探索中</span>');
  else if (!sv.severe && game.survivors.isGarrisoned(sv.id)) tags.push('<span class="tag tag-amber">駐守瞭望塔</span>');
  else if (!sv.severe) tags.push(`<span class="tag">${JOBS[sv.job]?.icon || ''} ${JOBS[sv.job]?.name || '閒置'}</span>`);
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
