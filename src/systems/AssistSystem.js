import { haversine, uid } from '../utils/math.js';
import { tripProgress } from './ExplorationSystem.js';

/** 協防火力上限（每秒傷害，防止竄改的公開資料） */
export const MAX_ASSIST_DPS = 3000;
/** 協防隊趕路較快：步行時間倍率 */
export const ASSIST_TRAVEL_MUL = 0.5;
/** 防禦範圍涵蓋友好據點時，防禦設施分出多少火力幫忙 */
export const COVER_DPS_SHARE = 0.5;
/** 協防隊員的火力倍率（自己據點的防禦駐守為 0.6） */
export const ASSIST_ATK_MUL = 1;

/**
 * 友好玩家的屍潮協防：
 *  - 主要據點正在被屍潮攻擊時，公開資料會附上屍潮狀況，友好玩家可以即時看到。
 *  - 派隊協防：直接指派隊伍前往友好玩家的據點（趕路比一般探索快），抵達後一起打殭屍到天亮或被召回。
 *  - 防禦範圍涵蓋：自己避難所的屍潮防禦範圍（地圖上最外層的圓圈）涵蓋到友好據點時，防禦設施會自動分出火力協助。
 *  - 協助的火力透過公開資料傳給對方；對方的屍潮模擬每秒對殭屍造成這些傷害。
 */
export class AssistSystem {
  constructor(game) {
    this.game = game;
    this.cache = new Map();
    this.notified = new Map(); // 友好玩家屍潮通知（每晚一次）
    this.helpersSeen = new Set();
  }

  /** 舊版（指派防禦駐守）的協防已改為派隊，保留空集合相容 */
  assistingIds() {
    return new Set();
  }

  /** 友好玩家正在被屍潮攻擊的據點 */
  friendSieges() {
    const g = this.game;
    const out = [];
    (g.world?.others || []).forEach((p) => {
      if (g.territory.relation(p.id) !== 'friend') return;
      p.bases.forEach((b, i) => { if (b.siege) out.push({ player: p, base: b, index: i }); });
    });
    return out;
  }

  /** 友好玩家正被 NPC 或玩家攻打的據點（還在路上的隊伍） */
  friendRaids(now = Date.now()) {
    const g = this.game;
    const out = [];
    (g.world?.others || []).forEach((p) => {
      if (g.territory.relation(p.id) !== 'friend') return;
      p.bases.forEach((b) => (b.raids || []).forEach((r) => { if (r.at > now) out.push({ player: p, base: b, raid: r }); }));
    });
    return out;
  }

  // ================= 防禦範圍涵蓋 =================

  /** 自己避難所的屍潮防禦範圍（公尺） */
  coverRadius(base = this.game.shelter.primary()) {
    return base ? Math.round(this.game.shelter.siegeRangeMeters(base)) : 0;
  }

  /** 公開的防禦範圍與可以分出的防禦設施火力 */
  publishedCover() {
    const g = this.game;
    const b = g.shelter.primary();
    if (!b) return null;
    const dps = Math.round(g.siege.of(b.id).defenseDps({ towersOnly: true }) * COVER_DPS_SHARE);
    return dps > 0 ? { r: this.coverRadius(b), dps: Math.min(MAX_ASSIST_DPS, dps) } : null;
  }

  /** 自己的防禦範圍是否涵蓋這個據點 */
  covers(base) {
    const sh = this.game.shelter.primary();
    return !!sh && !!base && haversine(sh.lat, sh.lon, base.lat, base.lon) <= this.coverRadius(sh);
  }

  // ================= 派隊協防 =================

  player(playerId) {
    return (this.game.world?.others || []).find((p) => p.id === playerId) || null;
  }

  /** 讓探索系統把協防目的地當成地點：id = assist:玩家ID */
  asPoi(id) {
    if (!String(id).startsWith('assist:')) return null;
    let t = this.cache.get(id) || this.game.state.expeditions.find((e) => e.poiId === id)?.assistTarget;
    if (!t) {
      const p = this.player(id.slice(7));
      const b = p && (p.bases.find((x) => x.primary) || p.bases[0]);
      if (b) t = { playerId: p.id, name: p.name, baseName: b.name, lat: b.lat, lon: b.lon };
    }
    return t && {
      id, name: `🛡️ 協防「${t.name}」`, lat: t.lat, lon: t.lon, type: 'residential', icon: '🛡️', assist: true, target: t,
    };
  }

  /** 進行中的協防隊 */
  trips() {
    return this.game.state.expeditions.filter((e) => e.kind === 'assist' && !e.recalled && !e.defeated);
  }

