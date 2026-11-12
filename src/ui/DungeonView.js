import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { btn, metaOf } from './components.js';
import { DungeonSystem } from '../systems/DungeonSystem.js';
import {
  DUNGEONS, DUNGEON_KEYS, DG_TIME, DG_FLOORS, DG_TEAM, DG_CLASS_NOTES, DG_OBSTACLES, DG_BOSSES, DG_FINAL_SKILL, DG_DROPS,
  DG_CORES, DG_RULES, DG_GEAR, DG_SLOTS, DG_CRAFT, DG_RECIPES,
} from '../config/dungeons.js';
import { CLASSES } from '../config/survivors.js';
import { SUPPLIES } from '../config/supplies.js';

const DAY = 24 * 3600 * 1000;
const fmt = (n) => Math.round(n || 0).toLocaleString();
const clsIcon = (c) => CLASSES[c]?.icon || '❔';
/** 行內的副本圖示（與地圖上的入口圖示相同） */
export const dgIcon = () => `<span class="dg-ic-inline">${DG_PIN_SVG}</span>`;

/** 地圖圖示：地裂獸口（地面裂開的紅色裂口，裡面一對發光的眼睛） */
export const DG_PIN_SVG = `<svg viewBox="0 0 56 46" width="100%" height="100%" aria-hidden="true"><defs><radialGradient id="dgh" cx="50%" cy="55%" r="60%"><stop offset="0" stop-color="#ff1744"/><stop offset=".35" stop-color="#4a0010"/><stop offset="1" stop-color="#000"/></radialGradient></defs><path d="M4 26 L14 14 L20 19 L28 8 L35 17 L42 12 L52 26 L44 38 L33 33 L26 41 L17 34 L8 38 Z" fill="url(#dgh)" stroke="#ff5252" stroke-width="1.6"/><circle cx="22" cy="25" r="2.6" fill="#ffeb3b"/><circle cx="33" cy="25" r="2.6" fill="#ffeb3b"/><path d="M20 31 q8 4 16 0" stroke="#ff8a80" stroke-width="1.4" fill="none"/></svg>`;

/** 今天（結算後到隔天 00:00 前）要顯示在地圖左上角的報名紀錄 */
export function hudRecords(g, now = Date.now()) {
  return Object.values(g.dungeon.state.sign).filter((r) => !r.cancelled && now >= r.day0 && now < r.day0 + DAY + DG_TIME.open)
    .sort((a, b) => DUNGEON_KEYS.indexOf(a.dg) - DUNGEON_KEYS.indexOf(b.dg));
}

/**
 * 一筆報名目前的狀態（資訊框與詳細資訊共用）。
 * @returns {{tag:string, cls:string, sub:string, floor:string, time:string, inf:number|null, hp:number|null, run?:object, i?:number}}
 */
