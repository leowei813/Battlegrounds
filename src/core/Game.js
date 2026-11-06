import {
  TICK_MS, AUTOSAVE_MS, OFFLINE_CAP_MS, MAX_LOG, RESOURCE_KEYS, POI_SCAN_RADIUS, OUTPOST_SCAN_RADIUS,
} from '../config/constants.js';
import { bus, EVT } from './EventBus.js';
import { createInitialState } from './GameState.js';
import { TimeSystem } from '../systems/TimeSystem.js';
import { ResearchSystem } from '../systems/ResearchSystem.js';
import { ResourceSystem } from '../systems/ResourceSystem.js';
import { ShelterSystem } from '../systems/ShelterSystem.js';
import { EquipmentSystem } from '../systems/EquipmentSystem.js';
import { SurvivorSystem } from '../systems/SurvivorSystem.js';
import { CombatSystem } from '../systems/CombatSystem.js';
import { ExplorationSystem } from '../systems/ExplorationSystem.js';
import { ZombieSpawnSystem } from '../systems/ZombieSpawnSystem.js';
import { SiegeSystem } from '../systems/SiegeSystem.js';
import { QuestSystem } from '../systems/QuestSystem.js';
import { CivilizationSystem } from '../systems/CivilizationSystem.js';
import { VehicleSystem } from '../systems/VehicleSystem.js';
import { NpcSystem } from '../systems/NpcSystem.js';
import { TerritorySystem } from '../systems/TerritorySystem.js';
import { GpsSystem } from '../systems/GpsSystem.js';
import { grant } from '../systems/costUtils.js';
import { isSupply } from '../config/supplies.js';
import { generatePois } from '../map/WorldGen.js';
import { PoiShareSystem } from '../systems/PoiShareSystem.js';
import { AutoHomeSystem } from '../systems/AutoHomeSystem.js';
import { POI_TYPES } from '../config/poiTypes.js';
import { haversine } from '../utils/math.js';
import { POI_THIN_VERSION } from '../config/constants.js';
import { MarkerSystem } from '../systems/MarkerSystem.js';
import { InterceptSystem } from '../systems/InterceptSystem.js';
import { BlackMarketSystem } from '../systems/BlackMarketSystem.js';
import { SharedWorld } from '../multiplayer/SharedWorld.js';
import { MarketSystem } from '../systems/MarketSystem.js';
import { InfectedSystem } from '../systems/InfectedSystem.js';
import { RallySystem } from '../systems/RallySystem.js';
import { RebirthSystem } from '../systems/RebirthSystem.js';
import { AssistSystem } from '../systems/AssistSystem.js';
import { ChatSystem } from '../multiplayer/Chat.js';

/**
 * 遊戲核心（Facade）：持有狀態與所有系統，負責主迴圈、離線結算與存檔。
 * UI 與 Phaser 場景只透過此物件存取遊戲邏輯。
 */
/** 屍潮在背景分頁時最多補算的時間（秒，約一整晚）與每次補算的上限（秒） */
const SIEGE_CATCHUP_MAX = 40 * 60;
const SIEGE_CATCHUP_STEP = 120;

export class Game {
  /** @param {object} state */
  constructor(state) {
    this.state = state;
    this.bus = bus;
    this.started = false;

    this.shared = new SharedWorld(this);
    this.poiShare = new PoiShareSystem(this);
    this.autoHome = new AutoHomeSystem(this);
    this.chat = new ChatSystem(this);
    this.time = new TimeSystem(this);
    this.research = new ResearchSystem(this);
    this.resources = new ResourceSystem(this);
    this.shelter = new ShelterSystem(this);
    this.equipment = new EquipmentSystem(this);
    this.survivors = new SurvivorSystem(this);
    this.combat = new CombatSystem(this);
    this.exploration = new ExplorationSystem(this);
    this.zombies = new ZombieSpawnSystem(this);
    this.siege = new SiegeSystem(this);
    this.quests = new QuestSystem(this);
    this.civilization = new CivilizationSystem(this);
    this.vehicles = new VehicleSystem(this);
    this.npcs = new NpcSystem(this);
    this.territory = new TerritorySystem(this);
    this.gps = new GpsSystem(this);
    this.markers = new MarkerSystem(this);
    this.intercept = new InterceptSystem(this);
    this.blackMarket = new BlackMarketSystem(this);
    this.market = new MarketSystem(this);
    this.infected = new InfectedSystem(this);
    this.rally = new RallySystem(this);
    this.assist = new AssistSystem(this);
    this.rebirth = new RebirthSystem(this);

    this.lastPhase = null;
    this.timers = [];
  }

