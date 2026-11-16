import {
  WORLD_BOSS, WORLD_BOSS_PHASES, WORLD_BOSS_REWARD, BLOCKADE,
} from '../config/eventModes.js';
import { zoneAt } from '../config/zones.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration, haversine } from '../utils/math.js';
import { btn } from './components.js';
import { openTeamPicker } from './TeamPicker.js';
import { fmtWan } from '../systems/WorldBossSystem.js';
import { lootBrief } from '../systems/BlockadeSystem.js';

const left = (ms) => formatDuration(Math.max(0, ms));
const zoneTag = (lat, lon) => { const z = zoneAt(lat, lon); return `<span class="zone-tag" style="--zc:${z.color}">${z.name}</span>`; };
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const wd = (t) => '日一二三四五六'[new Date(t).getDay()];

/** 地圖圖示資料：屍王、封鎖區 */
export function eventPins(game, now = Date.now()) {
  const out = [];
  const b = game.worldBoss?.active(now);
  if (b) {
    const st = game.worldBoss.status(b, now);
    out.push({
      kind: 'boss', id: b.id, lat: b.lat, lon: b.lon, icon: b.icon, pct: st.pct,
      label: `${b.name}・${Math.ceil(st.pct * 100)}%・剩 ${Math.max(1, Math.ceil((b.end - now) / 3600000))} 時`,
    });
  }
  const z = game.blockade?.current(now);
  if (z) {
    const mine = game.blockade.myTeam(z);
    const ms = z.close - now;
    out.push({
      kind: 'bz', id: z.id, lat: z.lat, lon: z.lon, r: BLOCKADE.radiusM,
      label: `封鎖區・剩 ${Math.floor(ms / 3600000)}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}・${game.blockade.zoneName(z)}`,
      team: mine && !mine.bz?.done ? (mine.bz.exitAt != null ? '🚁 撤離中' : now >= mine.startAt + (mine.travelMs || 0) ? `你的隊伍・第 ${mine.bz.round} 輪` : '你的隊伍・前往中') : '',
    });
  }
  return out;
}

// ---------- 屍王降臨 ----------

