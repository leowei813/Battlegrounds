import { haversine, uid, chance, randInt } from '../utils/math.js';
import { RESOURCE_KEYS } from '../config/constants.js';
import { SUPPLIES, isSupply } from '../config/supplies.js';
import { ITEM_MODELS, RARITIES, SLOT_KEYS } from '../config/equipment.js';
import { stockOf } from './LootStock.js';
import { tripProgress } from './ExplorationSystem.js';
import { NPC_CONFIG } from '../config/npcs.js';

/** 被擊敗時，每件裝備被搶走的機率 */
export const GEAR_LOOT_CHANCE = 0.05;
/** 一次最多搶到的裝備數（防止異常資料） */
const MAX_LOOT_ITEMS = 10;
const MAX_LOOT_AMOUNT = 5000;

/**
 * 攔截野外隊伍：可以攻擊正在外面探索（或前來掠奪）的其他玩家與 NPC 隊伍。
 *  - 派出的隊伍前往目標目前的位置，抵達時交戰。
 *  - 被擊敗的一方要花時間走回原本的據點，返程不會公開給其他玩家看到。
 *  - 被擊敗的隊伍身上（背包）的物資全部被搶走，每件裝備有 5% 機率被搶走。
 * 與其他玩家之間透過事件信箱傳遞戰果（intercept → plunder）。
 */
export class InterceptSystem {
  constructor(game) {
    this.game = game;
    this.cache = new Map();
  }

  // ---------- 目標 ----------

  /**
   * 地圖上點選的隊伍 → 攔截目標
   * @param {{kind:'npc'|'player', npcId?:string, playerId?:string, tripId?:string}} team
   */
  target(team, now = Date.now()) {
    const g = this.game;
    if (team.kind === 'npc') {
      const n = g.npcs.get(team.npcId);
      const trip = n?.trip;
      if (!n || !trip || trip.hidden || trip.endAt <= now) return null;
      const p = tripProgress(trip, now);
      return {
        kind: 'npc', id: `icpt:npc:${n.id}:${trip.startAt}`, npcId: n.id, tripStart: trip.startAt, endAt: trip.endAt,
        name: `${n.name}${trip.kind === 'raid' ? '（掠奪隊）' : '（探索隊）'}`, owner: n.name, level: n.level, members: this.npcTeamSize(n),
        lat: p.pos.lat, lon: p.pos.lon, phase: p.phase, searchEnd: trip.startAt + (trip.travelMs || 0) + (trip.searchMs || 0),
      };
    }
    const p = (g.world?.others || []).find((x) => x.id === team.playerId);
    const trip = p?.trips.find((t) => t.id === team.tripId);
    if (!p || !trip || trip.defeated || trip.endAt <= now) return null;
    const pr = tripProgress(trip, now);
    return {
      kind: 'player', id: `icpt:pl:${p.id}:${trip.id}`, playerId: p.id, tripId: trip.id, endAt: trip.endAt,
      name: `${p.name}的探索隊`, owner: p.name, level: trip.level || 1, members: trip.members || 1,
      lat: pr.pos.lat, lon: pr.pos.lon, phase: pr.phase,
      searchEnd: trip.startAt + (trip.travelMs || 0) + (trip.searchMs ?? trip.endAt - trip.startAt),
    };
  }

  npcTeamSize(n) {
    return Math.min(4, 2 + Math.floor(n.level / 8));
  }

  /** 讓探索系統把攔截目標當成目的地 */
  asPoi(id) {
    if (!String(id).startsWith('icpt:')) return null;
    const t = this.cache.get(id) || this.game.state.expeditions.find((e) => e.poiId === id)?.icptTarget;
    return t && {
      id, name: t.name, lat: t.lat, lon: t.lon, type: 'military', icon: '⚔️', intercept: true, target: t,
    };
  }