  /** 不能被移除的地點：據點、探索目的地、標記、NPC 據點 */
  protectedPoiIds() {
    return new Set([
      ...this.state.bases.map((b) => b.poiId), ...this.state.expeditions.map((e) => e.poiId),
      ...(this.state.map.markers || []).map((m) => m.id), ...(this.state.npcs?.list || []).map((n) => n.poiId),
    ]);
  }

  /**
   * 據點是否正被當成攻擊目標：NPC 掠奪隊正在前來、其他玩家的隊伍正朝據點移動（交易隊除外）、
   * 或屍潮正在攻擊據點。
   * @returns {string[]} 威脅說明（空陣列代表安全）
   */
  /**
   * 威脅明細：誰正在攻過來、預計多久抵達（地圖左上角顯示）。
   * @returns {{text:string, at:number|null, kind:string}[]}
   */
  threatDetails(now = Date.now()) {
    const out = [];
    const bases = this.state.bases;
    if (!bases.length) return out;
    (this.state.npcs?.list || []).forEach((n) => {
      const t = n.trip;
      if (t?.kind === 'raid' && !t.resolved && !t.hidden && now < t.startAt + t.travelMs && bases.some((b) => b.id === t.baseId)) {
        out.push({ text: `NPC「${n.name}」掠奪隊 → ${t.target || '據點'}`, at: t.startAt + t.travelMs, kind: 'npc' });
      }
    });
    (this.world?.others || []).forEach((p) => (p.trips || []).forEach((t) => {
      if (this.territory.relation(p.id) === 'friend') return;
      if (t.kind || t.defeated || now >= t.startAt + (t.travelMs || 0)) return;
      if (bases.some((b) => haversine(b.lat, b.lon, t.to.lat, t.to.lon) < 40)) out.push({ text: `玩家「${p.name}」的隊伍`, at: t.startAt + (t.travelMs || 0), kind: 'player' });
    }));
    bases.forEach((b) => {
      const w = this.siege.of(b.id).waveInfo?.();
      if (w?.active && w.attacking) out.push({ text: `屍潮（${b.name}）第 ${w.wave}/${w.maxWaves} 波・剩 ${w.left} 隻`, at: null, kind: 'siege' });
    });
    return out.sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  threats(now = Date.now()) {
    const out = [];
    const bases = this.state.bases;
    if (!bases.length) return out;
    (this.state.npcs?.list || []).forEach((n) => {
      const t = n.trip;
      if (t?.kind === 'raid' && !t.resolved && !t.hidden && now < t.startAt + t.travelMs && bases.some((b) => b.id === t.baseId)) out.push(`NPC「${n.name}」掠奪隊`);
    });
    (this.world?.others || []).forEach((p) => (p.trips || []).forEach((t) => {
      // 友好玩家的隊伍靠近不算威脅
      if (this.territory.relation(p.id) === 'friend') return;
      if (t.kind === 'assist' || t.defeated || now >= t.startAt + (t.travelMs || 0)) return;
      if (bases.some((b) => haversine(b.lat, b.lon, t.to.lat, t.to.lon) < 40)) out.push(`玩家「${p.name}」的隊伍`);
    }));
    bases.forEach((b) => {
      const w = this.siege.of(b.id).waveInfo?.();
      if (w?.active && w.attacking) out.push(`屍潮（${b.name}）`);
    });
    return out;
  }

  static newGame(opts) {
    return new Game(createInitialState(opts));
  }

  /**
   * 啟動主迴圈並結算離線收益。
   * @returns {object|null} 離線報告
   */
  start() {
    // 裝備戰力公式可能更新（例如計入詞條）：每次啟動重新計算
    this.equipment.items.forEach((it) => { it.power = this.equipment.itemPower(it); });
    // v10：地圖地點由固定格子產生（舊存檔的真實建築地圖在這裡換成新地圖）
    this.genMap();
    // 電磁塔、電網每個據點限 1 座：舊存檔多出的拆除並退還材料
    this.shelter.enforceDefenseLimits();
    // 標記地點已移除：清除舊存檔的標記（不再保留遠處的標記建築）
    if (this.state.map.markers?.length) this.state.map.markers = [];
    const report = this.processOffline();
    this.quests.ensureDaily();
    this.lastPhase = this.time.phaseId();
    this.started = true;
    // 重要事件發生時立即存檔
    ['expedition:done', 'shelter:changed', 'siege:breach', 'siege:wave', 'npc:raid', 'npcs:changed', 'vehicles:changed', 'recruit:board', 'relations:changed', 'trader:changed']
      .forEach((evt) => bus.on(evt, () => this.requestSave()));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.startSiegeLoop();
    this.timers.push(setInterval(() => this.save(), AUTOSAVE_MS));
    const flush = () => this.save(true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return report;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    cancelAnimationFrame(this.siegeRaf);
  }

  /**
   * 屍潮即時模擬迴圈（每幀）。獨立於畫面：不論目前在地圖或避難所頁面，
   * 所有據點都持續承受屍潮。分頁切到背景時瀏覽器會暫停 requestAnimationFrame，
   * 因此另以計時器持續推進，並依實際經過的時間補算（每次最多補 SIEGE_CATCHUP_STEP 秒，剩下的下一次繼續補）。
   */
  startSiegeLoop() {
    let last = performance.now();
    let behind = 0;
    const pump = (t = performance.now()) => {
      behind = Math.min(SIEGE_CATCHUP_MAX, behind + Math.max(0, (t - last) / 1000));
      last = t;
      const dt = Math.min(behind, SIEGE_CATCHUP_STEP);
      behind -= dt;
      if (dt > 0) this.siege.update(dt);
    };
    const loop = (t) => {
      pump(t);
      this.siegeRaf = requestAnimationFrame(loop);
    };
    this.siegeRaf = requestAnimationFrame(loop);
    // 背景分頁：計時器仍會執行（瀏覽器可能放慢到每秒或每分鐘一次），依經過時間補算
    this.timers.push(setInterval(() => { if (document.hidden) pump(); }, 1000));
    // 回到前景時立即補算
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
  }

  /** 每秒更新 */
  tick() {
    const now = Date.now();
    const dt = Math.min(now - this.state.lastTickAt, OFFLINE_CAP_MS);
    this.state.lastTickAt = now;
    // 若分頁被背景節流超過 1 分鐘，視為離線結算
    if (dt > 60000) {
      this.applyElapsed(now, dt, true);
    } else {
      this.applyElapsed(now, dt, false);
    }
    const phase = this.time.phaseId(now);
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      const p = this.time.phase(now);
      this.toast(`${p.icon} 進入${p.name}：${p.desc}`, phase === 'day' ? 'info' : 'danger');
      this.log(`${p.icon} 進入${p.name}`, 'info');
      this.zombies.refresh(now);
      bus.emit(EVT.PHASE_CHANGED, phase);
    }
    bus.emit(EVT.TICK, now);
    bus.emit(EVT.STATE_CHANGED);
  }

  applyElapsed(now, dt, silent) {
    // 分頁在背景超過 1 分鐘視同離線：食物消耗較低
    this.resources.apply(dt, { offline: silent });
    this.shelter.update(now, Math.min(dt, 5000));
    this.research.update(now);
    this.survivors.updateVitals(now, dt, this.resources.lastStarvingMs);
    this.survivors.updateBoard(now);
    this.autoHome.check(now, { silent });
    this.exploration.update(now, { silent });
    this.npcs.update(now);
    this.assist.update(now);
    this.market.update(now);
    this.shared.tick(now);
    if (!silent) this.chat.tick(now);
    this.rally.update(now);
    this.zombies.update(now);
    if (!silent) this.exploration.checkAmbush(now);
    this.quests.update();
  }

  /** 離線結算：資源、施工、研究、探索（含自動探索）、離線防守 */
  processOffline() {
    const now = Date.now();
    const elapsed = Math.min(Math.max(0, now - this.state.lastTickAt), OFFLINE_CAP_MS);
    if (elapsed < 60000) {
      this.state.lastTickAt = now;
      return null;
    }
    const before = { ...this.state.resources, coins: this.state.player.coins, parts: this.state.player.parts };
    const killsBefore = this.state.stats.kills;
    const survivorsBefore = this.state.survivors.length;
    // 離線期間完成的研究與建造（回到遊戲時列出）
    const levelsBefore = { ...this.state.research.levels };
    const logBefore = this.state.log.length ? this.state.log[0] : null;
    this.resources.apply(elapsed, { offline: true });
    this.shelter.update(now, elapsed);
    this.research.update(now);
    this.survivors.updateVitals(now, elapsed, this.resources.lastStarvingMs);
    // 離線期間跨過 19:00：照 19:00 當下的狀態自動回家
    this.autoHome.check(now, { silent: true });
    const reports = this.exploration.update(now, { silent: true });
    this.npcs.update(now);
    const defense = this.siege.simulateOffline(elapsed);
    this.state.map.lastZombieRefresh = 0;
    this.zombies.update(now);
    this.state.lastTickAt = now;

    const gains = {};
    [...RESOURCE_KEYS, 'coins', 'parts'].forEach((k) => {
      const after = k in this.state.resources ? this.state.resources[k] : this.state.player[k];
      gains[k] = Math.floor(after - before[k]);
    });
    const newLogs = [];
    for (const l of this.state.log) {
      if (l === logBefore) break;
      newLogs.push(l);
    }
    const done = {
      research: Object.entries(this.state.research.levels).filter(([id, lv]) => lv > (levelsBefore[id] || 0))
        .map(([id, lv]) => ({ id, from: levelsBefore[id] || 0, to: lv })),
      builds: newLogs.filter((l) => l.msg.startsWith('🏗️') && l.msg.includes('升到')).map((l) => l.msg.replace(/^🏗️\s*/, '')).reverse(),
    };
    this.log(`🌙 離線 ${Math.round(elapsed / 60000)} 分鐘，收益已結算`, 'info');
    return {
      done, labIdle: this.research.labLevel() > 0 && !this.state.research.active,
      elapsed, gains, expeditions: reports.length, defense, kills: this.state.stats.kills - killsBefore,
      capped: now - this.state.lastSaveAt > OFFLINE_CAP_MS,
      starving: !!this.state.starving,
      deaths: survivorsBefore - this.state.survivors.length,
    };
  }

  /**
   * 取得附近建築（OSM → 失敗則程序化）
   * @param {(done:number,total:number)=>void} [onProgress] 分區查詢進度
   */
  /**
   * 掃描範圍：避難所（或起始點）周圍 POI_SCAN_RADIUS，每座前哨站周圍 OUTPOST_SCAN_RADIUS（較小）。
   * @returns {{lat:number, lon:number, radius:number}[]}
   */
  scanAreas(lat, lon) {
    return [
      { lat, lon, radius: POI_SCAN_RADIUS },
      ...this.shelter.outposts().map((b) => ({ lat: b.lat, lon: b.lon, radius: OUTPOST_SCAN_RADIUS })),
    ];
  }

  /**
   * v10：依固定格子產生地圖地點（避難所＋前哨站周圍，所有玩家相同；不需要網路）。
   * 保留每個地點的搜刮紀錄，以及據點、探索目的地、佇列與 NPC 所在的地點（即使不在範圍內）。
   * @returns {boolean} 地點清單是否有變動
   */
  genMap(lat = null, lon = null) {
    const map = this.state.map;
    const c = this.shelter.primary() || (lat != null ? { lat, lon } : map.center);
    if (!c) return false;
    const old = new Map((map.pois || []).map((p) => [p.id, p]));
    const seen = new Set();
    const pois = [];
    this.scanAreas(c.lat, c.lon).forEach((a) => generatePois(a.lat, a.lon, a.radius).forEach((p) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      const o = old.get(p.id);
      if (o) ['lootedDay', 'lootedBy', 'lastVisit', 'depletion'].forEach((k) => { if (o[k] != null) p[k] = o[k]; });
      pois.push(p);
    }));
    // 據點、探索目的地與佇列、NPC 據點所在的舊地點：不在範圍內也保留，避免消失
    const keep = new Set([...this.protectedPoiIds(), ...this.state.expeditions.flatMap((e) => e.queue || [])]);
    keep.forEach((id) => {
      const p = old.get(id);
      if (p && !seen.has(id)) { pois.push(p); seen.add(id); }
    });
    // 麵包店已移除：舊存檔保留下來的麵包店改為商店
    pois.forEach((p) => { if (POI_TYPES[p.type]?.removed) p.type = 'shop'; });
    const changed = pois.length !== (map.pois || []).length || pois.some((p) => !old.has(p.id));
    this.markers.ensure(pois);
    map.pois = pois;
    map.source = 'generated';
    if (!map.center || lat != null) map.center = { lat: c.lat, lon: c.lon };
    map.thinV = POI_THIN_VERSION;
    if (changed) map.fetchedAt = Date.now(); // 建築清單變更，雲端另存的建築清單會重新上傳
    return changed;
  }

