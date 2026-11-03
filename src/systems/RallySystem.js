import { AssistSystem } from './AssistSystem.js';
import { uid, pick, randInt } from '../utils/math.js';
import { haversine } from '../utils/math.js';

/** 集結：出發倒數可選的分鐘數 */
export const RALLY_DELAYS = [5, 10, 15, 20];
/** 查詢範圍（公里） */
export const RALLY_KM = 20;
/** 結算鎖定逾時（結算中的人斷線時，其他參加者可以接手） */
const LOCK_MS = 60000;
/** 攻陷 NPC 據點時能搶到的金錢比例（與單獨攻打相同） */
const NPC_COIN_LOOT = 0.35;

/**
 * 集結（廣播塔）：對 NPC 據點或重度感染據點發起，好友派隊參加，一起出發、一起作戰。
 *  - 集結資料存在共用物件 rally:<id>；隊員的戰鬥數值在加入時寫入，因此任何一位參加者都能結算，
 *    發起人或其他參加者不在線上也不影響。
 *  - 隊伍數量 = 廣播塔等級 + 1（含發起人）；倒數結束或滿員時出發；出發前發起人可以取消。
 *  - 成功後金錢平分，其他物品隨機分配給參加的隊伍。
 */
export class RallySystem {
  constructor(game) {
    this.game = game;
    this.busy = new Set();
    this.lastAt = 0;
    game.shared?.watch('rally', RALLY_KM);
  }

  get st() {
    const s = this.game.state;
    s.rally = s.rally || { seen: {} };
    s.rally.seen = s.rally.seen || {};
    return s.rally;
  }

  myId() {
    return this.game.shared.store().me;
  }

  level() {
    return this.game.shelter.maxLevel('broadcast');
  }

  maxTeams(lv = this.level()) {
    return lv > 0 ? lv + 1 : 0;
  }

  get(id) {
    const d = this.game.shared.get('rally', id);
    return d ? { id, ...d } : null;
  }

  /** 自己參加中（含發起）的集結行程 */
  trips() {
    return this.game.state.expeditions.filter((e) => e.kind === 'rally' && e.rallyId);
  }

  /** 好友發起、還在集結中、自己還沒參加的 */
  invites(now = Date.now()) {
    const me = this.myId();
    const t = this.game.territory;
    const mine = new Set(this.trips().map((e) => e.rallyId));
    return this.game.shared.all('rally').map((o) => ({ id: o.id, ...o.data }))
      .filter((d) => d.status === 'gathering' && d.owner !== me && !mine.has(d.id) && now < d.departAt
        && t.relation(d.owner) === 'friend' && !(d.teams || []).some((x) => x.player === me));
  }

  /** 目標（NPC 據點或重度感染據點） */
  target(t) {
    const g = this.game;
    if (t.kind === 'npc') return g.npcs.get(t.id) || g.npcs.byIdent?.(t.ident) || null;
    if (t.kind === 'inf') return g.infected.get(t.id) || g.infected.byId?.(t.id) || null;
    return null;
  }

  /** 讓探索系統把集結目標當成目的地 */
  asPoi(id) {
    if (!String(id).startsWith('rally:')) return null;
    const d = this.get(String(id).slice(6)) || this.pendingTarget;
    const t = d?.target || this.pendingTarget;
    return t && {
      id, name: `📡 集結：${t.name}`, lat: t.lat, lon: t.lon, type: 'military', icon: '📡', rally: true,
    };
  }

  canStart(target) {
    const g = this.game;
    if (!g.shelter.hasShelter()) return { ok: false, reason: '需要先有避難所' };
    if (this.level() < 1) return { ok: false, reason: '需要建造📡廣播塔' };
    if (this.trips().some((e) => this.get(e.rallyId)?.owner === this.myId() && ['gathering', 'departed', 'resolving'].includes(this.get(e.rallyId)?.status))) {
      return { ok: false, reason: '已經有進行中的集結' };
    }
    if (target && !['npc', 'inf'].includes(target.kind)) return { ok: false, reason: '只能對 NPC 據點或重度感染據點發起集結' };
    return { ok: true };
  }