function bossBody(game, b) {
  const wb = game.worldBoss;
  const now = Date.now();
  const st = wb.status(b, now);
  const R = WORLD_BOSS_REWARD;
  const tag = st.state === 'upcoming' ? `<span class="tag tag-blue">⏳ 即將降臨</span> ${left(b.start - now)}後`
    : st.state === 'active' ? `<span class="tag tag-amber">🔥 降臨中</span> 剩 <b>${left(b.end - now)}</b>`
      : st.state === 'killed' ? '<span class="tag tag-green">🏆 已被擊倒</span>' : '<span class="tag">🏃 已經離開</span>';
  const ph = wb.phaseOf(st.pct);
  const phases = WORLD_BOSS_PHASES.map((p, i) => `<span class="${p === ph && st.state === 'active' ? 'on' : ''}"><b>${'①②③'[i]} ${Math.round(p.from * 100)}～${Math.round(p.to * 100)}%${p === ph && st.state === 'active' ? '（目前）' : ''}</b><br>${p.icon} ${p.name}：${p.text}</span>`).join('');
  const rank = wb.ranking(b);
  const me = wb.me();
  const mi = rank.findIndex((x) => x.p === me);
  const medal = ['🥇', '🥈', '🥉'];
  const rows = rank.slice(0, 10).map((x, i) => `<div class="ev-row${x.p === me ? ' me' : ''}"><span>${medal[i] || `${i + 1}.`} ${escapeHtml(x.n)}${x.p === me ? '（你）' : ''}</span><b>${fmtWan(x.d)}</b></div>`).join('')
    + (mi >= 10 ? `<div class="ev-row me"><span>${mi + 1}. ${escapeHtml(rank[mi].n)}（你）</span><b>${fmtWan(rank[mi].d)}</b></div>` : '');
  const team = wb.myTeam(b);
  const tries = wb.triesLeft(b);
  const myD = mi >= 0 ? rank[mi].d : 0;
  const box = mi < 0 ? '' : mi === 0 ? '金箱' : mi < R.silverTop ? '銀箱' : '銅箱';
  const card = (title, text) => `<div class="ev-card"><b>${title}</b>${text}</div>`;
  const boxes = Object.entries(R.box).map(([k, s]) => card(`${s.icon} ${s.name}・${k === 'gold' ? '第 1 名' : k === 'silver' ? `2～${R.silverTop} 名` : '其他參與者'}`,
    k === 'gold' ? '大量 4～5 階材料、稀有材料、設計圖（保底精良）' : k === 'silver' ? '3～5 階材料、稀有材料、設計圖機率' : '依傷害比例的材料與金錢')).join('');
  const canGo = st.state === 'active' && tries > 0 && !team && game.shelter.hasShelter();
  return `<p>${tag}・${zoneTag(b.lat, b.lon)}・距避難所 ${wb.distanceTo(b).toLocaleString()} 公尺</p>
    <div class="label">全服共同血量</div>
    <div class="bar wb"><div class="bar-fill" style="width:${Math.round(st.pct * 1000) / 10}%"></div><i class="ev-tick" style="left:70%"></i><i class="ev-tick" style="left:40%"></i><span>${fmtWan(st.left)} / ${fmtWan(st.hp)}（${Math.ceil(st.pct * 100)}%）・參與 ${st.players} 人</span></div>
    <div class="ev-ph">${phases}</div>
    <div class="ev-sec">我的挑戰</div>
    <div class="ev-grid">
      ${card(`剩餘次數 ${tries} / ${WORLD_BOSS.tries}`, `每次派 1 支隊伍、戰鬥 ${WORLD_BOSS.fightSec} 秒`)}
      ${card(`累積傷害 ${fmtWan(myD)}`, mi >= 0 ? `目前第 ${mi + 1} 名（${box}）` : '還沒有出擊')}
      ${card('建議隊伍總戰力', `${fmtWan(WORLD_BOSS.power)} 以上（太弱很快就會倒下）`)}
    </div>
    ${team ? `<p class="muted">🚶 你的隊伍正在前往挑戰（${left(team.startAt + (team.travelMs || 0) - now)}後抵達）</p>` : ''}
    <div class="ev-sec">傷害排行</div>
    ${rows || '<p class="muted">還沒有人出擊</p>'}
    <div class="ev-sec">結算獎勵（依傷害排名）</div>
    <div class="ev-grid">${boxes}</div>
    <p class="muted">每次出擊結束立即獲得依傷害計算的材料與金錢；屍王被擊倒後依排名發箱。${Math.round(WORLD_BOSS.stayMs / 3600000)} 小時內沒擊倒，屍王離開，結算獎勵減半。之後每一隻的血量會依上一隻被擊倒的速度自動調整。</p>
    ${st.state === 'active' ? `<div class="btn-row">${btn(`⚔️ 派隊挑戰（剩 ${tries} 次）`, 'bossGo', {}, { cls: 'btn-danger', disabled: !canGo })}</div>` : ''}`;
}

export function openBoss(panel, id) {
  const { game: g, ui } = panel;
  const b = g.worldBoss?.get(id) || g.worldBoss?.active();
  if (!b) return;
  ui.modal.open({
    title: `${b.icon} 屍王降臨・${b.name} Lv${WORLD_BOSS.boss.level}`,
    body: bossBody(g, b),
    live: () => bossBody(g, b),
    wide: true,
    onAction: (action, _d, m) => {
      if (action !== 'bossGo') return;
      m.close();
      const sh = g.shelter.primary();
      openTeamPicker(ui, {
        title: `${b.icon} 挑戰${b.name}`,
        intro: `<p class="muted">隊伍移動到${escapeHtml(b.name)}所在地，抵達後交戰 ${WORLD_BOSS.fightSec} 秒，造成的傷害計入全服排行；倒下的隊員重傷回避難所休養。建議隊伍總戰力 ${fmtWan(WORLD_BOSS.power)} 以上。</p>`,
        vehicles: true,
        distanceM: sh ? haversine(sh.lat, sh.lon, b.lat, b.lon) : 0,
        trip: { poi: { id: `boss:${b.id}`, lat: b.lat, lon: b.lon, type: 'military', boss: true }, searchMin: 0 },
        routeOption: true,
        confirmLabel: '出發挑戰！',
        onConfirm: (ids, _dur, _auto, vids, opts) => {
          const r = ui.result(g.worldBoss.start(ids, { vehicleIds: vids, ...opts }));
          if (r.ok) panel.renderMap(true);
          return r;
        },
      });
    },
  });
}

// ---------- 封鎖區撤離 ----------