export function statusOf(g, rec, now = Date.now()) {
  const t = DungeonSystem.times(rec.day0);
  const data = g.dungeon.data(rec.dg, rec.day);
  const n = (data?.list || []).length;
  const base = {
    floor: `—/${DG_FLOORS}`, time: '', inf: null, hp: null, sub: '',
  };
  if (rec.settled && rec.excluded === 'nomed') return { ...base, floor: '—', tag: '無法出擊', cls: 't-fail', sub: '重傷且倉庫沒有藥品，今天無法參加' };
  if (rec.excluded === 'nomed') return { ...base, floor: '—', tag: '無法出擊', cls: 't-fail', sub: '重傷且倉庫沒有藥品，今天無法參加' };
  if (rec.excluded === 'guard') return { ...base, floor: '—', tag: '無法出擊', cls: 't-fail', sub: '正在駐防控制點，不會被叫回，今天無法參加' };
  // 報名人數：不到 3 人橘紅色、3 人以上綠色
  const short = `<span class="dg-cnt ${n < DG_TEAM.min ? 'low' : 'ok'}">👥 ${n} 人</span>`;
  if (now < t.close) return { ...base, floor: short, tag: '已報名', cls: 't-sign', sub: `目前 ${n} 人報名・17:40 截止，18:00 開打` };
  if (now < t.lock) return { ...base, floor: short, tag: '已截止', cls: 't-sign', sub: `${n} 人報名・17:50 鎖定、18:00 開打` };
  if (now < t.start) {
    const gp = DungeonSystem.groupsOf(data);
    const me = g.dungeon.myId();
    if (gp.cancelled) return { ...base, floor: '—', tag: '人數不足', cls: 't-cancel', sub: `報名 ${gp.list?.length || 0} 人（至少 ${DG_TEAM.min} 人），開打時取消` };
    const gi = gp.groups.findIndex((x) => x.some((e) => e.p === me));
    const size = gi >= 0 ? gp.groups[gi].length : 0;
    // 超過 8 人（分成兩團以上）才顯示第幾團
    const team = gp.groups.length > 1 ? `第 ${gi + 1} 團 ${size} 人` : `${size} 人`;
    if (now < t.depart) return { ...base, floor: team, tag: '🔒 已鎖定', cls: 't-lock', sub: `${team}・17:55 出發集結` };
    return { ...base, floor: team, tag: '集結中', cls: 't-gather', sub: `前往副本入口・${team}・剩 ${formatDuration(t.start - now)} 開打` };
  }
  const mine = g.dungeon.myRun(rec);
  if (!mine) return { ...base, tag: '同步中', cls: 't-sign', sub: '正在讀取副本資料…' };
  if (mine.cancelled) return { ...base, floor: '—', tag: '今日取消', cls: 't-cancel', sub: `報名人數不足（至少 ${DG_TEAM.min} 人）・倖存者已回到避難所，沒有扣除任何東西` };
  if (mine.out || mine.missing) return { ...base, floor: '—', tag: '無法出擊', cls: 't-fail', sub: '鎖定時重傷且藥品不足，今天無法參加' };
  const { run, i } = mine;
  const shown = DungeonSystem.revealed(run, now);
  const last = run.floors[shown - 1];
  const out = {
    ...base, run, i, inf: last?.inf2 ?? last?.inf ?? 0, hp: last ? last.hp?.[i] ?? null : 100,
  };
  if (now >= run.endAt) {
    const clear = run.result === 'clear';
    const rw = run.rewards[i];
    return {
      ...out, tag: clear ? '🏆 通關' : '失敗', cls: clear ? 't-win' : 't-fail', floor: `${run.endFloor}/${DG_FLOORS} 層`, time: formatDuration(run.endAt - run.start),
      sub: clear ? `${rw.bps.length ? '✨ 拿到圖紙！' : ''}點這裡看副本報告` : `停在第 ${run.endFloor} 層・已通過的獎勵保留`, done: true,
    };
  }
  const f = DungeonSystem.floorAt(run, now);
  out.floor = `${f}/${DG_FLOORS} 層`;
  out.time = formatDuration(now - run.start);
  const sevNow = last ? last.hp?.[i] === 0 : false;
  const restJust = shown > 0 && shown % DG_RULES.restEvery === 0 && run.floors[shown - 1]?.rest && now - (run.start + shown * DG_TIME.floorMs) < 3 * 60000;
  if (sevNow) return { ...out, tag: '🩸 重傷・隨隊', cls: 't-down', sub: run.members.some((m) => m.c === 'medic') ? '下一個休息站醫生可以救回' : '隊上沒有醫生，結束前都無法救回' };
  if (restJust) {
    const r = run.floors[shown - 1].rest;
    return { ...out, tag: '⛺ 休息站', cls: 't-rest', sub: `${r.revived.length ? `救回 ${r.revived.length} 名重傷隊員・` : ''}感染 −${Math.round(r.inf[0] - r.inf[1])}` };
  }
  const bossName = DG_BOSSES[f]?.name || (f === DG_FLOORS ? DUNGEONS[rec.dg].final.name : null);
  if (bossName) return { ...out, tag: '👹 首領戰', cls: 't-boss', sub: bossName };
  return { ...out, tag: '攻略中', cls: 't-run', sub: '' };
}

/** 資訊框是否展開（v13.2：預設展開；記在設定裡） */
export const hudOpen = (g) => g.state.settings?.dgHudOpen !== false;
const foldBtn = (open) => `<span class="dg-fold" data-action="dgFold" role="button" title="${open ? '收起' : '展開'}">${open ? '▾' : '▸'}</span>`;
/** 報名人數：0 人灰色、不到 3 人橘紅色、3 人以上綠色 */
const cntHtml = (n) => `<span class="dg-cnt ${n === 0 ? 'zero' : n < DG_TEAM.min ? 'low' : 'ok'}">👥 ${n} 人</span>`;

/**
 * 地圖左上角的資訊框（v13.2：一直顯示、預設展開，列出全部地下城；沒報名的顯示報名人數，0 人也顯示）。
 * 右上角 ▸／▾ 收合。
 */
export function hudHtml(g, now = Date.now()) {
  const recs = hudRecords(g, now);
  const byDg = Object.fromEntries(recs.map((r) => [r.dg, r]));
  const open = hudOpen(g);
  const day = DungeonSystem.dayKey(now);
  const ph = DungeonSystem.phase(now);
  let total = 0;
  const rows = DUNGEON_KEYS.map((dg) => {
    const rec = byDg[dg];
    const n = (g.dungeon.data(dg, day)?.list || []).length;
    total += n;
    if (rec) {
      const st = statusOf(g, rec, now);
      return { dg, rec, st, icon: clsIcon(g.survivors.get(rec.svId)?.classId), tag: st.tag, cls: st.cls, right: st.floor };
    }
    const icon = clsIcon(DUNGEONS[dg].cls);
    if (ph === 'run') return { dg, icon, tag: n >= DG_TEAM.min ? '攻略中' : '今日休息', cls: n >= DG_TEAM.min ? 't-run' : 't-cancel', right: cntHtml(n) };
    if (ph === 'after') return { dg, icon, tag: n >= DG_TEAM.min ? '今日已結束' : '今日休息', cls: 't-cancel', right: cntHtml(n) };
    return { dg, icon, tag: ph === 'signup' || ph === 'before' ? '未報名' : '未參加', cls: 't-none', right: cntHtml(n) };
  });
  const sts = rows.filter((r) => r.st).map((r) => r.st);
  const any = sts.find((x) => x.time);
  const right = any ? `⏱ ${any.time}` : ph === 'signup' ? '17:40 截止' : ph === 'closed' ? '17:50 鎖定' : ph === 'locked' || ph === 'gather' ? '18:00 開打' : ph === 'run' ? '攻略中' : '00:00 開放報名';
  const glow = sts.some((x) => x.cls === 't-boss') ? 'boss-glow' : sts.some((x) => x.cls === 't-win') ? 'win-glow' : '';
  // 點標題列收合／展開（不會直接打開某一個副本）
  const head = `<div class="t" data-action="dgFold"><span class="dg-ic">${DG_PIN_SVG}</span>地下感染區<span class="fl">${right}</span>${foldBtn(open)}</div>`;
  if (!open) {
    return `<div class="dg-hud multi ${glow}" data-action="dgFold">${head}<div class="r sum">已報名 ${recs.length}・共 ${total} 人報名・點一下展開</div></div>`;
  }
  const html = rows.map((r) => `<div class="row ${r.rec ? 'mine' : ''}" data-action="${r.rec ? 'dgStatus' : 'dgOpen'}" data-dg="${r.dg}">${r.icon} ${escapeHtml(DUNGEONS[r.dg].short)}<span class="tag ${r.cls}">${r.tag}</span><span class="push">${r.right}</span></div>`).join('');
  return `<div class="dg-hud multi ${glow}">${head}${html}</div>`;
}