  /** 隊員的戰鬥數值（寫入集結資料，讓任何參加者都能結算） */
  units(memberIds) {
    const g = this.game;
    return memberIds.map((id, i) => {
      const sv = g.survivors.get(id);
      if (!sv) return null;
      const s = g.survivors.stats(sv);
      return {
        i, name: sv.name, lv: sv.level, hp: Math.round(g.survivors.hpOf(sv)), maxHp: Math.round(s.hp), atk: Math.round(s.atk), def: Math.round(s.def),
        crit: +s.crit.toFixed(3), critDmg: +s.critDmg.toFixed(2), dodge: +s.dodge.toFixed(3), atkSpeed: +s.atkSpeed.toFixed(2),
      };
    }).filter(Boolean);
  }

  /** 出發加入（自己的倖存者成為「集結中」的隊伍，直到結果出來） */
  depart(rallyId, target, memberIds, vehicleIds = []) {
    this.pendingTarget = target;
    const r = this.game.exploration.start(`rally:${rallyId}`, memberIds, 0, false, Date.now(), { kind: 'rally', vehicleIds });
    this.pendingTarget = null;
    if (!r.ok) return r;
    r.exp.rallyId = rallyId;
    // 集結一起行動：不會單獨遇襲或被攔截
    r.exp.encountered = null;
    r.exp.threats = [];
    r.exp.rallyTarget = target;
    // 結果出來前不會結束（由集結系統設定回家時間）
    r.exp.endAt = r.exp.startAt + 24 * 3600000;
    return r;
  }

  /**
   * 發起集結。
   * @param {{kind:'npc'|'inf', id:string, name:string, lat:number, lon:number, ident?:string}} target
   */
  async start(target, delayMin, memberIds, vehicleIds = []) {
    const g = this.game;
    const c = this.canStart(target);
    if (!c.ok) return c;
    if (!RALLY_DELAYS.includes(Number(delayMin))) return { ok: false, reason: '請選擇出發倒數時間' };
    if (!this.target(target)) return { ok: false, reason: '目標已經不在了' };
    const id = uid('rl');
    const dep = this.depart(id, target, memberIds, vehicleIds);
    if (!dep.ok) return dep;
    const now = Date.now();
    const me = this.myId();
    const sh = g.shelter.primary();
    const data = {
      owner: me, ownerName: g.state.player.name || '倖存者', target, status: 'gathering', at: now,
      departAt: now + Number(delayMin) * 60000, travelMs: dep.exp.travelMs, maxTeams: this.maxTeams(),
      teams: [{ player: me, name: g.state.player.name || '倖存者', units: this.units(memberIds), at: now }],
    };
    const r = await g.shared.update('rally', id, (d) => (d ? { fail: '編號重複，請再試一次' } : { data }), { lat: sh.lat, lon: sh.lon });
    if (!r.ok) {
      this.abort(dep.exp);
      return r;
    }
    g.log(`📡 發起集結：目標「${target.name}」，${delayMin} 分鐘後出發（最多 ${data.maxTeams} 支隊伍）`, 'info');
    return { ok: true, id, msg: `已發起集結，好友會收到通知（${delayMin} 分鐘後出發）` };
  }