  canIntercept(team) {
    const g = this.game;
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    const t = this.target(team);
    if (!t) return { ok: false, reason: '隊伍已經離開了' };
    if (t.kind === 'player' && g.territory.relation(t.playerId) === 'friend') return { ok: false, reason: '不能攻擊友好玩家的隊伍' };
    if (g.state.expeditions.some((e) => e.poiId === t.id)) return { ok: false, reason: '已經派隊攔截這支隊伍了' };
    // 移動中的隊伍追不上：只能在對方停在建築搜索時攔截
    if (t.phase !== 'searching') return { ok: false, reason: '對方正在移動中，只能在對方停下搜索時攔截', target: t };
    return { ok: true, target: t };
  }

  /** 派隊攔截 */
  start(team, memberIds, opts = {}) {
    const check = this.canIntercept(team);
    if (!check.ok) return check;
    // 已經在外面移動的隊員不能改派攔截
    if (memberIds.some((id) => { const sv = this.game.survivors.get(id); return !sv || !this.game.survivors.isAvailable(sv); })) return { ok: false, reason: '在外移動中的隊員不能派去攔截' };
    const t = check.target;
    this.cache.set(t.id, t);
    const r = this.game.exploration.start(t.id, memberIds, 0, false, Date.now(), { ...opts, kind: 'intercept' });
    if (!r.ok) return r;
    // 抵達時目標已經回到據點就撲空
    if (r.exp.startAt + r.exp.travelMs > t.endAt) r.msg += '（⚠️ 對方可能在你抵達前就回到據點）';
    if (t.kind === 'player') this.game.territory.setHostile(t.playerId, t.owner);
    return r;
  }

  // ---------- 交戰 ----------

  /** 攔截隊抵達目標位置時交戰（線上每秒、離線結算時檢查） */
  checkArrivals(now = Date.now()) {
    this.game.state.expeditions.forEach((exp) => {
      if (exp.kind !== 'intercept' || exp.icptDone) return;
      const at = exp.startAt + (exp.travelMs || 0);
      if (now >= at) this.arrive(exp, at);
    });
  }

