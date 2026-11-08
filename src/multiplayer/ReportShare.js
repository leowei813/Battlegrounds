/**
 * 分享探索報告／避難所紀錄到全服聊天室。
 * 聊天每則最多 120 字，所以整理成一行摘要（以「｜」分段），聊天室辨識開頭後顯示成卡片；
 * 不需要伺服器支援，舊版遊戲看到的就是一般文字。不包含避難所座標與倉庫數量。
 */
import { CHAT_MAX_LEN } from './Chat.js';
import { metaOf } from '../ui/components.js';
import { RARITIES } from '../config/equipment.js';
import { ZONES } from '../config/zones.js';

/** 分享卡片的種類：開頭文字 → 樣式 */
export const SHARE_KINDS = [
  { head: '🧭探索報告', cls: 'explore' },
  { head: '🧟屍潮防守', cls: 'siege' },
  { head: '🛡️據點防守', cls: 'siege' },
];
export const SHARE_NOTE_MAX = 20;
const SEP = '｜';
/** 分享的完整內容存成共用物件（聊天訊息只帶連結編號，點卡片時讀取） */
export const SHARE_OBJ_KIND = 'rs';
const LINK = '🔗';
const LINK_RE = /^🔗([a-z0-9]{6,16})$/;

/**
 * 分享內容放在南方海上的固定座標（依編號決定，彼此相隔約 1 公里以上），
 * 讀取時只查那一小格，就只會拿到這一份（不需要伺服器另外提供單筆查詢）。
 */
export function shareCoord(id) {
  let h1 = 2166136261;
  let h2 = 5381;
  for (const ch of String(id)) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + ch.charCodeAt(0)) >>> 0;
  }
  return { lat: -60 - (h1 % 1000) * 0.01, lon: -179 + (h2 % 35800) * 0.01 };
}
/** 讀取分享內容時的查詢範圍（公里） */
export const SHARE_QUERY_KM = 0.2;

const strip = (o) => JSON.parse(JSON.stringify(o ?? null));

/** 分享的完整內容：拿掉戰鬥明細編號等只在自己存檔有意義的欄位（本來就不含據點座標與倉庫數量） */
export function shareDetail(kind, src) {
  const x = strip(src) || {};
  ['battleIds', 'assistMemberIds', 'assistPlayerId', 'assistPending', 'lat', 'lon', 'poiId', 'baseId'].forEach((k) => delete x[k]);
  if (Array.isArray(x.events) && x.events.length > 60) x.events = x.events.slice(0, 60);
  const data = { t: kind, v: 1, x };
  // 共用物件上限 16KB：太大時只保留前面的事件
  while (JSON.stringify(data).length > 15000 && Array.isArray(x.events) && x.events.length > 5) x.events = x.events.slice(0, Math.floor(x.events.length / 2));
  return data;
}

const clean = (s) => String(s ?? '').replace(/[｜\n\r]/g, ' ').trim();

/** 把各段組成一則訊息，超過字數上限時從收穫開始縮短 */
function compose(parts, note, link = '') {
  const tail = (note ? `${SEP}「${clean(note).slice(0, SHARE_NOTE_MAX)}」` : '') + (link ? `${SEP}${LINK}${link}` : '');
  let segs = parts.filter(Boolean).map(clean);
  const len = (arr) => [...(arr.join(SEP) + tail)].length;
  while (len(segs) > CHAT_MAX_LEN && segs.length > 2) {
    const last = segs[segs.length - 1].split(' ');
    if (last.length > 1) segs[segs.length - 1] = last.slice(0, -1).join(' ');
    else segs = segs.slice(0, -1);
  }
  return [...(segs.join(SEP) + tail)].slice(0, CHAT_MAX_LEN).join('');
}

/** 收穫：裝備（高品級優先）與數量最多的物資，最多 4 項 */
function topGains(resources = {}, items = [], max = 4) {
  const out = [];
  [...items].sort((a, b) => (RARITIES[b.rarity]?.sell || 0) - (RARITIES[a.rarity]?.sell || 0)).slice(0, 2)
    .forEach((it) => out.push(`${RARITIES[it.rarity]?.name || ''}${it.name}`));
  Object.entries(resources).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => { if (out.length < max) out.push(`${metaOf(k).icon}×${Math.floor(v)}`); });
  return out.slice(0, max).join(' ');
}