  /** 參加好友的集結 */
  async join(rallyId, memberIds, vehicleIds = []) {
    const g = this.game;
    const d0 = this.get(rallyId);
    if (!d0 || d0.status !== 'gathering') return { ok: false, reason: '這個集結已經出發或結束了' };
    if (g.territory.relation(d0.owner) !== 'friend') return { ok: false, reason: '只能參加友好玩家的集結' };
    if ((d0.teams || []).length >= d0.maxTeams) return { ok: false, reason: '集結隊伍已滿' };
    if (!this.target(d0.target) && d0.target.kind === 'npc' && !d0.target.ident) return { ok: false, reason: '目標已經不在了' };
    const dep = this.depart(rallyId, d0.target, memberIds, vehicleIds);
    if (!dep.ok) return dep;
    const me = this.myId();
    const team = { player: me, name: g.state.player.name || '倖存者', units: this.units(memberIds), at: Date.now() };
    const r = await g.shared.update('rally', rallyId, (d) => {
      if (!d || d.status !== 'gathering') return { fail: '這個集結已經出發或結束了' };
      if ((d.teams || []).some((x) => x.player === me)) return { fail: '已經參加了' };
      if (d.teams.length >= d.maxTeams) return { fail: '集結隊伍已滿' };
      d.teams.push(team);
      return { data: d };
    });
    if (!r.ok) {
      this.abort(dep.exp);
      return r;
    }
    g.log(`📡 參加「${d0.ownerName}」的集結：目標「${d0.target.name}」`, 'info');
    return { ok: true, msg: `已加入「${d0.ownerName}」的集結` };
  }

  /** 取消（發起人）或退出（參加者）：只能在出發前 */
  async leave(rallyId) {
    const g = this.game;
    const me = this.myId();
    const r = await g.shared.update('rally', rallyId, (d) => {
      if (!d) return { fail: '找不到集結' };
      if (d.status !== 'gathering') return { fail: '已經出發了，不能取消' };
      if (d.owner === me) d.status = 'cancelled';
      else d.teams = (d.teams || []).filter((x) => x.player !== me);
      return { data: d };
    });
    if (!r.ok) return r;
    this.trips().filter((e) => e.rallyId === rallyId).forEach((e) => this.abort(e));
    return { ok: true, msg: r.data.owner === me ? '已取消集結' : '已退出集結' };
  }

  /** 還沒出發就結束：隊員直接留在避難所 */
  abort(exp) {
    const g = this.game;
    g.state.expeditions = g.state.expeditions.filter((e) => e.id !== exp.id);
    g.exploration.free(exp);
    g.bus.emit('expedition:done', { reports: [] });
  }

  /** 每 2 秒：出發、結算、套用結果、好友通知 */
  update(now = Date.now()) {
    if (now - this.lastAt < 2000) return;
    this.lastAt = now;
    const g = this.game;
    this.invites(now).forEach((d) => {
      if (this.st.seen[d.id]) return;
      this.st.seen[d.id] = now;
      g.log(`📡 好友「${d.ownerName}」發起集結：目標「${d.target.name}」，${Math.max(1, Math.round((d.departAt - now) / 60000))} 分鐘後出發（地圖左上角點擊參加）`, 'info');
      g.toast(`📡 好友「${d.ownerName}」發起集結，點地圖左上角參加`, 'info');
    });
    Object.keys(this.st.seen).forEach((k) => { if (now - this.st.seen[k] > 86400000) delete this.st.seen[k]; });
    this.trips().forEach((exp) => this.step(exp, now));
  }

  async step(exp, now) {
    const g = this.game;
    const d = this.get(exp.rallyId);
    if (!d || this.busy.has(exp.rallyId)) return;
    if (d.status === 'cancelled' || (d.status === 'gathering' && !(d.teams || []).some((x) => x.player === this.myId()))) {
      g.log(`📡 集結「${d.target?.name}」已取消，隊員留在避難所`, 'info');
      this.abort(exp);
      return;
    }
    this.busy.add(exp.rallyId);
    try {
      if (d.status === 'gathering' && (now >= d.departAt || d.teams.length >= d.maxTeams)) {
        await g.shared.update('rally', exp.rallyId, (x) => {
          if (!x || x.status !== 'gathering') return { fail: 'done' };
          x.status = 'departed';
          x.departedAt = Math.min(now, x.departAt);
          x.fightAt = x.departedAt + (x.travelMs || 0);
          return { data: x };
        });
      } else if ((d.status === 'departed' && now >= d.fightAt) || (d.status === 'resolving' && now - (d.lockAt || 0) > LOCK_MS)) {
        await this.resolve(exp.rallyId, now);
      } else if (d.status === 'done' && !exp.rallyResult) {
        exp.rallyResult = d.result?.teams?.[this.myId()] || { units: [], coins: 0, items: [], mats: {} };
        exp.rallySummary = d.result?.summary || '';
        exp.rallyVictory = !!d.result?.victory;
        exp.endAt = Math.max(now, (d.fightAt || now) + (exp.travelMs || 0));
      }
    } finally {
      this.busy.delete(exp.rallyId);
    }
  }