/** 時程表 */
function timeline(now) {
  const t = DungeonSystem.times(DungeonSystem.dayStart(now));
  const row = (at, label, text) => `<b class="${now >= at ? 'past' : ''}">${label}</b><span>${text}${now >= at ? ' ✓' : ''}</span>`;
  return `<div class="dg-tl">${row(t.open, '00:00', '開放報名')}${row(t.close, '17:40', `報名截止${now < t.close && now >= t.open ? `（剩 ${formatDuration(t.close - now)}）` : ''}`)}${row(t.lock, '17:50', '鎖定倖存者：外出中自動回家、重傷自動用藥治療')}${row(t.depart, '17:55', '出發集結')}${row(t.start, '18:00', `開始攻略，${DG_FLOORS} 層、約 3 小時`)}</div>`;
}

const ROLE = ['warrior', 'medic', 'engineer', 'scout', 'farmer'];

/** 職業燈號：有人報名就亮燈（圖示＋人數） */
function lamps(list, mini = false) {
  return ROLE.map((c) => {
    const n = list.filter((e) => e.c === c).length;
    return mini ? `<span class="${n ? 'on' : ''}" title="${CLASSES[c].name} ${n}">${CLASSES[c].icon}</span>`
      : `<span class="dg-lamp ${n ? 'on' : ''}" title="${CLASSES[c].name}"><i>${CLASSES[c].icon}</i><b>${n}</b></span>`;
  }).join('');
}

/** 報名名單：職業燈號＋名單（超過 8 人分成兩團以上才依團分開） */
function rosterHtml(g, data, gp) {
  const list = (data?.list || []).filter((e) => e && e.c && CLASSES[e.c]);
  if (!list.length) return '';
  const me = g.dungeon.myId();
  const miss = ROLE.filter((c) => !list.some((e) => e.c === c));
  const who = (e) => `<div class="${e.p === me ? 'me' : ''}">${clsIcon(e.c)} <b>${escapeHtml(e.sn || '')}</b> <small class="muted">Lv${e.lv || '?'}${DungeonSystem.powerOf(e) ? `・戰力 ${fmt(DungeonSystem.powerOf(e))}` : ''}・${escapeHtml(e.n || '')}${e.p === me ? '（我）' : ''}</small>${e.x || (e.sev && !e.med) ? '<small class="neg">無法出擊</small>' : ''}</div>`;
  const groups = gp && !gp.cancelled && gp.groups.length > 1
    ? gp.groups.map((x, i) => `<div class="dg-grp"><h5>第 ${i + 1} 團・${x.length} 人<span class="dg-mini">${lamps(x, true)}</span></h5><div class="dg-who">${x.map(who).join('')}</div></div>`).join('')
      + (gp.out.length ? `<div class="dg-grp"><h5>無法出擊</h5><div class="dg-who">${gp.out.map(who).join('')}</div></div>` : '')
    : `<div class="dg-who">${[...list].sort((a, b) => (a.at || 0) - (b.at || 0)).map(who).join('')}</div>`;
  return `<div class="dg-roster"><div class="dg-lamps">${lamps(list)}</div>
    <small class="muted">${miss.length ? `目前缺：${miss.map((c) => `${CLASSES[c].icon} ${CLASSES[c].name}`).join('、')}` : `五職業到齊 ✓（全隊攻擊／防禦 +${DG_RULES.all5 * 100}%）`}</small>
    ${groups}${gp && !gp.cancelled && gp.groups.length > 1 ? '<small class="muted block">分團依目前報名順序預估，17:40 截止時才確定；鎖定時無法出擊的人會被移出。</small>' : ''}</div>`;
}

/** 副本資訊視窗的參與狀況（精簡）：職業燈號＋小標籤（職業・倖存者・等級・玩家），超過 8 人時依團分排 */
function rosterMiniHtml(g, data, gp) {
  const list = (data?.list || []).filter((e) => e && e.c && CLASSES[e.c]);
  if (!list.length) return '';
  const me = g.dungeon.myId();
  const chip = (e) => `<span class="dg-chip ${e.p === me ? 'me' : ''}">${clsIcon(e.c)} <b>${escapeHtml(e.sn || '')}</b> <small class="muted">Lv${e.lv || '?'}・${escapeHtml(e.n || '')}${e.p === me ? '（我）' : ''}</small></span>`;
  const rows = gp && !gp.cancelled && gp.groups.length > 1
    ? gp.groups.map((x, i) => `<div class="dg-chips"><small class="dg-gl">第 ${i + 1} 團</small>${x.map(chip).join('')}</div>`).join('')
    : `<div class="dg-chips">${[...list].sort((a, b) => (a.at || 0) - (b.at || 0)).map(chip).join('')}</div>`;
  return `<div class="dg-roster mini"><div class="dg-lamps">${lamps(list)}</div>${rows}</div>`;
}