  canAssist(playerId) {
    const g = this.game;
    const p = this.player(playerId);
    if (!g.shelter.hasShelter()) return { ok: false, reason: '請先建立避難所' };
    if (!p) return { ok: false, reason: '找不到這位玩家（可能已離線）' };
    if (g.territory.relation(playerId) !== 'friend') return { ok: false, reason: '只能協防友好玩家' };
    const base = p.bases.find((b) => b.primary) || p.bases[0];
    if (!g.time.phase().zombies) return { ok: false, reason: '屍潮只在夜晚來襲，入夜後才能派隊協防' };
    if (this.trips().some((e) => e.assistTarget?.playerId === playerId)) return { ok: false, reason: '已經有隊伍在協防對方' };
    return { ok: true, player: p, base };
  }

  /** 派隊伍前往友好玩家的據點協防到天亮 */
  start(playerId, memberIds, { vehicleIds = [], avoidHostile = false } = {}) {
    const g = this.game;
    const c = this.canAssist(playerId);
    if (!c.ok) return c;
    const id = `assist:${playerId}`;
    const target = { playerId, name: c.player.name, baseName: c.base.name, lat: c.base.lat, lon: c.base.lon };
    this.cache.set(id, target);
    const now = Date.now();
    const st = g.exploration.start(id, memberIds, 0, false, now, { kind: 'assist', vehicleIds, avoidHostile });
    if (!st.ok) return st;
    const exp = st.exp;
    exp.assistTarget = target;
    // 抵達後留守到天亮
    exp.searchMs = Math.max(60000, g.time.nextDawn(now) - (now + exp.travelMs));
    exp.endAt = exp.startAt + exp.travelMs * 2 + exp.searchMs;
    g.world?.syncSoon?.();
    return { ok: true, exp, msg: `隊伍出發協防「${c.player.name}」，約 ${Math.max(1, Math.round(exp.travelMs / 60000))} 分鐘後抵達，留守到天亮` };
  }

  /** 已抵達、正在協防的隊伍 */
  activeTrips(now = Date.now()) {
    return this.trips().filter((e) => tripProgress(e, now).phase === 'searching');
  }

  /** 協防隊的火力（出發時就計算好，讓自己離線時對方也能套用） */
  teamDps(exp) {
    const g = this.game;
    const list = exp.memberIds.map((id) => g.survivors.get(id)).filter((s) => s && !s.severe);
    const siege = g.siege.of();
    if (!siege) return { dps: 0, count: 0 };
    const dps = list.reduce((s, sv) => s + siege.meleeOrRangedAtk(sv, true) * ASSIST_ATK_MUL * siege.guardMul(), 0);
    return { dps: Math.min(MAX_ASSIST_DPS, Math.round(dps)), count: list.length };
  }

  /**
   * 公開的協防資料（目前只公開一支協防隊）。出發時就公開抵達時間：
   * 即使自己之後關掉遊戲，對方在協防隊抵達後也會套用這份火力。
   */
  published(now = Date.now()) {
    const exp = this.trips().find((e) => e.assistTarget && now < e.startAt + e.travelMs + e.searchMs);
    if (!exp) return null;
    const t = this.teamDps(exp);
    if (!t.count) return null;
    return {
      to: exp.assistTarget.playerId, dps: t.dps, count: t.count, at: exp.startAt + exp.travelMs, until: exp.startAt + exp.travelMs + exp.searchMs,
    };
  }

  /**
   * 協助自己主要據點的友好玩家：派隊前來的，以及防禦範圍涵蓋到這裡的。
   * @returns {{id:string, name:string, dps:number, count:number, kind:'team'|'cover'}[]}
   */
  incoming(now = Date.now()) {
    const g = this.game;
    const myId = g.world?.myId;
    const primary = g.shelter.primary();
    if (!primary) return [];
    const out = [];
    (g.world?.others || []).forEach((p) => {
      if (g.territory.relation(p.id) !== 'friend') return;
      if (myId && p.assist?.to === myId && p.assist.until > now && (p.assist.at || 0) <= now) out.push({ id: p.id, name: p.name, dps: p.assist.dps, count: p.assist.count, kind: 'team' });
      const home = p.bases.find((b) => b.primary) || p.bases[0];
      if (p.cover && home && haversine(home.lat, home.lon, primary.lat, primary.lon) <= p.cover.r) {
        out.push({ id: `${p.id}#cover`, name: p.name, dps: p.cover.dps, count: 0, kind: 'cover' });
      }
    });
    return out;
  }

  /** 對方公開的協防戰果中，自己的部分 */
  myResult(player) {
    const myId = this.game.world?.myId;
    const home = player?.bases.find((b) => b.primary) || player?.bases[0];
    const a = home?.assisted;
    if (!a || !myId) return null;
    const mine = a.list.filter((x) => x.id === myId || x.id === `${myId}#cover`);
    if (!mine.length) return null;
    return {
      night: a.night, result: a.result, base: home.name,
      dmg: mine.reduce((s, x) => s + x.dmg, 0), kills: mine.reduce((s, x) => s + x.kills, 0),
      team: mine.some((x) => x.kind === 'team'), cover: mine.some((x) => x.kind === 'cover'),
    };
  }