  /** 結算（任何一位參加者都可以）：先鎖定，計算戰鬥並改變目標，再寫入結果 */
  async resolve(rallyId, now = Date.now()) {
    const g = this.game;
    const me = this.myId();
    const lock = await g.shared.update('rally', rallyId, (x) => {
      if (!x || !(x.status === 'departed' || (x.status === 'resolving' && now - (x.lockAt || 0) > LOCK_MS))) return { fail: 'busy' };
      x.status = 'resolving';
      x.lockBy = me;
      x.lockAt = now;
      return { data: x };
    });
    if (!lock.ok) return lock;
    const d = lock.data;
    const out = await this.fight(d, now);
    return g.shared.update('rally', rallyId, (x) => {
      if (!x || x.status !== 'resolving' || x.lockBy !== me) return { fail: 'lost' };
      x.status = 'done';
      x.result = out;
      return { data: x };
    });
  }

  /** 集結戰鬥：所有隊伍的隊員一起上場 */
  async fight(d, now) {
    const g = this.game;
    const teams = d.teams || [];
    const units = teams.flatMap((t) => (t.units || []).slice(0, 6).map((u) => AssistSystem.unitOf({ id: t.player, name: t.name }, u)));
    const people = units.length;
    const empty = () => Object.fromEntries(teams.map((t) => [t.player, { units: [], coins: 0, items: [], mats: {} }]));
    const res = { victory: false, summary: '', teams: empty() };
    const tg = this.target(d.target);
    if (!tg) {
      res.summary = `抵達時「${d.target.name}」已經不在了`;
      teams.forEach((t) => { res.teams[t.player].units = (t.units || []).map((u) => ({ i: u.i, hp: u.hp, down: false })); });
      return res;
    }
    const share = (coins, items, mats) => {
      const n = Math.max(1, teams.length);
      teams.forEach((t) => { res.teams[t.player].coins += Math.floor(coins / n); });
      items.forEach((it) => { res.teams[pick(teams).player].items.push(it); });
      Object.entries(mats).forEach(([k, v]) => {
        // 每一份隨機分給一支隊伍
        let left = v;
        while (left > 0) {
          const part = Math.max(1, Math.ceil(v / Math.max(1, teams.length)));
          const who = res.teams[pick(teams).player].mats;
          who[k] = (who[k] || 0) + Math.min(part, left);
          left -= part;
        }
      });
    };
    let result;
    if (d.target.kind === 'npc') {
      const n = tg;
      const df = g.npcs.defense(n);
      const attackers = units.map((u) => ({ u, maxHp: u.maxHp, atk: u.atk }));
      const as = g.combat.wallAssault(attackers, df.wall, df.dps);
      const fallen = new Set(attackers.filter((a) => !as.alive.includes(a)).map((a) => a.u.id));
      const fighters = units.filter((u) => !fallen.has(u.id));
      result = as.breached && fighters.length ? g.combat.simulate([], g.npcs.garrison(n), { allies: fighters, record: false }) : null;
      const down = new Set([...fallen, ...(result ? result.team.filter((x) => x.down).map((x) => x.id) : fighters.map((u) => u.id))]);
      units.forEach((u) => {
        const r = result?.team.find((x) => x.id === u.id);
        res.teams[u.ally.player].units.push({ i: u.ally.i, hp: down.has(u.id) ? 0 : Math.round(r?.hp ?? u.hp), down: down.has(u.id) });
      });
      res.victory = !!result?.victory;
      if (res.victory) {
        const items = Array.from({ length: 1 + Math.floor(teams.length / 2) }, () => g.equipment.generate({ level: n.level, boost: 0.4 }));
        share(Math.round(n.coins * NPC_COIN_LOOT), items, Object.fromEntries(Object.entries(n.resources).filter(([, v]) => v > 0)));
        g.npcs.destroy(n, now);
        res.summary = `🏆 集結攻陷 NPC 據點「${n.name}」（${people} 人參戰）`;
      } else {
        g.npcs.wound(n, Math.min(result ? result.kills.length : as.killed, g.npcs.fullCount(n)), now);
        res.summary = `💀 集結攻打「${n.name}」失敗（${as.breached ? '與守軍交戰落敗' : '沒能打破圍牆'}）`;
      }
    } else {
      const s = tg;
      const b = g.infected.battle(s, [], units, now);
      result = b.result;
      units.forEach((u) => {
        const r = result.team.find((x) => x.id === u.id);
        res.teams[u.ally.player].units.push({ i: u.ally.i, hp: Math.round(r?.hp ?? 0), down: !!r?.down });
      });
      const p = await g.infected.addPurity(s, b.gain, now);
      res.purity = p.purity;
      res.victory = !!p.killed;
      if (p.killed) {
        const rw = g.infected.rewards(s, people);
        share(rw.coins, rw.items, rw.mats);
        res.summary = `🏆 集結消滅重度感染據點「${s.name}」（${people} 人參戰）`;
      } else res.summary = `☣️ 集結淨化「${s.name}」：淨化度 ${b.before.toFixed(1)}% → ${(p.purity ?? b.before + b.gain).toFixed(1)}%`;
    }
    void randInt;
    return res;
  }

