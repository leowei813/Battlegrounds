import { xpToNext } from '../config/survivors.js';
import { haversine, uid } from '../utils/math.js';
import { tripProgress } from './ExplorationSystem.js';

/** 協防火力上限（每秒傷害，防止竄改的公開資料） */
export const MAX_ASSIST_DPS = 3000;
/** 協防隊趕路較快：步行時間倍率 */
export const ASSIST_TRAVEL_MUL = 0.5;
/** 防禦範圍涵蓋友好據點時，防禦設施分出多少火力幫忙 */
export const COVER_DPS_SHARE = 0.5;
/** 協防隊員的火力倍率：比照自己據點的防禦駐守（0.6） */
export const ASSIST_ATK_MUL = 0.6;
/** 白天協防（防守 NPC／玩家攻打）的留守時間 */
export const ASSIST_DAY_STAY_MS = 60 * 60 * 1000;
/** 公開的協防隊員戰鬥數值上限（防止竄改） */
const UNIT_CAP = { hp: 500000, atk: 100000, def: 50000 };
/** 戰鬥會用到的技能效果（公開給其他玩家計算戰鬥） */
const SKILL_KEYS = ['cleaveChance', 'rage', 'firstStrikeCrit', 'healEvery', 'healPct'];
const SKILL_CAP = { cleaveChance: 1, rage: 3, firstStrikeCrit: 1, healEvery: 60, healPct: 1 };
const clampNum = (v, min, max, d = min) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);

