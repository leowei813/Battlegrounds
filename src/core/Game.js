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
import { fetchPois, thinPois } from '../map/OverpassService.js';
import { haversine } from '../utils/math.js';
import { POI_THIN_VERSION } from '../config/constants.js';
import { fillPois } from '../map/PoiGenerator.js';
import { MarkerSystem } from '../systems/MarkerSystem.js';
import { InterceptSystem } from '../systems/InterceptSystem.js';
import { TraderSystem } from '../systems/TraderSystem.js';
import { TradeSystem } from '../systems/TradeSystem.js';
import { DemandSystem } from '../systems/DemandSystem.js';
import { AssistSystem } from '../systems/AssistSystem.js';

/**
 * 遊戲核心（Facade）：持有狀態與所有系統，負責主迴圈、離線結算與存檔。
 * UI 與 Phaser 場景只透過此物件存取遊戲邏輯。
 */
export class Game {
  /** @param {object} state */
  constructor(state) {
    this.state = state;
    this.bus = bus;
    this.started = false;

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
    this.trader = new TraderSystem(this);
    this.trade = new TradeSystem(this);
    this.demand = new DemandSystem(this);
    this.assist = new AssistSystem(this);

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

  /** 舊地圖：依目前的密度規則整理一次（太密集的區域減少地點，並補足樹林、藥局） */
  thinMap() {
    const map = this.state.map;
    if (!map.pois?.length || map.thinV === POI_THIN_VERSION) return;
    const c = this.shelter.primary() || map.center;
    if (!c) return;
    const before = map.pois.length;
    map.pois = fillPois(thinPois(map.pois, c.lat, this.protectedPoiIds()), c.lat, c.lon);
    map.thinV = POI_THIN_VERSION;
    map.fetchedAt = Date.now(); // 觸發地圖重新上傳
    console.info(`[Game] 地圖密度整理：${before} → ${map.pois.length}`);
  }

  /**
   * 據點是否正被當成攻擊目標：NPC 掠奪隊正在前來、其他玩家的隊伍正朝據點移動（交易隊除外）、
   * 或屍潮正在攻擊據點。
   * @returns {string[]} 威脅說明（空陣列代表安全）
   */
  threats(now = Date.now()) {
    const out = [];
    const bases = this.state.bases;
    if (!bases.length) return out;
    (this.state.npcs?.list || []).forEach((n) => {
      const t = n.trip;
      if (t?.kind === 'raid' && !t.resolved && !t.hidden && now < t.startAt + t.travelMs && bases.some((b) => b.id === t.baseId)) out.push(`NPC「${n.name}」掠奪隊`);
    });
    (this.world?.others || []).forEach((p) => (p.trips || []).forEach((t) => {
      if (t.kind === 'trade' || t.kind === 'assist' || t.kind === 'deliver' || t.defeated || now >= t.startAt + (t.travelMs || 0)) return;
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
    this.thinMap();
    this.markers.ensure();
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
   * 所有據點都持續承受屍潮。分頁切到背景時瀏覽器會暫停 requestAnimationFrame。
   */
  startSiegeLoop() {
    let last = performance.now();
    const loop = (t) => {
      this.siege.update(Math.min(Math.max(0, (t - last) / 1000), 1));
      last = t;
      this.siegeRaf = requestAnimationFrame(loop);
    };
    this.siegeRaf = requestAnimationFrame(loop);
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
    this.exploration.update(now, { silent });
    this.npcs.update(now);
    this.trader.update(now);
    this.trade.notifyArrivals(now);
    this.assist.update(now);
    this.trade.prune(now);
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
    this.resources.apply(elapsed, { offline: true });
    this.shelter.update(now, elapsed);
    this.research.update(now);
    this.survivors.updateVitals(now, elapsed, this.resources.lastStarvingMs);
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
    this.log(`🌙 離線 ${Math.round(elapsed / 60000)} 分鐘，收益已結算`, 'info');
    return {
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

  async scanMap(lat, lon, onProgress, { quick = false, maxWaitMs = 0 } = {}) {
    let pois = [];
    let source = 'overpass';
    const areas = this.scanAreas(lat, lon);
    try {
      // 依序掃描各區域（公共伺服器限制同時請求數），進度合併計算
      const run = async () => {
        const seen = new Set();
        const out = [];
        for (let i = 0; i < areas.length; i += 1) {
          const a = areas[i];
          const list = await fetchPois(a.lat, a.lon, a.radius, onProgress && ((d, t) => onProgress(i * t + d, areas.length * t)), { buildings: !quick });
          list.forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); } });
        }
        return out;
      };
      pois = maxWaitMs
        ? await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('quick scan timeout')), maxWaitMs))])
        : await run();
    } catch (err) {
      console.warn('[Game] Overpass failed, using generated POIs', err);
      source = 'generated';
    }
    pois = fillPois(thinPois(pois, lat, this.protectedPoiIds()), lat, lon);
    const map = this.state.map;
    map.thinV = POI_THIN_VERSION;
    const old = new Map(map.pois.map((p) => [p.id, p]));
    // 同一棟建築保留今日搜刮紀錄
    pois.forEach((p) => { if (old.get(p.id)?.lootedDay) p.lootedDay = old.get(p.id).lootedDay; });
    // 保留據點與探索中目的地的 POI，避免重新掃描後消失
    const keep = new Set([...this.state.bases.map((b) => b.poiId), ...this.state.expeditions.map((e) => e.poiId), ...this.markers.list.map((m) => m.id)]);
    keep.forEach((id) => {
      const p = old.get(id);
      if (p && !pois.some((q) => q.id === id)) pois.push(p);
    });
    this.markers.ensure(pois);
    Object.assign(map, {
      center: { lat, lon }, pois, source, fetchedAt: Date.now(), zombieGroups: [], lastZombieRefresh: 0, zombieNight: null,
    });
    this.zombies.update(Date.now());
    bus.emit(EVT.MAP_CHANGED);
    return { count: pois.length, source };
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
    this.state.log.unshift({ t: Date.now(), msg, type });
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