  /** 舊的地圖掃描入口：改為直接產生地圖（保留介面給舊呼叫端） */
  async scanMap(lat, lon) {
    this.genMap(lat, lon);
    this.zombies.update(Date.now());
    bus.emit(EVT.MAP_CHANGED);
    return { count: this.state.map.pois.length, source: 'generated' };
  }

  /** 給予資源/貨幣（自動套用倉庫上限） */
  grant(gains, ignoreCap = false) {
    const sup = {};
    const rest = {};
    Object.entries(gains || {}).forEach(([k, v]) => { (isSupply(k) ? sup : rest)[k] = v; });
    const out = grant(this.state, rest, ignoreCap ? Infinity : this.resources.storageCap());
    return { ...out, ...this.equipment.addSupplies(sup) };
  }

  log(msg, type = 'info') {
    const entry = { t: Date.now(), msg, type };
    // 不屬於任何探索或防守的戰鬥（例如駐守人員攔截路過的隊伍）：附在緊接著的事件紀錄上
    if (this.combat?.pendingBattle) {
      entry.battleId = this.combat.pendingBattle;
      this.combat.pendingBattle = null;
    }
    this.state.log.unshift(entry);
    if (this.state.log.length > MAX_LOG) this.state.log.length = MAX_LOG;
    bus.emit(EVT.LOG);
    this.requestSave();
  }

  /**
   * 發生任何事件（玩家操作、遊戲事件、記錄）時立即存檔。
   * 同一輪事件迴圈內的多次要求合併成一次，雲端上傳也會合併進行中的請求。
   */
  requestSave() {
    if (this.saveQueued || !this.started) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      this.save();
    });
  }

  toast(msg, type = 'info') {
    bus.emit(EVT.TOAST, { msg, type });
  }

  /** 玩家操作後呼叫：立即通知 UI 更新 */
  changed() {
    bus.emit(EVT.STATE_CHANGED);
    this.requestSave();
  }

  /**
   * 存檔＝上傳到雲端帳號（由 CloudSync 監聽 SAVE 事件，自動節流）。
   * @param {boolean} final 是否為離開頁面/切到背景前的最後一次存檔（會立即上傳）
   */
  save(final = false) {
    // 重置流程中、或存檔已被其他裝置接手時，避免把舊狀態寫回
    if (this.resetting || this.locked) return false;
    this.state.lastSaveAt = Date.now();
    bus.emit(EVT.SAVE, { final });
    return true;
  }
}
