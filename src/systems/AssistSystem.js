import { haversine } from '../utils/math.js';

/** 協防火力上限（每秒傷害，防止竄改的公開資料） */
export const MAX_ASSIST_DPS = 3000;

/**
 * 友好玩家的屍潮協防：
 *  - 主要據點正在被屍潮攻擊時，公開資料會附上屍潮狀況（波次、剩餘殭屍、圍牆耐久），友好玩家可以即時看到。
 *  - 自己主要據點的警戒範圍與友好玩家據點的警戒範圍相接（重疊）時，可以派「防禦駐守」的倖存者前往協防到天亮。
 *  - 協防的人透過公開資料告知對方火力；對方的屍潮模擬每秒對殭屍造成這些傷害。協防期間自己據點少了這些駐守火力。
 */
export class AssistSystem {
  constructor(game) {
    this.game = game;
    this.notified = new Map(); // 友好玩家屍潮通知（每晚一次）
    this.helpersSeen = new Set();
  }

  get state() {
    return this.game.state.assist || null;
  }

  /** 正在協防中的倖存者 ID */
  assistingIds(now = Date.now()) {
    const a = this.state;
    if (!a || a.until <= now) return new Set();
    return new Set(a.ids || []);
  }

  /** 可以派去協防的人：防禦駐守、待命、沒有重傷、沒有在前哨站駐守 */
  candidates() {
    const g = this.game;
    return g.state.survivors.filter((s) => s.job === 'guard' && g.survivors.isAvailable(s));
  }

  /** 正在協防的人（中途被派出探索、受重傷就不算） */
  helpers(now = Date.now()) {
    const ids = this.assistingIds(now);
    return this.candidates().filter((s) => ids.has(s.id));
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

  /** 兩個據點的警戒範圍是否相接 */
  inRange(myBase, other) {
    if (!myBase || !other) return false;
    const d = haversine(myBase.lat, myBase.lon, other.lat, other.lon);
    return d <= this.game.territory.alertRadius(myBase) + (other.alert || 0);
  }

  canAssist(playerId) {
    const g = this.game;
    const p = (g.world?.others || []).find((x) => x.id === playerId);
    if (!p) return { ok: false, reason: '找不到這位玩家（可能已離線）' };
    if (g.territory.relation(playerId) !== 'friend') return { ok: false, reason: '只能協防友好玩家' };
    const base = p.bases.find((b) => b.primary) || p.bases[0];
    if (!base?.siege) return { ok: false, reason: '對方目前沒有遭到屍潮攻擊' };
    if (!this.inRange(g.shelter.primary(), base)) return { ok: false, reason: '你的避難所警戒範圍要和對方據點的警戒範圍相接才能協防' };
    const a = this.state;
    if (a && a.until > Date.now() && a.playerId !== playerId) return { ok: false, reason: `已經在協防「${a.name}」` };
    if (!this.candidates().length) return { ok: false, reason: '沒有可以出動的「防禦駐守」倖存者' };
    return { ok: true, player: p, base };
  }

  /** 派防禦駐守的倖存者前往協防到天亮 */
  start(playerId) {
    const g = this.game;
    const c = this.canAssist(playerId);
    if (!c.ok) return c;
    const ids = this.candidates().map((s) => s.id);
    g.state.assist = { playerId, name: c.player.name, until: g.time.nextDawn(), ids };
    g.log(`🛡️ 派出 ${ids.length} 名防禦駐守前往協防「${c.player.name}」（到天亮）`, 'info');
    g.world?.syncSoon?.();
    return { ok: true, msg: `${ids.length} 名防禦駐守前往協防「${c.player.name}」` };
  }

  stop() {
    const g = this.game;
    if (!this.state) return { ok: false, reason: '目前沒有在協防' };
    const name = this.state.name;
    delete g.state.assist;
    g.world?.syncSoon?.();
    return { ok: true, msg: `協防「${name}」的倖存者已經回到崗位` };
  }

  /** 協防的公開火力 */
  published(now = Date.now()) {
    const a = this.state;
    if (!a || a.until <= now) return null;
    const list = this.helpers(now);
    if (!list.length) return null;
    const siege = this.game.siege.of();
    const dps = list.reduce((s, sv) => s + siege.meleeOrRangedAtk(sv) * 0.6 * siege.guardMul(), 0);
    return { to: a.playerId, dps: Math.min(MAX_ASSIST_DPS, Math.round(dps)), count: list.length, until: a.until };
  }

  /**
   * 前來協防自己主要據點的友好玩家（對方的避難所警戒範圍要和自己相接）。
   * @returns {{name:string, dps:number, count:number}[]}
   */
  incoming(now = Date.now()) {
    const g = this.game;
    const myId = g.world?.myId;
    const primary = g.shelter.primary();
    if (!myId || !primary) return [];
    return (g.world?.others || []).filter((p) => p.assist?.to === myId && p.assist.until > now
      && g.territory.relation(p.id) === 'friend'
      && this.inRange(primary, p.bases.find((b) => b.primary) || p.bases[0]))
      .map((p) => ({ id: p.id, name: p.name, dps: p.assist.dps, count: p.assist.count }));
  }

  /** 每秒：協防結束、友好玩家屍潮通知、有人來協防的通知 */
  update(now = Date.now()) {
    const g = this.game;
    const a = this.state;
    if (a && a.until <= now) {
      g.log(`🌅 天亮了，協防「${a.name}」的倖存者回到崗位`, 'info');
      delete g.state.assist;
    }
    const night = g.time.nightKey(now);
    this.friendSieges().forEach(({ player, base }) => {
      const key = `${player.id}|${night}`;
      if (this.notified.has(key)) return;
      this.notified.set(key, true);
      const near = this.inRange(g.shelter.primary(), base);
      g.toast(`🧟 友好玩家「${player.name}」的據點正遭到屍潮攻擊${near ? '，可以派人協防' : ''}`, 'danger');
      g.log(`🧟 友好玩家「${player.name}」的「${base.name}」正遭到屍潮攻擊（第 ${base.siege.wave}/${base.siege.maxWaves} 波）`, 'danger');
    });
    this.friendRaids(now).forEach(({ player, base, raid }) => {
      const key = `raid|${player.id}|${raid.by}|${Math.round(raid.at / 60000)}`;
      if (this.notified.has(key)) return;
      this.notified.set(key, true);
      const min = Math.max(1, Math.round((raid.at - now) / 60000));
      g.toast(`⚔️ ${raid.by}正前往攻打友好玩家「${player.name}」的「${base.name}」（約 ${min} 分鐘後抵達）`, 'danger');
      g.log(`⚔️ ${raid.by}正前往攻打友好玩家「${player.name}」的「${base.name}」（約 ${min} 分鐘後抵達）`, 'danger');
    });
    this.incoming(now).forEach((h) => {
      const key = `${h.id}|${night}`;
      if (this.helpersSeen.has(key)) return;
      this.helpersSeen.add(key);
      g.toast(`🛡️ 友好玩家「${h.name}」派了 ${h.count} 人前來協防`, 'success');
      g.log(`🛡️ 友好玩家「${h.name}」派了 ${h.count} 人前來協防`, 'success');
    });
  }
}