function autoHtml(a) {
  const chip = (on, label, action, data = {}) => btn(`${on ? '✅' : '⬜'} ${label}`, action, data, { cls: `btn-xs ${on ? 'btn-primary' : 'btn-ghost'}` });
  return `<div class="ev-set">威脅值達 ${BLOCKADE.threatChoices.map((v) => chip(a.threat === v, `${v}%`, 'bzThreat', { v })).join('')}</div>
    <div class="ev-set">${chip(a.down, '有隊員倒下', 'bzDown')}${chip(a.full, '背包滿了', 'bzFull')}<small class="muted">（關閉前 ${Math.round(BLOCKADE.closeExitMs / 60000)} 分鐘一定會撤離）</small></div>`;
}

function bzInfoBody(game, z) {
  const bz = game.blockade;
  const now = Date.now();
  const Z = bz.zoneDef(z);
  const can = bz.canEnter(z, now);
  const card = (title, text) => `<div class="ev-card"><b>${title}</b>${text}</div>`;
  return `<p><span class="tag tag-amber">🚧 開放中</span> 剩 <b>${left(z.close - now)}</b> 關閉・${zoneTag(z.lat, z.lon)}・距避難所 ${bz.distanceTo(z).toLocaleString()} 公尺</p>
    <div class="label">玩法</div>
    <p>隊伍進入後每 <b>${Math.round(BLOCKADE.roundMs / 60000)} 分鐘</b>搜刮一輪，越搜越好，但<b>威脅值</b>也越來越高，可能被屍群包圍。隨時可下令<b>撤離</b>：撤離途中要擺脫一次追擊戰，打贏才把東西全部帶回。</p>
    <div class="ev-grid">
      ${card('✅ 撤離成功', '帶回全部搜刮物')}
      ${card('⚠️ 追擊戰失敗', '丟失一半搜刮物，隊員重傷')}
      ${card('💀 全隊被擊潰', '這趟搜刮物全部丟失（裝備保留）')}
    </div>
    <div class="label">可能內容（越後面的輪次越好）</div>
    <p>🔩 零件、🧵 布料（最高 ${Math.max(...Object.keys(Z.part).map(Number))} 階）、⚙️ 稀有材料、💰 金錢<br><small class="muted">第 ${BLOCKADE.bpFrom} 輪起有機率出現設計圖；收穫約為同區探索的 1.2 倍起，每多一輪再 +${Math.round(BLOCKADE.grow * 100)}%</small></p>
    <div class="label">建議隊伍總戰力</div>
    <p><b>${fmtWan(Z.power)} 以上</b><small class="muted">（威脅值越高，遭遇的屍群越強；夜晚威脅上升較快）</small></p>
    <div class="label">自動撤離（離線時也會執行）</div>
    ${autoHtml(bz.st.auto)}
    <p class="muted">每次封鎖區開放，每位玩家可派 1 支隊伍。下一次開放：${(() => { const n = bz.next(now); return n ? `週${wd(n.start)} ${hm(n.start)}` : '—'; })()}</p>
    <div class="btn-row">${btn('🚧 派隊進入', 'bzGo', {}, { cls: 'btn-primary', disabled: !can.ok || !game.shelter.hasShelter() })}</div>
    ${can.ok ? '' : `<p class="muted">${escapeHtml(can.reason)}</p>`}`;
}