/** 報名頁 */
function signupTab(g, dg, now) {
  const day = DungeonSystem.dayKey(now);
  const data = g.dungeon.data(dg, day);
  const n = (data?.list || []).length;
  const rec = g.dungeon.record(dg, now);
  const ph = DungeonSystem.phase(now);
  const gp = n ? DungeonSystem.groupsOf(data) : null;
  const groups = gp && !gp.cancelled && gp.groups.length > 1 ? `（${gp.groups.map((x, i) => `第 ${i + 1} 團 ${x.length}/${DG_TEAM.max}`).join('、')}）` : '';
  const svs = g.state.survivors.map((sv) => {
    const other = g.dungeon.signedDungeon(sv.id, now);
    const mine = rec && !rec.cancelled && rec.svId === sv.id;
    let right;
    let cls = '';
    if (sv.isLeader) { right = '<span class="muted">指揮官不能參加</span>'; cls = 'off'; } else if (mine) {
      right = `<span class="pos">✓ 已報名</span>${ph === 'signup' ? btn('取消報名', 'dgCancel', { dg }, { cls: 'btn-xs btn-ghost' }) : ''}`;
      cls = 'on';
    } else if (other) right = `<span class="muted">已報名「${escapeHtml(DUNGEONS[other].name)}」</span>`;
    else if (rec && !rec.cancelled) right = '<span class="muted">今天已派其他倖存者</span>';
    else if (ph !== 'signup') right = '<span class="muted">不在報名時間</span>';
    else right = `${sv.severe ? '<small class="neg">🩸 重傷：17:50 會自動用藥治療</small>' : ''}${btn('報名', 'dgSign', { dg, sv: sv.id }, { cls: 'btn-xs btn-primary' })}`;
    const pw = g.survivors.stats(sv).power;
    return `<div class="dg-sv ${cls}">${clsIcon(sv.classId)} <b>${escapeHtml(sv.name)}</b> <small class="muted">Lv${sv.level}・戰力 ${fmt(pw)}</small><span class="push">${right}</span></div>`;
  }).join('');
  return `${timeline(now)}
    <div class="kv"><span>👥 已報名 <b>${n}</b> 人${groups}</span>${rec && !rec.cancelled ? '<span class="pos">今日已報名 ✓</span>' : ''}</div>
    ${rosterHtml(g, data, gp)}
    ${g.shared.online ? '' : '<p class="neg">目前沒有連線到伺服器，只能看到自己的報名（不到 3 人無法開打）。</p>'}
    <small class="muted">選擇一名倖存者（每個副本每天一次；同一名倖存者一天只能參加一個副本）：</small>${svs}
    <p class="muted small">建議：隊伍裡沒有醫生時幾乎無法通關；五種職業都有時全隊攻擊／防禦 +10%。</p>`;
}

/** 職業說明頁 */
export function classTab() {
  const rows = ['warrior', 'medic', 'engineer', 'scout', 'farmer'].map((c) => {
    const ob = Object.values(DG_OBSTACLES).find((o) => o.cls === c);
    return `<div class="dg-cls"><b>${CLASSES[c].icon} ${CLASSES[c].name}</b><div>${DG_CLASS_NOTES[c]}</div><small class="muted">處理障礙：${ob.icon} ${ob.name}・沒有時：<span class="neg">${ob.fail}</span></small></div>`;
  }).join('');
  return `${rows}<p class="muted small">五職業齊全：全隊攻擊／防禦 +${DG_RULES.all5 * 100}%、獎勵 +${DG_RULES.all5 * 100}%。
    副本規則：吸血效果只剩 ${DG_RULES.lifeStealMul * 100}%；首領戰最長 ${DG_RULES.bossMaxSec / 60} 分鐘；感染每 10 點全隊攻擊／防禦 −${DG_RULES.infStatPer10 * 100}%，滿 100 全隊撤退。
    每 ${DG_RULES.restEvery} 層一個休息站；第 5、10、15 層有精英首領，第 20 層是最終首領。
    戰鬥中重傷的人會跟著隊伍前進（重傷期間不計經驗與獎勵），首領戰只要有參與就有首領獎勵；副本中重傷不會扣經驗。</p>`;
}