  /** 探索系統結算集結行程（回到避難所時） */
  report(exp) {
    const g = this.game;
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const r = exp.rallyResult || { units: [], coins: 0, items: [], mats: {} };
    const report = {
      id: uid('rp'), poiName: `📡 集結：${exp.rallyTarget?.name || ''}`, poiType: 'military', at: exp.endAt,
      events: [...(exp.travelEvents || [])], resources: {}, items: [], blueprints: [],
      kills: exp.travelKills || 0, xp: exp.travelXp || 0, success: !!exp.rallyVictory, members: members.map((m) => m.name),
    };
    if (exp.rallySummary) report.events.push(exp.rallySummary);
    (r.units || []).forEach((u) => {
      const sv = g.survivors.get(exp.memberIds[u.i]);
      if (!sv) return;
      if (u.down) g.survivors.becomeSevere(sv, '在集結戰鬥中', exp.endAt);
      else g.survivors.setHp(sv, Math.max(1, u.hp));
    });
    (r.items || []).forEach((it) => {
      const item = { ...it, id: uid('it') };
      if (g.equipment.addItem(item, '集結')) report.items.push(item);
    });
    report.resources = g.grant({ ...(r.mats || {}), coins: r.coins || 0 });
    if (exp.rallyVictory) g.state.stats.battlesWon += 1;
    else g.state.stats.battlesLost += 1;
    return report;
  }

  /** 左上角顯示：自己發起或參加中的集結 */
  feed(now = Date.now()) {
    return this.trips().map((e) => ({ exp: e, d: this.get(e.rallyId) })).filter((x) => x.d).map(({ exp, d }) => ({
      id: d.id, exp, target: d.target, mine: d.owner === this.myId(), status: d.status, teams: (d.teams || []).length, maxTeams: d.maxTeams,
      left: d.status === 'gathering' ? Math.max(0, d.departAt - now) : d.status === 'departed' ? Math.max(0, (d.fightAt || now) - now) : 0,
      ownerName: d.ownerName,
    }));
  }

  /** 與目標的距離（公尺） */
  distanceTo(t) {
    const sh = this.game.shelter.primary();
    return sh ? Math.round(haversine(sh.lat, sh.lon, t.lat, t.lon)) : 0;
  }
}