function bzRunBody(game, exp) {
  const bz = game.blockade;
  const now = Date.now();
  const b = exp.bz;
  const z = bz.get(b.id);
  const arrive = exp.startAt + (exp.travelMs || 0);
  let tag;
  if (b.done) tag = `<span class="tag ${b.result === 'ok' ? 'tag-green' : 'tag-red'}">${b.result === 'ok' ? '✅ 撤離成功' : b.result === 'half' ? '⚠️ 丟失一半' : '💀 全隊被擊潰'}</span> 返回避難所中・${left(exp.endAt - now)}後到家`;
  else if (now < arrive) tag = `<span class="tag tag-blue">🚶 前往中</span> ${left(arrive - now)}後抵達`;
  else if (b.exitAt != null) tag = `<span class="tag tag-amber">🚁 撤離中</span> ${left(b.exitAt + BLOCKADE.exitMs - now)}後打追擊戰（${escapeHtml(b.exitWhy)}）`;
  else tag = `<span class="tag tag-blue">🔍 搜刮中</span> 第 <b>${b.round}</b> 輪・下一輪 ${left(arrive + (b.round + 1) * BLOCKADE.roundMs - now)}後・封鎖區剩 ${left(b.close - now)}`;
  const ld = bz.load(exp);
  const members = exp.memberIds.map((id) => game.survivors.get(id)).filter(Boolean);
  const rows = members.map((m) => `<div class="ev-row"><span>${game.survivors.classIcon(m)} ${escapeHtml(m.name)} Lv${m.level}</span><small>${m.severe ? '🩸 重傷' : `❤️ ${Math.round(game.survivors.hpOf(m)).toLocaleString()} / ${Math.round(game.survivors.maxHp(m)).toLocaleString()}`}</small></div>`).join('');
  const inside = !b.done && b.exitAt == null && now >= arrive;
  return `<p>${tag}</p>
    <div class="label">威脅值</div>
    <div class="bar threat"><div class="bar-fill" style="width:${b.threat}%"></div><i class="ev-tick" style="left:${b.auto.threat}%;background:#00e5ff"></i><span>${b.threat}%・下一輪遭遇機率 ${b.threat}%・自動撤離 ${b.auto.threat}%</span></div>
    <div class="label">隊伍（${members.length} 人）</div>${rows}
    <div class="label">已搜刮（背包 ${Math.round(ld.ratio * 100)}%）</div>
    <p>${lootBrief(b.gained) || '（還沒有收穫）'}${b.bps.length ? `、📜 設計圖 ×${b.bps.length}` : ''}</p>
    ${b.log.length ? `<div class="label">紀錄</div><div class="ev-log">${b.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}
    ${!b.done ? `<div class="label">自動撤離</div>${autoHtml(b.auto)}` : ''}
    ${inside ? `<p class="muted">現在撤離：${Math.round(BLOCKADE.exitMs / 60000)} 分鐘後打追擊戰，強度依威脅值 ${b.threat}%。</p><div class="btn-row">${btn('🚁 立即撤離', 'bzExit', {}, { cls: 'btn-danger' })}</div>` : ''}
    ${z ? '' : ''}`;
}

export function openBz(panel, id) {
  const { game: g, ui } = panel;
  const bz = g.blockade;
  const z = bz?.get(id) || bz?.current();
  if (!z) return;
  const mine = () => bz.myTeam(z);
  const body = () => (mine() ? bzRunBody(g, mine()) : bzInfoBody(g, z));
  ui.modal.open({
    title: mine() ? '🚧 封鎖區・你的隊伍' : `🚧 封鎖區・${z.place || ''}`,
    body: body(),
    live: body,
    wide: true,
    onAction: (action, data, m) => {
      const exp = mine();
      if (action === 'bzThreat') { bz.setAuto({ threat: Number(data.v) }, exp); m.update(body()); return; }
      if (action === 'bzDown') { bz.setAuto({ down: !(exp?.bz?.auto || bz.st.auto).down }, exp); m.update(body()); return; }
      if (action === 'bzFull') { bz.setAuto({ full: !(exp?.bz?.auto || bz.st.auto).full }, exp); m.update(body()); return; }
      if (action === 'bzExit' && exp) {
        ui.result(g.exploration.recall(exp.id));
        m.update(body());
        return;
      }
      if (action !== 'bzGo') return;
      m.close();
      const sh = g.shelter.primary();
      openTeamPicker(ui, {
        title: '🚧 進入封鎖區',
        intro: `<p class="muted">隊伍移動到封鎖區後每 ${Math.round(BLOCKADE.roundMs / 60000)} 分鐘搜刮一輪，達到自動撤離條件或你下令撤離時離開；撤離要打贏追擊戰才能全部帶回。建議隊伍總戰力 ${fmtWan(bz.zoneDef(z).power)} 以上。</p>`,
        vehicles: true,
        distanceM: sh ? haversine(sh.lat, sh.lon, z.lat, z.lon) : 0,
        trip: { poi: { id: `bz:${z.id}`, lat: z.lat, lon: z.lon, type: 'military', blockade: true }, searchMin: 0 },
        routeOption: true,
        confirmLabel: '進入封鎖區！',
        onConfirm: (ids, _dur, _auto, vids, opts) => {
          const r = ui.result(bz.start(ids, { vehicleIds: vids, ...opts }));
          if (r.ok) panel.renderMap(true);
          return r;
        },
      });
    },
  });
}

/** 自己的封鎖區隊伍（地圖點擊隊伍時改開封鎖區畫面） */
export function openBzTeam(panel, exp) {
  openBz(panel, exp.bz?.id);
}

export { WORLD_BOSS };