  arrive(exp, at) {
    const g = this.game;
    exp.icptDone = true;
    const t = exp.icptTarget;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    exp.icptResult = { events: [], resources: {}, items: [], win: false, missed: false };
    const out = exp.icptResult;
    if (!t || !members.length) {
      out.missed = true;
      out.events.push('🏳️ 目標已經不見了。');
      return;
    }
    if (t.kind === 'npc') {
      const n = g.npcs.get(t.npcId);
      if (!n || !n.trip || n.trip.startAt !== t.tripStart || n.trip.hidden || at >= n.trip.endAt || at >= (t.searchEnd ?? Infinity)) {
        out.missed = true;
        out.events.push(`🏳️ 抵達時「${t.owner}」的隊伍已經離開，撲空了。`);
        return;
      }
      const enemies = Array.from({ length: this.npcTeamSize(n) }, () => g.combat.createEnemy('raider', n.level));
      const result = g.combat.simulate(members, enemies);
      g.combat.applyOutcome(members, result, at);
      exp.travelKills = (exp.travelKills || 0) + result.kills.length;
      exp.travelXp = (exp.travelXp || 0) + result.xp;
      out.events.push(`⚔️ 攔截「${t.owner}」的隊伍（${enemies.length} 人・Lv${n.level}）`);
      // NPC 隊伍被擊倒的人員要回據點養傷
      g.npcs.wound(n, Math.min(result.kills.length, g.npcs.fullCount(n)), at);
      if (result.victory) {
        out.win = true;
        g.state.stats.battlesWon += 1;
        g.state.stats.intercepts = (g.state.stats.intercepts || 0) + 1;
        const loot = this.npcCarried(n, at);
        Object.assign(out.resources, loot);
        enemies.forEach(() => {
          if (!chance(GEAR_LOOT_CHANCE)) return;
          out.items.push(g.equipment.generate({ level: n.level, boost: 0.2 }));
        });
        this.sendNpcHome(n, at);
        out.events.push(`🏆 擊敗了對方！搶走隊伍身上的物資${out.items.length ? `與 ${out.items.length} 件裝備` : ''}，對方空手撤回據點`);
        g.log(`🏆 攔截並擊敗「${t.owner}」的隊伍`, 'success');
      } else {
        g.state.stats.battlesLost += 1;
        const lost = this.defeatLoss(members);
        Object.entries(lost.resources).forEach(([k, v]) => { n.resources[k] = (n.resources[k] || 0) + v; });
        out.events.push(`💀 攔截失敗！${this.lossText(lost)}`);
        g.log(`💀 攔截「${t.owner}」的隊伍失敗`, 'danger');
      }
      g.bus.emit('npcs:changed');
      return;
    }
    // 其他玩家：以公開的隊伍人數與等級估算對方戰力，交戰後透過事件信箱通知對方
    if (at >= t.endAt || at >= (t.searchEnd ?? Infinity)) {
      out.missed = true;
      out.events.push(`🏳️ 抵達時「${t.owner}」的隊伍已經離開搜索地點，撲空了。`);
      return;
    }
    const enemies = Array.from({ length: Math.max(1, Math.min(6, t.members)) }, () => g.combat.createEnemy('raider', t.level));
    const result = g.combat.simulate(members, enemies);
    g.combat.applyOutcome(members, result, at);
    exp.travelKills = (exp.travelKills || 0) + result.kills.length;
    exp.travelXp = (exp.travelXp || 0) + result.xp;
    out.events.push(`⚔️ 攔截玩家「${t.owner}」的探索隊（${t.members} 人）`);
    g.territory.setHostile(t.playerId, t.owner);
    if (result.victory) {
      out.win = true;
      g.state.stats.battlesWon += 1;
      g.state.stats.intercepts = (g.state.stats.intercepts || 0) + 1;
      out.events.push('🏆 擊敗了對方！對方隊伍身上的物資會在對方上線結算後送達（每件裝備有 5% 機率被搶走）');
      g.territory.send(t.playerId, 'intercept', { tripId: t.tripId, win: true });
      g.log(`🏆 攔截並擊敗玩家「${t.owner}」的探索隊`, 'success');
    } else {
      g.state.stats.battlesLost += 1;
      const lost = this.defeatLoss(members);
      out.events.push(`💀 攔截失敗！${this.lossText(lost)}`);
      g.territory.send(t.playerId, 'intercept', { tripId: t.tripId, win: false, plunder: this.packPlunder(lost) });
      g.log(`💀 攔截玩家「${t.owner}」的探索隊失敗`, 'danger');
    }
  }

  /** NPC 隊伍身上的物資：探索完正在返程的隊伍帶著搜刮到的物資 */
  npcCarried(n, at) {
    const trip = n.trip;
    const p = tripProgress(trip, at);
    if (trip.kind === 'explore' && (p.phase === 'returning' || p.phase === 'searching')) {
      const poi = this.game.state.map.pois.find((x) => x.id === trip.poiId);
      if (poi) {
        // 搜索中只搜到一部分
        const done = p.phase === 'searching' && trip.searchMs ? Math.min(1, (at - trip.startAt - trip.travelMs) / trip.searchMs) : 1;
        const stock = stockOf(poi, trip.startAt + trip.travelMs, this.game.state.map.remain);
        const out = Object.fromEntries(Object.entries(stock.resources).map(([k, v]) => [k, Math.round(v * 0.6 * done)]).filter(([, v]) => v > 0));
        if (Object.keys(out).length) return out;
      }
    }
    return { food: randInt(5, 20), scrap: randInt(2, 8), ...(chance(0.4) ? { ammo9: randInt(5, 20) } : {}) };
  }

  /** 被擊敗的 NPC 隊伍空手走回據點（隱藏，不顯示在地圖上） */
  sendNpcHome(n, at) {
    const pos = tripProgress(n.trip, at).pos;
    const dist = haversine(pos.lat, pos.lon, n.lat, n.lon);
    const travelMs = Math.round((dist / 1000) * NPC_CONFIG.walkMinPerKm * 60000);
    const home = { lat: n.lat, lon: n.lon };
    n.trip = {
      kind: 'return', hidden: true, from: home, to: pos, path: [home, pos],
      startAt: at - travelMs, travelMs, searchMs: 0, distanceM: Math.round(dist), endAt: at + travelMs, crossings: [],
    };
  }