  /** 協防戰報文字 */
  resultText(name, r) {
    const how = [r.team ? '協防隊' : '', r.cover ? '防禦設施' : ''].filter(Boolean).join('與');
    const res = r.result === 'breached' ? '💥 對方據點的防線還是被突破了' : r.result === 'ok' ? '✅ 成功守住對方據點' : '⏳ 屍潮還在進行中';
    return `🛡️ 協防「${name}」戰報：你的${how}造成 ${r.dmg} 傷害、擊殺 ${r.kills} 隻殭屍；${res}`;
  }

  /** 協防隊回家的報告 */
  report(exp) {
    const g = this.game;
    const t = exp.assistTarget || {};
    const members = exp.memberIds.map((id) => g.survivors.get(id)).filter(Boolean);
    const r = this.myResult(this.player(t.playerId));
    // 協防的經驗：每擊殺 1 隻 4 點，平分給隊員
    const xp = r ? r.kills * 4 : 0;
    if (xp) members.forEach((m) => g.survivors.gainXp(m, xp / members.length));
    return {
      id: uid('rp'), poiName: `🛡️ 協防「${t.name || '友好玩家'}」`, poiType: 'residential', at: exp.endAt,
      events: [...(exp.travelEvents || []), r ? this.resultText(t.name || '友好玩家', r) : '🛡️ 在友好玩家的據點協助抵禦屍潮（對方尚未回報戰果）', '🏠 協防結束，回到避難所'],
      resources: {}, items: [], blueprints: [], kills: (exp.travelKills || 0) + (r?.kills || 0), xp: (exp.travelXp || 0) + xp, success: true,
      members: members.map((m) => m.name),
    };
  }

  /** 每秒：友好玩家屍潮／被攻打通知、有人來協防的通知 */
  update(now = Date.now()) {
    const g = this.game;
    if (g.state.assist) delete g.state.assist; // 舊版協防資料
    const night = g.time.nightKey(now);
    this.friendSieges().forEach(({ player, base }) => {
      const key = `${player.id}|${night}`;
      if (this.notified.has(key)) return;
      this.notified.set(key, true);
      const cover = this.covers(base) ? '，你的防禦範圍涵蓋那裡，防禦設施會自動協助' : '';
      g.toast(`🧟 友好玩家「${player.name}」的據點正遭到屍潮攻擊，可以派隊協防${cover}`, 'danger');
      g.log(`🧟 友好玩家「${player.name}」的「${base.name}」正遭到屍潮攻擊（第 ${base.siege.wave}/${base.siege.maxWaves} 波）${cover}`, 'danger');
    });
    this.friendRaids(now).forEach(({ player, base, raid }) => {
      const key = `raid|${player.id}|${raid.by}|${Math.round(raid.at / 60000)}`;
      if (this.notified.has(key)) return;
      this.notified.set(key, true);
      const min = Math.max(1, Math.round((raid.at - now) / 60000));
      g.toast(`⚔️ ${raid.by}正前往攻打友好玩家「${player.name}」的「${base.name}」（約 ${min} 分鐘後抵達）`, 'danger');
      g.log(`⚔️ ${raid.by}正前往攻打友好玩家「${player.name}」的「${base.name}」（約 ${min} 分鐘後抵達）`, 'danger');
    });
    // 協防戰報：對方的屍潮結束（守住或被突破）時通知一次
    (g.world?.others || []).forEach((p) => {
      if (g.territory.relation(p.id) !== 'friend') return;
      const r = this.myResult(p);
      if (!r || r.result === 'ongoing') return;
      const key = `done|${p.id}|${r.night}`;
      if (this.notified.has(key) || (g.state.assistSeen || []).includes(key)) return;
      this.notified.set(key, true);
      g.state.assistSeen = [key, ...(g.state.assistSeen || [])].slice(0, 20);
      const text = this.resultText(p.name, r);
      g.log(text, r.result === 'ok' ? 'success' : 'danger');
      g.toast(text, r.result === 'ok' ? 'success' : 'danger');
    });
    if (!g.siege.of()?.active()) return;
    this.incoming(now).forEach((h) => {
      const key = `${h.id}|${night}`;
      if (this.helpersSeen.has(key)) return;
      this.helpersSeen.add(key);
      const text = h.kind === 'team' ? `🛡️ 友好玩家「${h.name}」派了 ${h.count} 人前來協防` : `🛡️ 友好玩家「${h.name}」的防禦設施正在協助抵禦屍潮`;
      g.toast(text, 'success');
      g.log(text, 'success');
    });
  }
}
