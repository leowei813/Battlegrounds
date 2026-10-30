import {
  TICK_MS, AUTOSAVE_MS, OFFLINE_CAP_MS, MAX_LOG, RESOURCE_KEYS, POI_SCAN_RADIUS,
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
import { grant } from '../systems/costUtils.js';
import { fetchPois } from '../map/OverpassService.js';
import { fillPois } from '../map/PoiGenerator.js';

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

    this.lastPhase = null;
    this.timers = [];
  }

  static newGame(opts) {
    return new Game(createInitialState(opts));
  }

  /**
   * 啟動主迴圈並結算離線收益。
   * @returns {object|null} 離線報告
   */
  start() {
    const report = this.processOffline();
    this.quests.ensureDaily();
    this.lastPhase = this.time.phaseId();
    this.started = true;
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
    this.resources.apply(dt);
    this.shelter.update(now, Math.min(dt, 5000));
    this.research.update(now);
    this.survivors.updateVitals(now, dt, this.resources.lastStarvingMs);
    this.survivors.updateBoard(now);
    this.exploration.update(now, { silent });
    this.npcs.update(now);
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
    this.resources.apply(elapsed);
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
  async scanMap(lat, lon, onProgress, { quick = false, maxWaitMs = 0 } = {}) {
    let pois = [];
    let source = 'overpass';
    try {
      const req = fetchPois(lat, lon, POI_SCAN_RADIUS, onProgress, { buildings: !quick });
      pois = maxWaitMs
        ? await Promise.race([req, new Promise((_, rej) => setTimeout(() => rej(new Error('quick scan timeout')), maxWaitMs))])
        : await req;
    } catch (err) {
      console.warn('[Game] Overpass failed, using generated POIs', err);
      source = 'generated';
    }
    pois = fillPois(pois, lat, lon);
    const map = this.state.map;
    const old = new Map(map.pois.map((p) => [p.id, p]));
    // 同一棟建築保留今日搜刮紀錄
    pois.forEach((p) => { if (old.get(p.id)?.lootedDay) p.lootedDay = old.get(p.id).lootedDay; });
    // 保留據點與探索中目的地的 POI，避免重新掃描後消失
    const keep = new Set([...this.state.bases.map((b) => b.poiId), ...this.state.expeditions.map((e) => e.poiId)]);
    keep.forEach((id) => {
      const p = old.get(id);
      if (p && !pois.some((q) => q.id === id)) pois.push(p);
    });
    Object.assign(map, {
      center: { lat, lon }, pois, source, fetchedAt: Date.now(), zombieGroups: [], lastZombieRefresh: 0,
    });
    this.zombies.update(Date.now());
    bus.emit(EVT.MAP_CHANGED);
    return { count: pois.length, source };
  }

  /** 給予資源/貨幣（自動套用倉庫上限） */
  grant(gains, ignoreCap = false) {
    return grant(this.state, gains, ignoreCap ? Infinity : this.resources.storageCap());
  }

  log(msg, type = 'info') {
    this.state.log.unshift({ t: Date.now(), msg, type });
    if (this.state.log.length > MAX_LOG) this.state.log.length = MAX_LOG;
    bus.emit(EVT.LOG);
  }

  toast(msg, type = 'info') {
    bus.emit(EVT.TOAST, { msg, type });
  }

  /** 玩家操作後呼叫：立即通知 UI 更新 */
  changed() {
    bus.emit(EVT.STATE_CHANGED);
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