/** 獎勵頁 */
function rewardTab(g, dg) {
  const d = DUNGEONS[dg];
  const core = DG_CORES[d.core];
  const bpm = 1 + g.research.bonus('blueprintPct');
  const rows = Object.entries(DG_DROPS).map(([f, x]) => {
    const name = DG_BOSSES[f]?.name || d.final.name;
    return `<tr><td>第 ${f} 層・${escapeHtml(name)}</td><td>${Math.round(x.core * 100)}%（${x.coreN[0] === x.coreN[1] ? x.coreN[0] : `${x.coreN[0]}～${x.coreN[1]}`} 個）</td><td>${(x.bp * bpm * 100).toFixed(1)}%</td></tr>`;
  }).join('');
  const gear = DG_SLOTS.map((s) => `<span class="dg-name">${escapeHtml(DG_GEAR[`${dg}_${s}`].name)}</span>`).join('、');
  return `<p>每層通關：經驗、金錢、一般材料（偵察兵多一個隱藏房間；有農夫時全隊物資 +${DG_RULES.farmerLoot * 100}%）。</p>
    <table class="dg-tbl"><tr><th>首領</th><th>${core.icon} ${core.name}</th><th>📜 副本圖紙</th></tr>${rows}</table>
    <small class="muted">圖紙機率已套用你的研究「圖紙蒐集」。每位參加者各自擲。</small>
    <p>副本裝備（${CLASSES[d.cls].icon} ${CLASSES[d.cls].name}專用、製作後綁定）：${gear}</p>
    <small class="muted">需要 ${DG_CRAFT.bench} 級工作台、圖紙、${core.name}、金錢與大量材料；圖紙與核心材料可以在交易市場交易。</small>`;
}

/** 今日紀錄頁：逐層紀錄（已公布的部分） */
function todayTab(g, dg, now) {
  const rec = g.dungeon.record(dg, now);
  if (!rec) return '<p class="muted">今天沒有參加這個副本。</p>';
  const mine = now >= DungeonSystem.times(rec.day0).start ? g.dungeon.myRun(rec) : null;
  if (!mine?.run) return `<p class="muted">${statusOf(g, rec, now).sub || '還沒開打。'}</p>`;
  return floorsHtml(g, dg, mine.run, DungeonSystem.revealed(mine.run, now), null);
}

/** 點副本圖示：報名畫面 */
export function openDungeon(ui, dg, tab0 = 'sign') {
  const g = ui.game;
  let tab = tab0;
  let busy = false;
  const body = () => {
    const now = Date.now();
    const d = DUNGEONS[dg];
    const tabs = [['sign', '報名'], ['cls', '職業說明'], ['reward', '獎勵'], ['today', '今日紀錄']]
      .map(([k, l]) => `<button class="chip ${tab === k ? 'active' : ''}" data-action="dgTab" data-t="${k}">${l}</button>`).join('');
    const content = tab === 'cls' ? classTab() : tab === 'reward' ? rewardTab(g, dg) : tab === 'today' ? todayTab(g, dg, now) : signupTab(g, dg, now);
    return `<div class="dg-head">${dgIcon()}<b>地下感染區</b></div><p class="muted">產出 ${CLASSES[d.cls].icon} ${CLASSES[d.cls].name}副本裝備・${DG_FLOORS} 層・每天 18:00 開打</p><div class="chips">${tabs}</div>${content}`;
  };
  g.shared.list('dg', 5).then(() => ui.refresh(true)).catch(() => {});
  ui.modal.open({
    title: DUNGEONS[dg].name,
    wide: true,
    body: body(),
    live: body,
    onAction: (action, data, m) => {
      if (action === 'dgTab') tab = data.t;
      if (action === 'dgSign' && !busy) {
        busy = true;
        g.dungeon.signup(dg, data.sv).then((r) => { busy = false; ui.result(r); m.update(body()); ui.refresh(true); });
      }
      if (action === 'dgCancel' && !busy && confirm('取消今天的報名？')) {
        busy = true;
        g.dungeon.cancel(dg).then((r) => { busy = false; ui.result(r); m.update(body()); ui.refresh(true); });
      }
      m.update(body());
    },
  });
}

/** 隊伍表（截至已公布的層數） */
function teamTable(g, run, upto, me) {
  const fl = run.floors[Math.max(0, upto - 1)];
  const rows = run.members.map((m, i) => {
    const hp = upto ? fl?.hp?.[i] ?? 100 : 100;
    const st = upto ? fl?.st?.[i] || [0, 0, 0, 0] : [0, 0, 0, 0];
    const state = hp === 0 ? '<span class="tag t-down">重傷・隨隊</span>' : '戰鬥中';
    return `<tr class="${i === me ? 'me' : ''}"><td>${escapeHtml(m.n)}${i === me ? '（我）' : ''}</td><td>${clsIcon(m.c)} ${escapeHtml(m.sn)} <small class="muted">Lv${m.lv}</small></td>
      <td><span class="hpb"><i style="width:${hp}%;${hp < 50 ? 'background:#ffb74d' : ''}"></i></span> ${hp}%</td><td>${state}</td>
      <td class="hide-m">${fmt(st[0])}</td><td class="hide-m">${fmt(st[1])}</td><td class="hide-m">${st[2] ? fmt(st[2]) : '—'}</td><td class="hide-m">${st[3]}</td></tr>`;
  }).join('');
  return `<table class="dg-tbl"><tr><th>玩家</th><th>倖存者</th><th>生命</th><th>狀態</th><th class="hide-m">輸出</th><th class="hide-m">承傷</th><th class="hide-m">治療</th><th class="hide-m">障礙</th></tr>${rows}</table>`;
}