  /**
   * 隊伍被擊敗：身上（背包）的物資全部被搶走；每件裝備（穿戴中與背包內）各有 5% 機率被搶走。
   * @returns {{resources: Record<string, number>, items: object[]}}
   */
  defeatLoss(members) {
    const g = this.game;
    const eq = g.equipment;
    const resources = {};
    const items = [];
    members.forEach((sv) => {
      Object.entries(sv.bag || {}).forEach(([k, v]) => { if (v > 0) resources[k] = (resources[k] || 0) + Math.floor(v); });
      sv.bag = {};
      const owned = [
        ...SLOT_KEYS.map((slot) => eq.getItem(sv.equipment[slot])).filter(Boolean),
        ...eq.bagItems(sv),
      ];
      owned.forEach((it) => {
        if (!chance(GEAR_LOOT_CHANCE)) return;
        SLOT_KEYS.forEach((slot) => { if (sv.equipment[slot] === it.id) sv.equipment[slot] = null; });
        g.state.inventory.items = eq.items.filter((x) => x.id !== it.id);
        items.push(it);
      });
    });
    return { resources, items };
  }

  lossText(lost) {
    const n = Object.values(lost.resources).reduce((s, v) => s + v, 0);
    const parts = [];
    if (n) parts.push(`隊員身上 ${n} 個物資被搶走`);
    if (lost.items.length) parts.push(`裝備「${lost.items.map((i) => i.name).join('」「')}」被搶走`);
    return parts.length ? parts.join('，') : '幸好身上沒有東西被搶走';
  }

  /** 傳給對方的戰利品（事件信箱每筆最多 2KB：裝備只送型號、品級與等級，由對方重新生成） */
  packPlunder(lost) {
    return {
      resources: lost.resources,
      items: lost.items.slice(0, MAX_LOOT_ITEMS).map((it) => ({ model: it.model, rarity: it.rarity, level: it.level })),
    };
  }

  // ---------- 被攔截（自己的隊伍）與戰利品 ----------

  /**
   * 自己的探索隊被擊敗：立刻折返，從目前位置走回避難所（不公開給其他玩家），身上物資被搶。
   * @returns {{resources:object, items:object[]}|null}
   */
  defeatExpedition(exp, now = Date.now(), by = '敵人') {
    const g = this.game;
    if (!exp || exp.defeated) return null;
    const p = g.exploration.progress(exp, now);
    const home = g.shelter.primary() || exp.from;
    if (!p || !home) return null;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const lost = this.defeatLoss(members);
    const dist = haversine(p.pos.lat, p.pos.lon, home.lat, home.lon);
    const travelMs = exp.distanceM ? Math.round(exp.travelMs * (dist / exp.distanceM)) : 0;
    Object.assign(exp, {
      defeated: true, defeatedBy: by, defeatLoss: { resources: lost.resources, items: lost.items.map((i) => i.name) },
      from: { lat: home.lat, lon: home.lon }, path: [{ lat: home.lat, lon: home.lon }, p.pos],
      distanceM: Math.round(dist), travelMs, searchMs: 0, startAt: now - travelMs, endAt: now + travelMs,
      threats: [], auto: false,
    });
    exp.travelEvents = [...(exp.travelEvents || []), `💀 遭到${by}攔截，戰敗！${this.lossText(lost)}`];
    g.toast(`💀 你的探索隊遭到${by}攔截，正在撤回據點`, 'danger');
    g.log(`💀 探索隊遭到${by}攔截，${this.lossText(lost)}`, 'danger');
    return lost;
  }