/** 協防隊回家後多久內收到的戰果還會補進協防報告 */
const PATCH_KEEP_MS = 12 * 3600000;
/** 協防隊在對方守住屍潮時獲得的守城經驗：每人升級所需經驗的 2%（據點駐守人員為 5%） */
export const ASSIST_GUARD_XP_PCT = 0.02;

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
    if (dps <= 0) return null;
    const r = this.coverRadius(b);
    // v15.3.1：涵蓋到的好友（玩家攻打好友時，攻擊方據此算進協防火力）
    const to = (g.world?.others || []).filter((p) => g.territory.relation(p.id) === 'friend').filter((p) => {
      const h = p.bases?.find((x) => x.primary) || p.bases?.[0];
      return h && haversine(h.lat, h.lon, b.lat, b.lon) <= r;
    }).map((p) => String(p.id)).slice(0, 20);
    return { r, dps: Math.min(MAX_ASSIST_DPS, dps), ...(to.length ? { to } : {}) };
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
    const raids = (base?.raids || []).some((r) => r.at > Date.now());
    if (!g.time.siegeTime() && !raids) return { ok: false, reason: '對方目前沒有危險：屍潮（22:00～06:00），或有 NPC／玩家正前來攻打時才能派隊協防' };
    if (this.trips().some((e) => e.assistTarget?.playerId === playerId)) return { ok: false, reason: '已經有隊伍在協防對方' };
    return { ok: true, player: p, base };
  }

  /** 派隊伍前往友好玩家的據點協防到天亮 */
  start(playerId, memberIds, { vehicleIds = [] } = {}) {
    // 協防隊一律繞開敵對（NPC、敵對玩家）的警戒範圍，避免半路被擊退而到不了
    const g = this.game;
    const c = this.canAssist(playerId);
    if (!c.ok) return c;
    const id = `assist:${playerId}`;
    const target = { playerId, name: c.player.name, baseName: c.base.name, lat: c.base.lat, lon: c.base.lon };
    this.cache.set(id, target);
    const now = Date.now();
    const st = g.exploration.start(id, memberIds, 0, false, now, { kind: 'assist', vehicleIds, avoidHostile: true });
    if (!st.ok) return st;
    const exp = st.exp;
    exp.assistTarget = target;
    // 抵達後留守：夜晚到天亮；白天（防守 NPC／玩家攻打）留守 1 小時
    const until = g.time.siegeTime(now) ? g.time.nextDawn(now) : now + exp.travelMs + ASSIST_DAY_STAY_MS;
    exp.searchMs = Math.max(60000, until - (now + exp.travelMs));
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
    // 隊員的戰鬥數值：對方遭到 NPC 或玩家攻打時，協防隊員一起上場防守
    const units = exp.memberIds.map((id, i) => {
      const sv = this.game.survivors.get(id);
      if (!sv || sv.severe) return null;
      return AssistSystem.unitData(this.game, sv, i);
    }).filter(Boolean);
    return {
      to: exp.assistTarget.playerId, dps: t.dps, count: t.count, at: exp.startAt + exp.travelMs, until: exp.startAt + exp.travelMs + exp.searchMs, units, tripId: exp.id,
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
      if (myId && p.assist?.to === myId && p.assist.until > now && (p.assist.at || 0) <= now) {
        out.push({ id: p.id, name: p.name, dps: p.assist.dps, count: p.assist.count, kind: 'team', units: p.assist.units || [], tripId: p.assist.tripId });
      }
      const home = p.bases.find((b) => b.primary) || p.bases[0];
      if (p.cover && home && haversine(home.lat, home.lon, primary.lat, primary.lon) <= p.cover.r) {
        out.push({ id: `${p.id}#cover`, name: p.name, dps: p.cover.dps, count: 0, kind: 'cover' });
      }
    });
    return out;
  }

  // ================= 協防 NPC／玩家攻打 =================

  /**
   * 倖存者的公開戰鬥數值（集結、協防、駐守共用）：含技能、吸血；withMeds 時帶藥品欄（集結結算時扣除用掉的藥品）
   */
  static unitData(game, sv, i, { withMeds = false } = {}) {
    const s = game.survivors.stats(sv);
    const sk = s.skills || {};
    const skills = Object.fromEntries(SKILL_KEYS.filter((k) => Number.isFinite(sk[k]) && sk[k]).map((k) => [k, +(+sk[k]).toFixed(3)]));
    const lo = withMeds ? game.survivors.loadout(sv) : null;
    return {
      i, name: sv.name, lv: sv.level, hp: Math.round(game.survivors.hpOf(sv)), maxHp: Math.round(s.hp), atk: Math.round(s.atk), def: Math.round(s.def),
      crit: +s.crit.toFixed(3), critDmg: +s.critDmg.toFixed(2), dodge: +s.dodge.toFixed(3), atkSpeed: +s.atkSpeed.toFixed(2),
      ...(Object.keys(skills).length ? { skills } : {}),
      ...(s.lifeSteal ? { ls: +Math.min(0.5, s.lifeSteal).toFixed(3) } : {}),
      ...(lo?.med?.qty > 0 ? { meds: { key: lo.med.key, qty: Math.min(99, lo.med.qty), heal: Math.round(game.survivors.healAmount(sv, lo.med.key)) } } : {}),
    };
  }

  /** 協防隊員轉成戰鬥單位（side 由戰鬥決定）；ally 標記來源 */
  static unitOf(h, u) {
    const maxHp = clampNum(u.maxHp, 1, UNIT_CAP.hp, 100);
    return {
      id: `ally:${h.id}:${u.i}`, ally: { player: h.id, i: u.i }, name: `${String(u.name || '協防隊員').slice(0, 12)}（${String(h.name).slice(0, 8)}）`,
      maxHp, hp: clampNum(u.hp, 1, maxHp, maxHp), atk: clampNum(u.atk, 1, UNIT_CAP.atk, 10), def: clampNum(u.def, 0, UNIT_CAP.def, 0),
      crit: clampNum(u.crit, 0, 0.8, 0.05), critDmg: clampNum(u.critDmg, 1, 4, 1.5), dodge: clampNum(u.dodge, 0, 0.6, 0.02), atkSpeed: clampNum(u.atkSpeed, 0.2, 4, 1),
      level: clampNum(u.lv, 1, 60, 1), xp: 0, coins: 0, partsChance: 0, icon: '🛡️',
      // 技能、吸血、藥品欄（v10.13.1：與自己出戰時相同）
      skills: Object.fromEntries(SKILL_KEYS.filter((k) => Number.isFinite(u.skills?.[k])).map((k) => [k, clampNum(u.skills[k], 0, SKILL_CAP[k] ?? 1, 0)])),
      lifeSteal: clampNum(u.ls, 0, 0.5, 0),
      meds: u.meds && Number.isFinite(u.meds.qty) && u.meds.qty > 0 ? { key: String(u.meds.key || '').slice(0, 20), qty: clampNum(u.meds.qty, 0, 99, 0), heal: clampNum(u.meds.heal, 0, UNIT_CAP.hp, 0) } : null,
    };
  }

  /** 來協防自己（被攻打方）的隊員戰鬥單位 */
  allyUnits() {
    return this.incoming().filter((h) => h.kind === 'team').flatMap((h) => (h.units || []).slice(0, 6).map((u) => AssistSystem.unitOf(h, u)));
  }

  /** 攻打其他玩家時：正在協防對方的友好玩家隊員（攻擊方看到的守軍） */
  defendersOf(playerId, now = Date.now()) {
    return (this.game.world?.others || []).filter((p) => p.assist?.to === playerId && p.assist.until > now && (p.assist.at || 0) <= now)
      .flatMap((p) => (p.assist.units || []).slice(0, 6).map((u) => AssistSystem.unitOf({ id: p.id, name: p.name }, u)));
  }

  /**
   * 整理一場防守戰中協防隊員的結果：{ 玩家ID: { name, kills, units: [{ i, hp, down }] } }
   * @param {object[]} units 戰鬥結果中屬於協防隊員的單位（含 ally、hp、down、kills）
   */
  static summarize(units, names = {}) {
    const out = {};
    units.filter((u) => u.ally).forEach((u) => {
      const k = u.ally.player;
      const e = out[k] || (out[k] = { name: names[k] || '', kills: 0, units: [] });
      e.kills += u.kills || 0;
      e.units.push({ i: u.ally.i, hp: Math.max(0, Math.round(u.hp)), down: !!u.down });
    });
    return out;
  }

  /** 被協防方：好友協防隊抵達、離開時各記一筆事件（離開時附上這次的戰果） */
  trackArrivals(now = Date.now()) {
    const g = this.game;
    const here = Object.fromEntries(this.incoming(now).filter((h) => h.kind === 'team').map((h) => [h.id, h]));
    const seen = g.state.assistHere || (g.state.assistHere = {});
    Object.values(here).forEach((h) => {
      if (seen[h.id]) return;
      seen[h.id] = { name: h.name, at: now };
      // 屍潮期間另有「派了 N 人前來協防」的紀錄，不重複
      if (g.siege.of()?.active?.()) return;
      g.log(`🛡️ 好友「${h.name}」前來協防（${h.count || (h.units || []).length || 1} 人）`, 'success');
    });
    Object.entries(seen).forEach(([id, x]) => {
      if (here[id]) return;
      delete seen[id];
      const rec = g.shelter.primary()?.assistLog?.list?.[id];
      const stat = rec && (rec.dmg || rec.kills) ? `（傷害 ${Math.round(rec.dmg).toLocaleString()}、擊殺 ${rec.kills}）` : '';
      g.log(`🛡️ 好友「${x.name}」的協防隊離開${stat}`, 'info');
    });
  }

  /** 取走剛記錄的協防清單（寫進防守紀錄用） */
  takePending() {
    const list = this.pendingAssists || [];
    this.pendingAssists = null;
    return list;
  }

  /** 被攻打方：記錄這場防守戰的協防結果（公開給協防的人，對方據此套用傷勢與收到戰報） */
  recordRaid(base, attacker, success, helpers) {
    if (!base || !helpers || !Object.keys(helpers).length) return '';
    base.raidAssist = { id: uid('ra'), at: Date.now(), attacker: String(attacker).slice(0, 40), result: success ? 'ok' : 'breached', list: helpers };
    // 據點紀錄用標籤顯示（緊接著寫入的防守紀錄會取走這份清單）
    this.pendingAssists = Object.values(helpers).map((x) => ({ name: x.name, kills: x.kills || 0, down: (x.units || []).filter((u) => u.down).length }));
    return '';
  }

  /** 協防的一方：讀取對方公開的防守戰結果，套用自己隊員的傷勢並收到戰報 */
  checkRaidResults() {
    const g = this.game;
    const myId = g.world?.myId;
    if (!myId) return;
    (g.world?.others || []).forEach((p) => {
      if (g.territory.relation(p.id) !== 'friend') return;
      p.bases.forEach((b) => {
        const ra = b.raidAssist;
        const mine = ra?.list?.[myId];
        if (!mine) return;
        const key = `raid|${ra.id}`;
        if ((g.state.assistSeen || []).includes(key)) return;
        g.state.assistSeen = [key, ...(g.state.assistSeen || [])].slice(0, 30);
        const exp = g.state.expeditions.find((e) => e.kind === 'assist' && e.assistTarget?.playerId === p.id);
        const hurt = [];
        (mine.units || []).forEach((u) => {
          const sv = exp && g.survivors.get(exp.memberIds[u.i]);
          if (!sv) return;
          if (u.down) {
            g.survivors.battleDown(sv, '在協防中', Date.now());
            hurt.push(sv.name);
          } else if (Number.isFinite(u.hp)) g.survivors.setHp(sv, Math.min(g.survivors.hpOf(sv), u.hp));
        });
        if (exp) exp.travelEvents = [...(exp.travelEvents || []), `🛡️ 協防「${p.name}」抵禦${ra.attacker}：擊倒 ${mine.kills} 人${hurt.length ? `，${hurt.join('、')} 重傷` : ''}`];
        const text = `🛡️ 協防「${p.name}」戰報：抵禦${ra.attacker}的攻打，你的協防隊擊倒 ${mine.kills} 人${hurt.length ? `，${hurt.join('、')} 重傷` : ''}；${ra.result === 'ok' ? '✅ 成功守住' : '💥 對方據點還是被攻破了'}`;
        if (!exp) this.patchReport(p.id, text, mine.kills || 0);
        g.log(text, ra.result === 'ok' ? 'success' : 'danger');
        g.toast(text, ra.result === 'ok' ? 'success' : 'danger');
      });
    });
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
    // 對方守住屍潮：協防隊員另外獲得守城經驗（同一晚只給一次）
    const guard = this.grantGuardXp(t.playerId, r, members);
    // 召回的協防隊也照樣顯示協防戰果；對方還沒回報時先註明，之後收到戰果會補進這份報告
    const pending = !r && !(exp.travelEvents || []).some((t2) => t2.startsWith('🛡️ 協防「'));
    return {
      id: uid('rp'), poiName: `🛡️ 協防「${t.name || '友好玩家'}」`, poiType: 'residential', at: exp.endAt,
      events: [...(exp.travelEvents || []), r ? this.resultText(t.name || '友好玩家', r) : pending ? '🛡️ 對方尚未回報戰果（對方上線結算後會自動補上）' : null, '🏠 協防結束，回到避難所'].filter(Boolean),
      resources: {}, items: [], blueprints: [], kills: (exp.travelKills || 0) + (r?.kills || 0), xp: (exp.travelXp || 0) + xp + guard.total, success: true,
      members: members.map((m) => m.name),
      assistPlayerId: t.playerId || null, assistPending: pending, assistMemberIds: [...exp.memberIds],
    };
  }

  /**
   * 協防隊已經回家後才收到的戰果：補進最近一份給這位玩家的協防報告。
   * 同一趟協防可能同時有屍潮與 NPC／玩家攻打，每一種戰果都會補上（同一段文字不重複）。
   */
  /**
   * 協防的守城經驗：對方守住屍潮、自己有派協防隊時，每位隊員獲得升級所需經驗的 ASSIST_GUARD_XP_PCT。
   * 同一位玩家的同一晚只給一次（協防隊回家、或回家後才收到戰果，哪個先發生就在哪裡給）。
   * @returns {{total:number, list:{n:string, d:number}[]}}
   */
  grantGuardXp(playerId, r, members) {
    const g = this.game;
    const none = { total: 0, list: [] };
    if (!playerId || !r || r.result !== 'ok' || !r.team || !members.length) return none;
    const key = `gxp|${playerId}|${r.night}`;
    g.state.assistXpSeen = g.state.assistXpSeen || [];
    if (g.state.assistXpSeen.includes(key)) return none;
    g.state.assistXpSeen = [key, ...g.state.assistXpSeen].slice(0, 20);
    const list = members.map((m) => {
      const d = Math.round(xpToNext(m.level) * ASSIST_GUARD_XP_PCT);
      g.survivors.gainXp(m, d);
      return { n: m.name, d };
    });
    g.log(`🎖️ 協防守住屍潮：${list.map((x) => `${x.n} +${x.d}`).join('、')} 守城經驗`, 'success');
    return { total: list.reduce((a, x) => a + x.d, 0), list };
  }

  patchReport(playerId, text, kills = 0, r = null) {
    const now = Date.now();
    const rep = (this.game.state.reports || []).find((rp) => rp.assistPlayerId === playerId && (rp.assistPending || now - (rp.at || 0) < PATCH_KEEP_MS));
    if (!rep || rep.events.includes(text)) return false;
    // 回家後才收到「守住」的戰果：補發守城經驗並記到報告的經驗明細
    const members = (rep.assistMemberIds || []).map((id) => this.game.survivors.get(id)).filter(Boolean);
    const guard = this.grantGuardXp(playerId, r, members);
    if (guard.total) {
      const by = rep.xpBy ? rep.xpBy.map((x) => ({ ...x })) : [];
      guard.list.forEach((x) => { const o = by.find((y) => y.n === x.n); if (o) o.d += x.d; else by.push({ ...x }); });
      rep.xpBy = by;
      rep.xp = (rep.xp || 0) + guard.total;
    }
    rep.assistPending = false;
    const i = rep.events.findIndex((e) => e.startsWith('🛡️ 對方尚未回報戰果'));
    if (i >= 0) rep.events.splice(i, 1, text);
    else rep.events.splice(Math.max(0, rep.events.length - 1), 0, text);
    rep.kills = (rep.kills || 0) + kills;
    this.game.bus.emit('reports:changed');
    return true;
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
      const cover = this.covers(base) ? '，你的防禦範圍涵蓋那裡，防禦設施會自動額外協助（自己的火力不會減少）' : '';
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
    this.checkRaidResults();
    this.trackArrivals(now);
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
      // 協防隊已經回到避難所：把戰果補進那份協防報告
      if (!g.state.expeditions.some((e) => e.kind === 'assist' && e.assistTarget?.playerId === p.id)) this.patchReport(p.id, text, r.kills || 0, r);
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