/** 某一層的紀錄 */
function floorHtml(g, dg, run, fl) {
  const name = (id) => escapeHtml(run.members[run.ids.indexOf(id)]?.sn || '?');
  const lines = [];
  fl.obs.forEach((o) => {
    const ob = DG_OBSTACLES[o.id];
    lines.push(o.ok ? `${ob.icon} ${ob.name} → ${clsIcon(ob.cls)} ${name(o.by)} ${ob.ok}` : `${ob.icon} ${ob.name} → <span class="neg">沒有可行動的${CLASSES[ob.cls].name}：${ob.fail}</span>`);
  });
  fl.events.forEach((e) => lines.push(escapeHtml(e)));
  fl.waves.forEach((w, k) => {
    const head = w.boss ? `👹 首領「${escapeHtml(w.name)}」` : `🧟 第 ${k + 1} 波：遭遇 ${w.enemies} 隻`;
    const res = w.victory ? `勝利，<span class="x">每人經驗 +${fmt(w.xpEach)}</span>（${w.sec} 秒）${w.boss ? '・參與首領戰的人都有首領獎勵' : ''}` : `<span class="neg">${w.sec >= DG_RULES.fightMaxSec - 1 ? '時間到，沒能擊敗敵人' : '全隊倒下'}</span>`;
    lines.push(`${head} → ${res}${w.downs.length ? `・<span class="neg">🩸 ${w.downs.map(name).join('、')} 重傷（隨隊前進）</span>` : ''}`);
  });
  if (fl.rest) {
    lines.push(`⛺ 休息站：${fl.rest.revived.length ? `<span class="pos">醫生救回 ${fl.rest.revived.map(name).join('、')}（恢復 ${DG_RULES.reviveHp * 100}% 生命）</span>・` : ''}全隊回復 ${Math.round(fl.rest.heal * 100)}% 生命${fl.farmer ? '（農夫在隊）' : ''}・感染 ${Math.round(fl.rest.inf[0])} → ${Math.round(fl.rest.inf[1])}${fl.rest.left.length ? `・<span class="neg">${fl.rest.left.map(name).join('、')} 仍重傷</span>` : ''}`);
  }
  const boss = fl.waves.some((w) => w.boss);
  const cls = boss ? 'boss' : fl.rest ? 'rest' : '';
  return `<details class="dg-fl ${cls}"><summary>${boss ? '👹' : fl.rest ? '⛺' : '✅'} 第 ${fl.f} 層<small class="muted">障礙 ${fl.obs.length}・戰鬥 ${fl.waves.length}・☣️ ${Math.round(fl.inf)}</small></summary><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></details>`;
}

/** 逐層紀錄 */
export function floorsHtml(g, dg, run, upto, me) {
  const list = run.floors.slice(0, upto);
  if (!list.length) return '<p class="muted">第 1 層進行中…</p>';
  return list.map((fl) => floorHtml(g, dg, run, fl)).reverse().join('');
}

/** 點資訊框：詳細資訊 */
export function openStatus(ui, dg0) {
  const g = ui.game;
  let dg = dg0;
  const body = () => {
    const now = Date.now();
    const recs = hudRecords(g, now);
    const rec = recs.find((r) => r.dg === dg) || recs[0];
    if (!rec) return '<p class="muted">今天沒有參加副本。</p>';
    dg = rec.dg;
    const s = statusOf(g, rec, now);
    const tabs = recs.length > 1 ? `<div class="chips">${recs.map((r) => `<button class="chip ${r.dg === dg ? 'active' : ''}" data-action="dgPick" data-dg="${r.dg}">${clsIcon(g.survivors.get(r.svId)?.classId)} ${DUNGEONS[r.dg].short}</button>`).join('')}</div>` : '';
    const head = `<h4>${dgIcon()}${escapeHtml(DUNGEONS[dg].name)} <span class="tag ${s.cls}">${s.tag}</span></h4>`;
    if (!s.run) {
      const data = g.dungeon.data(dg, DungeonSystem.dayKey(now));
      const gp = data?.list?.length ? DungeonSystem.groupsOf(data) : null;
      return `${tabs}${head}<p>${s.sub}</p>${rosterMiniHtml(g, data, gp)}${timeline(now)}${btn('打開副本畫面', 'dgOpen', { dg }, { cls: 'btn-sm' })}`;
    }
    const run = s.run;
    const upto = DungeonSystem.revealed(run, now);
    const f = DungeonSystem.floorAt(run, now);
    const done = now >= run.endAt;
    const nextRest = Math.ceil((f) / DG_RULES.restEvery) * DG_RULES.restEvery;
    const nextBoss = [5, 10, 15, 20].find((x) => x >= f);
    const inf = s.inf || 0;
    const kv = `<div class="kv"><span>📍 第 <b>${done ? run.endFloor : f}</b>/${DG_FLOORS} 層</span><span>⏱ ${s.time}</span>${done ? '' : `<span>⏭ 下一層 ${formatDuration(run.start + upto * DG_TIME.floorMs + DG_TIME.floorMs - now)} 後</span>`}
      <span>☣️ 感染 <b>${Math.round(inf)}</b>（攻擊／防禦 −${Math.round(DG_RULES.infStatPer10 * 100 * Math.floor(inf / 10))}%）</span>${done ? '' : `<span>⛺ 下一個休息站：第 ${nextRest} 層</span><span>👹 下一個首領：第 ${nextBoss} 層</span>`}</div>`;
    const comp = new Set(run.members.map((m) => m.c));
    const all5 = ['warrior', 'medic', 'engineer', 'scout', 'farmer'].every((c) => comp.has(c));
    const notes = `<small class="muted">${all5 ? `五職業齊全 ✓（全隊攻擊／防禦 +${DG_RULES.all5 * 100}%）` : `缺少：${['warrior', 'medic', 'engineer', 'scout', 'farmer'].filter((c) => !comp.has(c)).map((c) => `${CLASSES[c].icon}${CLASSES[c].name}`).join('、')}`}${comp.has('farmer') ? '・農夫在隊：帶回物資增加 ✓' : ''}</small>`;
    return `${tabs}${head}${kv}${teamTable(g, run, upto, s.i)}${notes}<h4>逐層紀錄</h4>${floorsHtml(g, dg, run, upto, s.i)}`;
  };
  ui.modal.open({
    title: '地下感染區・副本資訊',
    wide: true,
    body: body(),
    live: body,
    onAction: (action, data, m) => {
      if (action === 'dgPick') dg = data.dg;
      if (action === 'dgOpen') { m.close(); openDungeon(ui, data.dg); return; }
      m.update(body());
    },
  });
}

