/**
 * 資料與邏輯健檢（無瀏覽器）：
 *   npm run check
 * 1. 驗證設定檔互相引用的 ID 是否存在
 * 2. 跑一段無頭模擬，確認各系統可正常運作
 */
import { Game } from '../src/core/Game.js';
import { fillPois } from '../src/map/PoiGenerator.js';
import { RESEARCH } from '../src/config/research.js';
import { DEFENSES } from '../src/config/defenses.js';
import { ITEM_TYPES } from '../src/config/equipment.js';
import { POI_TYPES } from '../src/config/poiTypes.js';
import { ALL_ENEMIES } from '../src/config/enemies.js';
import { MAIN_QUESTS, DAILY_POOL, ACHIEVEMENTS } from '../src/config/quests.js';
import { FACILITIES } from '../src/config/facilities.js';
import { DAY_REAL_MS, START_HOUR } from '../src/config/constants.js';

/** 把遊戲時鐘調到指定時刻（建檔時間往前推） */
const setHour = (game, hour) => {
  game.state.createdAt = Date.now() - (((hour - START_HOUR + 24) % 24) / 24) * DAY_REAL_MS;
};
import { SaveManager } from '../src/core/SaveManager.js';
import { PRIMARY_DANGER_COEF } from '../src/config/civilization.js';
import { hashAccessCode, ACCESS_ITERATIONS } from '../src/security/accessHash.js';
import crypto from 'node:crypto';

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error(`✗ ${msg}`);
  }
};

// ---- 1. 參照完整性 ----
Object.entries(RESEARCH).forEach(([id, r]) => (r.requires || []).forEach((q) => assert(RESEARCH[q], `research ${id} requires unknown ${q}`)));
Object.entries(DEFENSES).forEach(([id, d]) => assert(!d.requires || RESEARCH[d.requires], `defense ${id} requires unknown ${d.requires}`));
Object.entries(ITEM_TYPES).forEach(([id, t]) => assert(!t.requires || RESEARCH[t.requires], `item ${id} requires unknown ${t.requires}`));
Object.entries(POI_TYPES).forEach(([id, p]) => {
  Object.keys(p.enemies).forEach((e) => assert(ALL_ENEMIES[e], `poi ${id} enemy ${e} unknown`));
  Object.keys(p.itemBias).forEach((t) => assert(ITEM_TYPES[t], `poi ${id} item ${t} unknown`));
});
[...MAIN_QUESTS, ...DAILY_POOL, ...ACHIEVEMENTS].forEach((q) => {
  if (q.cond.type === 'facility') assert(FACILITIES[q.cond.id], `quest ${q.id} facility ${q.cond.id} unknown`);
});

// ---- 2. 無頭模擬 ----
globalThis.performance ??= { now: () => Date.now() };
const g = Game.newGame({ playerName: 'CI', classId: 'scout', lat: 25.0339, lon: 121.5645 });
g.state.map.pois = fillPois([], 25.0339, 121.5645);
assert(g.shelter.setShelter(g.state.map.pois[0]).ok, 'set shelter');

// ---- 白天：地圖上沒有殭屍（只在探索的建築內遭遇）----
setHour(g, 10);
g.zombies.refresh();
assert(g.state.map.zombieGroups.length === 0, '白天地圖上沒有殭屍群');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.of().zombies.length === 0 && !Number.isFinite(g.siege.of().spawnInterval()), '白天沒有屍潮');
setHour(g, 21); // 之後的測試在夜晚進行
assert(g.shelter.upgradeFacility(null, 'farm').ok, 'upgrade farm');
g.zombies.refresh();
assert(g.state.map.zombieGroups.length > 0, 'zombie groups spawned');
const target = g.state.map.pois.find((p) => p.type === 'residential' && !g.shelter.baseAtPoi(p.id));
assert(g.exploration.start(target.id, ['leader'], 5).ok, 'start exploration');
const reports = g.exploration.update(Date.now() + 3600e3, { silent: true });
assert(reports.length === 1, 'exploration resolved');
g.state.player.coins = 1e5;
Object.keys(g.state.resources).forEach((k) => { g.state.resources[k] = 1e5; });
assert(g.survivors.recruitRandom().ok, 'recruit');
assert(g.equipment.craft('pistol').ok, 'craft');
g.survivors.leader().injuredUntil = 0; // 探索可能讓領袖受傷；確保有人駐守
for (let i = 0; i < 1200; i += 1) g.siege.update(0.1);
assert(g.state.stats.siegeKills > 0, 'siege kills happen');
const alive = g.siege.of().zombies.length;
setHour(g, 7); // 天亮：殭屍撤回建築
for (let i = 0; i < 400; i += 1) g.siege.update(0.1);
assert(alive === 0 || g.siege.of().zombies.length === 0, `天亮後殭屍撤退（${alive} → ${g.siege.of().zombies.length}）`);
g.zombies.refresh();
assert(g.state.map.zombieGroups.length === 0, '天亮後地圖殭屍群消失');
setHour(g, 21);
const save = JSON.parse(JSON.stringify(g.state));
assert(save.version === 2, 'state is serializable');