/** 探索報告 → 分享文字 */
export function shareReportText(r, note = '', link = '') {
  const zone = ZONES.find((z) => z.id === r.zone);
  const zoneText = zone ? `${zone.danger >= 2 ? '☠️' : zone.danger >= 1 ? '⚠️' : '🟢'}${zone.name}` : '';
  const result = [r.success ? '✅成功' : r.retreated ? '🏳️撤退' : r.recalled ? '🏠召回' : '⚠️受挫', zoneText, r.kills ? `擊殺${r.kills}` : ''].filter(Boolean).join('・');
  return compose(['🧭探索報告', r.poiName || '未知地點', result, topGains(r.resources, r.items) || (r.emptied ? '🕸️已被搜空' : '')], note, link);
}

/** 避難所紀錄（屍潮、NPC 掠奪、玩家突襲）→ 分享文字 */
export function shareDefenseText(e, note = '', link = '') {
  const s = e.siege;
  const base = e.baseName ? `🏠${clean(e.baseName)}` : '';
  const hurt = (s?.injuries || e.injuries || []).filter((x) => !x.ok);
  const sev = hurt.filter((x) => x.severe).length;
  const hurtText = hurt.length ? `🩹${[hurt.length - sev ? `輕傷${hurt.length - sev}` : '', sev ? `重傷${sev}` : ''].filter(Boolean).join('')}` : '';
  const lostText = () => {
    const mats = Object.values(s?.materials || {}).reduce((a, b) => a + b, 0);
    const res = s?.lossPct ? `📉資源−${s.lossPct}%` : Object.entries(e.lost || {}).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, v]) => `${metaOf(k).icon}−${Math.floor(v)}`).join(' ');
    return [res, mats ? `🧰材料−${mats}` : '', e.coins ? `💰−${e.coins}` : '', e.damaged?.length ? `🏚️設施損毀${e.damaged.length}` : '', hurtText].filter(Boolean).join(' ');
  };
  if (s) {
    const waves = e.success ? (e.waves ? `${e.waves}波` : '') : s.maxWaves ? `撐過${Math.max(0, (s.wave || 1) - 1)}/${s.maxWaves}波` : '';
    const wall = e.success ? (s.wallPct != null ? `城牆剩${s.wallPct}%` : '') : e.wallLost ? `圍牆−${e.wallLost}` : '';
    const stat = [waves, e.kills ? `擊殺${e.kills}` : '', wall, e.success && s.gradeName ? `評價${s.gradeName}` : ''].filter(Boolean).join('・');
    const gains = e.success ? [s.coins ? `💰+${s.coins}` : '', ...Object.entries(s.items || {}).slice(0, 3).map(([k, v]) => `${metaOf(k).icon}×${v}`)].filter(Boolean).join(' ') : lostText();
    return compose(['🧟屍潮防守', e.success ? '守住了！' : '被突破了', [base, stat].filter(Boolean).join('・'), gains], note, link);
  }
  const stat = [base, e.kills ? `擊倒${e.kills}` : '', e.wallLost ? `圍牆−${e.wallLost}` : ''].filter(Boolean).join('・');
  const r = e.reward;
  const gains = e.success ? (r ? [r.coins ? `💰+${r.coins}` : '', r.gear?.length ? `🎁裝備×${r.gear.length}` : ''].filter(Boolean).join(' ') : '') : lostText();
  return compose(['🛡️據點防守', `${e.success ? '擊退' : '未能擋下'}${clean(e.attacker)}`, stat, gains], note, link);
}

/** 聊天訊息是不是分享卡片：回傳 {cls, title, lines, note} 或 null */
export function parseShare(text) {
  const t = String(text || '');
  const kind = SHARE_KINDS.find((k) => t.startsWith(k.head + SEP));
  if (!kind) return null;
  const segs = t.split(SEP);
  let link = '';
  const lm = LINK_RE.exec(segs[segs.length - 1] || '');
  if (lm) { link = lm[1]; segs.pop(); }
  let note = '';
  if (/^「.*」$/.test(segs[segs.length - 1])) note = segs.pop().slice(1, -1);
  return { cls: kind.cls, title: `${segs[0]}｜${segs[1] || ''}`, lines: segs.slice(2).filter(Boolean), note, link };
}

/** 這份報告是否已經分享過（每份只能分享一次） */
export function isShared(game, id) {
  return !!game.state.sharedReports?.[id];
}

export function markShared(game, id) {
  const st = game.state;
  st.sharedReports = st.sharedReports || {};
  st.sharedReports[id] = Date.now();
  // 只保留最近 100 筆
  const keys = Object.keys(st.sharedReports);
  if (keys.length > 100) keys.sort((a, b) => st.sharedReports[a] - st.sharedReports[b]).slice(0, keys.length - 100).forEach((k) => delete st.sharedReports[k]);
}