/** 副本報告（探索報告列表中的一張卡片） */
export function dungeonReportHtml(g, r, open, fresh, NEW, hhmm) {
  const d = DUNGEONS[r.dg] || { name: '副本', short: '' };
  const glow = (r.bps || []).length ? 'dg-glow' : '';
  const icon = r.status === 'clear' ? '🏆' : r.status === 'fail' ? '💀' : '⚪';
  const badge = r.status === 'clear' ? `<span class="tag t-win">通關 ${DG_FLOORS}/${DG_FLOORS}</span>` : r.status === 'fail' ? '<span class="tag t-fail">失敗</span>' : `<span class="tag t-cancel">${r.status === 'cancel' ? '今日取消' : '未出擊'}</span>`;
  if (r.status === 'cancel' || r.status === 'out') {
    return `<div class="card report dg-rep ${fresh ? 'unread' : ''}"><div class="row-between"><b>${fresh ? NEW : ''}${icon} ${dgIcon()}${escapeHtml(d.name)}</b><small class="muted">${hhmm(r.at)}</small></div>
      <div class="gains">${badge}</div><small class="muted">${escapeHtml(r.why || '')}。倖存者已回到避難所，沒有扣除任何東西；00:00 換日後可以重新報名。</small></div>`;
  }
  const run = open ? g.dungeon.reportRun(r) : null;
  const core = Object.entries(r.cores || {}).map(([k, n]) => `<span class="c core">${DG_CORES[k]?.icon} ${DG_CORES[k]?.name} ×${n}</span>`).join('');
  const bps = (r.bps || []).map((m) => `<span class="c bp">📜 副本圖紙「${escapeHtml(DG_GEAR[m]?.name || m)}」</span>`).join('');
  const mats = Object.entries(r.mats || {}).sort((a, b) => (SUPPLIES[b[0]]?.tier || 0) - (SUPPLIES[a[0]]?.tier || 0)).slice(0, open ? 99 : 6)
    .map(([k, n]) => `<span class="c">${metaOf(k).icon} ${metaOf(k).name} +${n}</span>`).join('');
  const more = !open && Object.keys(r.mats || {}).length > 6 ? `<span class="c muted">…共 ${Object.keys(r.mats).length} 種</span>` : '';
  const chips = `${bps}${core}<span class="xp-chip">⭐ 經驗 +${fmt(r.xpGot)}</span><span class="c">💰 +${fmt(r.coins)}</span>${mats}${more}`;
  let detail = '';
  if (open && run) {
    const name = (id) => {
      const k = run.ids.indexOf(id);
      return k >= 0 ? `${escapeHtml(run.members[k].n)}・${escapeHtml(run.members[k].sn)}` : '—';
    };
    const mvpBox = (label, k, unit) => `<div>${label}<b>${run.mvp[k] ? name(run.mvp[k]) : '—'}</b>${run.mvp[k] ? `${fmt(run.stat[run.ids.indexOf(run.mvp[k])][k])}${unit}` : ''}</div>`;
    const mvp = `<div class="dg-mvp">${mvpBox('⚔️ 輸出 MVP', 'dealt', '')}${mvpBox('🛡️ 承傷 MVP', 'taken', '')}${mvpBox('💚 治療 MVP', 'healed', '')}${mvpBox('🧰 障礙 MVP', 'obs', ' 次')}</div>`;
    const rows = run.members.map((m, i) => {
      const st = run.stat[i];
      const rw = run.rewards[i];
      return `<tr class="${i === r.me ? 'me' : ''}"><td>${escapeHtml(m.n)}・${clsIcon(m.c)} ${escapeHtml(m.sn)}</td><td>${fmt(st.dealt)}</td><td>${fmt(st.taken)}</td><td>${st.healed ? fmt(st.healed) : '—'}</td><td>${st.obs}</td><td class="hide-m">${st.downs ? `${st.downs} 次` : '0'}</td><td>+${fmt(st.xp)}</td><td class="hide-m">${rw.bps.length ? '📜' : ''}${Object.values(rw.cores).reduce((a, b) => a + b, 0) ? `🧬${Object.values(rw.cores).reduce((a, b) => a + b, 0)}` : ''}</td></tr>`;
    }).join('');
    const tbl = `<table class="dg-tbl"><tr><th>玩家・倖存者</th><th>輸出</th><th>承傷</th><th>治療</th><th>障礙</th><th class="hide-m">重傷</th><th>經驗</th><th class="hide-m">掉落</th></tr>${rows}</table>`;
    const fin = run.final[r.me];
    detail = `${mvp}${tbl}<h4>逐層紀錄</h4>${floorsHtml(g, r.dg, run, run.endFloor, r.me)}
      <small class="muted block">🏁 最終結算：副本中重傷不扣經驗；${fin?.sev ? '結束時仍是重傷，回家後依一般重傷規則休養。' : '倖存者已回到避難所。'}${r.status === 'fail' ? `第 ${run.endFloor} 層${run.reason === 'infection' ? '感染值滿 100 全隊撤退' : run.reason === 'timeout' ? '時間內沒能擊敗敵人' : '全隊倒下'}；已通過層數的獎勵全部保留。` : ''}</small>`;
  } else if (open) detail = '<p class="muted">副本資料已清除，無法顯示逐層紀錄。</p>';
  return `<div class="card report dg-rep ${glow} ${r.status === 'fail' ? 'fail' : ''} ${fresh ? 'unread' : ''}">
    <div class="row-between" data-action="toggleReport" data-id="${r.id}"><b>${fresh ? NEW : ''}${icon} ${dgIcon()}${escapeHtml(d.name)} ${badge}${(r.bps || []).length ? '<span class="dg-tag">✨ 副本圖紙</span>' : ''}</b><small class="muted">${hhmm(r.at)} ${open ? '▲' : '▼'}</small></div>
    <div class="gains dg-chips">${chips}</div>${detail}</div>`;
}