  /** 收到其他玩家的攔截結果 */
  handleIntercept(e) {
    const g = this.game;
    const name = String(e.fromName || '某位玩家').slice(0, 16);
    const d = e.data || {};
    g.territory.setHostile(e.from, name);
    const exp = g.state.expeditions.find((x) => x.id === d.tripId);
    if (d.win) {
      // 對方贏了：自己的隊伍被擊敗，戰利品送回給對方
      const lost = exp ? this.defeatExpedition(exp, Date.now(), `玩家「${name}」`) : null;
      g.territory.send(e.from, 'plunder', lost ? this.packPlunder(lost) : { resources: {}, items: [], missed: true });
      if (!exp) g.log(`⚔️ 玩家「${name}」攔截了你的探索隊，但隊伍已經回到據點`, 'info');
      return;
    }
    // 對方輸了：擊退攔截者並取得對方身上的物資
    const got = this.receivePlunder(d.plunder, `擊退玩家「${name}」的攔截`);
    g.log(`🛡️ 你的探索隊擊退了玩家「${name}」的攔截${got ? `，取得 ${got}` : ''}`, 'success');
    g.toast(`🛡️ 你的探索隊擊退了玩家「${name}」的攔截`, 'success');
  }

  /** 收到攔截成功的戰利品 */
  handlePlunder(e) {
    const name = String(e.fromName || '某位玩家').slice(0, 16);
    if (e.data?.missed) {
      this.game.log(`🏳️ 玩家「${name}」的隊伍在戰利品結算前已回到據點，沒有搶到東西`, 'info');
      return;
    }
    const got = this.receivePlunder(e.data, `攔截玩家「${name}」`);
    this.game.log(`🎁 攔截玩家「${name}」的戰利品送達：${got || '對方身上沒有東西'}`, 'loot');
    this.game.toast(`🎁 攔截玩家「${name}」的戰利品送達`, 'success');
  }

  /**
   * 收下其他玩家送來的戰利品（外部資料，需驗證：只接受已知的物資與裝備型號，數量有上限）
   * @returns {string} 描述
   */
  receivePlunder(data, source) {
    const g = this.game;
    if (!data || typeof data !== 'object') return '';
    const res = {};
    Object.entries(data.resources || {}).forEach(([k, v]) => {
      const n = Math.floor(Number(v));
      if ((RESOURCE_KEYS.includes(k) || isSupply(k)) && Number.isFinite(n) && n > 0) res[k] = Math.min(MAX_LOOT_AMOUNT, n);
    });
    const got = g.grant(res);
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, MAX_LOOT_ITEMS).map((raw) => {
      const md = ITEM_MODELS[raw?.model];
      if (!md || !RARITIES[raw.rarity]) return null;
      // 依型號、品級、等級重新生成，避免對方送來不合理的數值
      const it = g.equipment.generate({ level: Math.min(60, Math.max(1, Math.round(Number(raw.level) || 1))), model: raw.model, rarity: raw.rarity });
      g.equipment.addItem(it, source);
      return it;
    }).filter(Boolean);
    const text = [
      ...Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${SUPPLIES[k]?.name || k}×${v}`),
      ...items.map((i) => `「${i.name}」`),
    ];
    return text.join('、');
  }

  // ---------- 報告 ----------

  /** 攔截隊返回時的報告 */
  report(exp) {
    const g = this.game;
    const t = exp.icptTarget || {};
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    if (!exp.icptDone) this.arrive(exp, exp.startAt + (exp.travelMs || 0));
    const r = exp.icptResult;
    const report = {
      id: uid('rp'), poiName: `⚔️ 攔截：${t.name || '野外隊伍'}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || []), ...r.events], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: r.win, members: members.map((m) => m.name),
    };
    if (r.win) {
      report.resources = g.grant(r.resources);
      report.items = r.items.filter((it) => g.equipment.addItem(it, '攔截', members));
    }
    return report;
  }

  /** 被攔截而撤回的探索隊報告 */
  defeatedReport(exp) {
    const g = this.game;
    const poi = g.exploration.poi(exp.poiId);
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    return {
      id: uid('rp'), poiName: poi?.name || '未知地點', poiType: poi?.type, at: exp.endAt,
      events: [...(exp.travelEvents || []), '🏳️ 隊伍被攔截後空手撤回據點。'],
      resources: {}, items: [], blueprints: [], kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: false,
      members: members.map((m) => m.name),
    };
  }
}