// ---- 3. 文明度與多據點 ----
const civ0 = g.civilization.value();
const siege = g.siege.of();
const lv0 = siege.zombieLevel();
const iv0 = siege.spawnInterval();
const danger0 = g.shelter.dangerLevel();
g.survivors.leader().level = 40; // 玩家等級提升文明度
g.state.bases[0].facilities.wall.level = 10;
g.civilization.invalidate();
const civ1 = g.civilization.value();
assert(civ1 > civ0, `文明度隨玩家等級與建築上升（${civ0} → ${civ1}）`);
assert(siege.zombieLevel() > lv0 && siege.spawnInterval() < iv0, '屍潮隨文明度變強');
const expectDanger = Math.round((g.shelter.baseDanger(g.shelter.primary()) + civ1 * PRIMARY_DANGER_COEF) * 10) / 10;
assert(g.shelter.dangerLevel() === expectDanger && expectDanger > danger0, `主要據點危險度 = 基礎 + 文明度 × 係數（${expectDanger}）`);

const g2 = Game.newGame({ playerName: 'Day', classId: 'warrior', lat: 0, lon: 0 });
g2.state.map.pois = fillPois([], 0, 0);
g2.shelter.establish(g2.state.map.pois[0]);
const lvDay1 = g2.siege.of().zombieLevel();
g2.state.createdAt -= 20 * 30 * 60 * 1000; // 經過 20 天
g2.civilization.invalidate();
assert(g2.siege.of().zombieLevel() - lvDay1 <= 1, '天數本身不會提升屍潮強度（夜間 ±1）');

const outpostPoi = g.state.map.pois.find((p) => !g.shelter.baseAtPoi(p.id));
const est = g.shelter.establish(outpostPoi);
assert(est.ok && g.state.bases.length === 2, '建立第二個據點');
assert(g.shelter.dangerLevel(est.base) === g.shelter.baseDanger(est.base), '前哨據點危險度不受文明度加成');
assert(g.shelter.setPrimary(est.base.id).ok && g.shelter.dangerLevel(est.base) > g.shelter.baseDanger(est.base), '設為主要據點後危險度隨文明度提升');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.sieges.size === 2, '每個據點各自承受屍潮');

// ---- 4. 舊存檔遷移（v1 單一避難所 → v2 多據點）----
const v1 = JSON.parse(JSON.stringify(g2.state));
v1.version = 1;
v1.shelter = { ...v1.bases[0], poiId: v1.bases[0].poiId };
delete v1.bases;
delete v1.primaryBaseId;
const migrated = SaveManager.migrate(v1);
assert(migrated.version === 2 && migrated.bases.length === 1 && migrated.primaryBaseId === migrated.bases[0].id && !migrated.shelter, 'v1 → v2 存檔遷移');

// ---- 5. 通行碼雜湊（純 JS SHA-256 與 Node crypto 結果一致）----
let ref = 'jdqs-gate:密碼 test';
for (let i = 0; i < ACCESS_ITERATIONS; i += 1) ref = crypto.createHash('sha256').update(ref).digest('hex');
assert(hashAccessCode('  密碼 test ') === ref, '通行碼雜湊與 Node crypto 一致（並忽略前後空白）');

if (failures) {
  console.error(`\n${failures} 項檢查失敗`);
  process.exit(1);
}
console.log(`✓ 全部通過（擊殺 ${g.state.stats.siegeKills}，探索事件 ${reports[0].events.length}）`);