/** 工作台「副本裝備」頁：製作副本裝備 */
export function dgCraftHtml(g) {
  const cores = g.dungeon.cores();
  const bench = g.shelter.maxLevel('workbench');
  const bps = g.state.inventory.blueprints.filter((b) => b.dg && DG_GEAR[b.model]);
  const head = `<div class="kv">${Object.entries(DG_CORES).map(([k, c]) => `<span>${c.icon} ${c.name} <b>${cores[k] || 0}</b></span>`).join('')}<span>🛠️ 工作台 Lv${bench}${bench < DG_CRAFT.bench ? `（需要 ${DG_CRAFT.bench} 級）` : ' ✓'}</span></div>`;
  if (!bps.length) return `${head}<p class="muted">還沒有副本圖紙。參加地下感染區，打倒第 5、10、15、20 層的首領有機會取得（也可以在交易市場買）。</p>`;
  const seen = new Set();
  const cards = bps.filter((b) => (seen.has(b.model) ? false : seen.add(b.model))).map((b) => {
    const def = DG_GEAR[b.model];
    const d = DUNGEONS[def.dg];
    const coreKey = d.core;
    const needCore = DG_CRAFT.core[def.slot];
    const cost = DG_RECIPES[b.model];
    const have = (k) => Math.floor(g.state.supplies?.[k] || 0);
    const n = bps.filter((x) => x.model === b.model).length;
    const check = g.dungeon.canCraft(b.model);
    const lack = [];
    if ((cores[coreKey] || 0) < needCore) lack.push(`${DG_CORES[coreKey].name} ${needCore - (cores[coreKey] || 0)}`);
    if (g.state.player.coins < DG_CRAFT.coins[def.slot]) lack.push(`金錢 ${fmt(DG_CRAFT.coins[def.slot] - g.state.player.coins)}`);
    Object.entries(cost).forEach(([k, v]) => { if (have(k) < v) lack.push(`${SUPPLIES[k].name} ${fmt(v - have(k))}`); });
    const mats = Object.entries(cost).sort((a, b2) => SUPPLIES[a[0]].tier - SUPPLIES[b2[0]].tier).map(([k, v]) => `<span class="${have(k) < v ? 'lack' : ''}">${SUPPLIES[k].tier} 品・${SUPPLIES[k].icon} ${SUPPLIES[k].name} ${fmt(have(k))}/${fmt(v)}</span>`).join('');
    const set = DungeonSystem.setText(def.cls).map((t) => `<span class="i">${t}</span>`).join('<br>');
    return `<div class="dg-item dg-glow">
      <div class="row-between"><b class="dg-name">${escapeHtml(def.name)}</b><span class="dg-tag">副本</span><small class="muted push">${CLASSES[def.cls].icon} ${CLASSES[def.cls].name}專用・製作後綁定</small></div>
      <small class="muted">📜 圖紙 ×1（擁有 ${n}）</small>
      <div class="tier">核心材料與金錢</div>
      <div class="need"><span class="${(cores[coreKey] || 0) < needCore ? 'lack' : ''}">${DG_CORES[coreKey].icon} ${DG_CORES[coreKey].name} <b>${cores[coreKey] || 0}</b>/${needCore}</span><span class="${g.state.player.coins < DG_CRAFT.coins[def.slot] ? 'lack' : ''}">💰 金錢 <b>${fmt(g.state.player.coins)}</b>/${fmt(DG_CRAFT.coins[def.slot])}</span></div>
      <div class="tier">一般材料（擁有／需要）</div><div class="need">${mats}</div>
      <div class="set"><b>套裝「${escapeHtml(d.short)}」</b><br>${set}</div>
      <div class="btn-row end">${lack.length ? `<small class="neg">缺：${lack.slice(0, 4).join('、')}${lack.length > 4 ? '…' : ''}</small>` : ''}${btn('製作', 'dgCraft', { id: b.model }, { cls: `btn-sm ${check.ok ? 'btn-primary' : ''}`, disabled: !check.ok, title: check.reason || '' })}</div>
    </div>`;
  }).join('');
  return `${head}<div class="dg-items">${cards}</div>`;
}
