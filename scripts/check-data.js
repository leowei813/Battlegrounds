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
import { POI_TYPES } from '../src/config/poiTypes.js';
import { ALL_ENEMIES } from '../src/config/enemies.js';
import { MAIN_QUESTS, DAILY_POOL, ACHIEVEMENTS } from '../src/config/quests.js';
import { FACILITIES } from '../src/config/facilities.js';
import {
  RARITIES, RARITY_ORDER, SLOT_KEYS, ITEM_TYPES, ITEM_MODELS,
} from '../src/config/equipment.js';
import { DAY_REAL_MS, START_HOUR } from '../src/config/constants.js';

/** 把遊戲時鐘調到指定時刻（建檔時間往前推） */
const setHour = (game, hour) => {
  game.state.createdAt = Date.now() - (((hour - START_HOUR + 24) % 24) / 24) * DAY_REAL_MS;
};
import { SaveManager } from '../src/core/SaveManager.js';
import { PRIMARY_DANGER_COEF } from '../src/config/civilization.js';
import { hashAccessCode, ACCESS_ITERATIONS } from '../src/security/accessHash.js';
import { haversine } from '../src/utils/math.js';
import { fetchPois, classify } from '../src/map/OverpassService.js';
import crypto from 'node:crypto';

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error(`✗ ${msg}`);
  }
};

// ---- 1. 參照完整性 ----
Object.entries(RESEARCH).forEach(([id, r]) => (r.requires || []).forEach(([q]) => assert(RESEARCH[q], `research ${id} requires unknown ${q}`)));
Object.entries(DEFENSES).forEach(([id, d]) => assert(!d.requires || RESEARCH[d.requires], `defense ${id} requires unknown ${d.requires}`));
Object.entries(ITEM_MODELS).forEach(([id, md]) => assert(ITEM_TYPES[md.type] && md.tier >= 1 && md.tier <= 10, `model ${id} invalid`));
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
const roll = g.survivors.recruitRoll();
assert(roll.ok && roll.offer.length === 3, '招募一次出現三位候選人');
assert(g.survivors.pickRecruit(roll.offer[1].id).ok && !g.state.recruitOffer, '選擇其中一位加入');
assert(g.equipment.craft('knife').ok, 'craft');
Object.assign(g.survivors.leader(), { severe: false, hp: null }); // 探索可能讓領袖重傷；確保有人駐守
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
assert(save.version === 8, 'state is serializable');
// v3 精簡格式：打包後體積變小，還原後內容一致
g.state.map.pois[1].lootedDay = 20000;
g.state.map.pois[1].lastVisit = 123;
const packed = JSON.stringify(SaveManager.pack(g.state));
const restored = SaveManager.migrate(JSON.parse(packed));
assert(JSON.stringify(restored.map.pois) === JSON.stringify(g.state.map.pois), '建築精簡格式可完整還原');
assert(packed.length < JSON.stringify(g.state).length && !('pois' in JSON.parse(packed).map), `存檔以精簡格式儲存（${packed.length} < ${JSON.stringify(g.state).length} bytes）`);

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
assert(!g.shelter.canEstablish(outpostPoi).ok, '避難所只能一座，未研究前哨站科技不能建第二個據點');
g.state.research.levels.e_outpost = 1;
g.research.invalidate();
Object.assign(g.state.resources, { wood: 5000, metal: 5000, cloth: 5000 });
g.state.player.coins = 5000;
const est = g.shelter.establish(outpostPoi);
assert(est.ok && g.state.bases.length === 2 && est.base.kind === 'outpost', '研究「前哨站」後可建立前哨站');
assert(!g.shelter.canEstablish(g.state.map.pois.find((p) => !g.shelter.baseAtPoi(p.id))).ok, '前哨站數量受研究限制');
assert(g.shelter.dangerLevel(est.base) === g.shelter.baseDanger(est.base), '前哨站危險度不受文明度加成');
assert(!g.shelter.canUpgradeFacility(est.base, 'farm').ok && g.shelter.canUpgradeFacility(est.base, 'watchtower').ok, '前哨站只能建造防禦設施');
for (let i = 0; i < 300; i += 1) g.siege.update(0.1);
assert(g.siege.sieges.size === 2, '每個據點各自承受屍潮');

// ---- 4. 舊存檔遷移（v1 單一避難所 → v2 多據點）----
const v1 = JSON.parse(JSON.stringify(g2.state));
v1.version = 1;
v1.shelter = { ...v1.bases[0], poiId: v1.bases[0].poiId };
delete v1.bases;
delete v1.primaryBaseId;
const migrated = SaveManager.migrate(v1);
assert(migrated.version === 8 && migrated.bases.length === 1 && migrated.bases[0].kind === 'shelter' && migrated.primaryBaseId === migrated.bases[0].id && !migrated.shelter, 'v1 → v2 存檔遷移');

// ---- 6. 探索行程與途中遇襲 ----
{
  const g3 = Game.newGame({ playerName: 'Trip', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  g3.state.map.pois = fillPois([], 25.0339, 121.5645);
  g3.shelter.establish(g3.state.map.pois[0]);
  const home = g3.shelter.primary();
  const far = g3.state.map.pois.find((p) => !g3.shelter.baseAtPoi(p.id) && haversine(home.lat, home.lon, p.lat, p.lon) > 600);
  setHour(g3, 21);
  const t0 = Date.now();
  const ex = g3.exploration.start(far.id, ['leader'], 15, false, t0).exp;
  const p0 = g3.exploration.progress(ex, t0);
  const pMid = g3.exploration.progress(ex, t0 + ex.travelMs / 2);
  const pSearch = g3.exploration.progress(ex, t0 + ex.travelMs + 1000);
  const pBack = g3.exploration.progress(ex, t0 + ex.travelMs * 1.5 + ex.searchMs);
  assert(p0.phase === 'outbound' && pSearch.phase === 'searching' && pBack.phase === 'returning', '行程三段：去程 → 搜索 → 返程');
  assert(Math.abs(pMid.movedM - ex.distanceM / 2) < 2 && Math.abs(pBack.movedM - ex.distanceM * 1.5) < 2, `移動距離正確（${pMid.movedM} / ${ex.distanceM * 2} m）`);
  assert(ex.endAt - ex.startAt === ex.travelMs * 2 + ex.searchMs, '總時間 = 去程 + 搜索 + 返程');
  // 在路線中點放一群弱小殭屍，模擬經過時遇襲
  const leader = g3.survivors.leader();
  leader.level = 30;
  let ambushes = 0;
  for (let i = 0; i < 20 && !ambushes; i += 1) {
    ex.encountered = [];
    g3.state.map.zombieGroups = [{ id: `zg_test${i}`, poiId: far.id, lat: pMid.pos.lat, lon: pMid.pos.lon, enemyId: 'walker', count: 1, level: 1, elite: false, boss: false, spawnedAt: t0 }];
    ambushes = g3.exploration.checkAmbush(t0 + ex.travelMs / 2).length;
  }
  assert(ambushes === 1 && ex.travelEvents.some((e) => e.includes('擊退')), '夜間移動經過殭屍群會遇襲，勝利後繼續');
  assert(g3.state.expeditions.length === 1 && g3.state.map.zombieGroups.length === 0, '擊退後殭屍群消失、探索繼續');
  // 搜索中不會遇襲
  g3.state.map.zombieGroups = [{ id: 'zg_s', poiId: far.id, lat: far.lat, lon: far.lon, enemyId: 'walker', count: 1, level: 1, elite: false, boss: false, spawnedAt: t0 }];
  assert(g3.exploration.checkAmbush(t0 + ex.travelMs + 1000).length === 0, '搜索中不會遇襲');
  // 戰敗：探索提前結束
  leader.level = 1;
  Object.assign(leader, { severe: false, hp: null });
  let aborted = false;
  for (let i = 0; i < 20 && !aborted; i += 1) {
    ex.encountered = [];
    g3.state.map.zombieGroups = [{ id: `zg_boss${i}`, poiId: far.id, lat: pBack.pos.lat, lon: pBack.pos.lon, enemyId: 'tankBoss', count: 1, level: 30, elite: false, boss: true, spawnedAt: t0 }];
    aborted = g3.exploration.checkAmbush(t0 + ex.travelMs * 1.5 + ex.searchMs).some((r) => r.aborted);
  }
  assert(aborted && g3.state.expeditions.length === 0 && g3.survivors.leader().status === 'idle', '遇襲戰敗則撤退、探索結束');
  assert(g3.state.reports[0] && !g3.state.reports[0].success, '戰敗撤退產生失敗報告');
}

// ---- 7. OSM 分區抓取（模擬 Overpass）----
{
  const realFetch = globalThis.fetch;
  const LAT = 25.05;
  const LON = 121.56;
  let calls = 0;
  let truncatedOnce = false;
  // 每個 bbox 內均勻產生建築：每 0.0004 度一棟（約 40 公尺）
  globalThis.fetch = async (_url, { body }) => {
    calls += 1;
    const q = decodeURIComponent(body.slice(5));
    const m = /way\["building"\]\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(q);
    const json = (data) => ({ ok: true, json: async () => data });
    if (!m) return json({ elements: [{ type: 'node', id: 1, lat: LAT, lon: LON, tags: { shop: 'convenience', name: '測試超商' } }] });
    const [s, w, n, e] = m.slice(1).map(Number);
    if (!truncatedOnce && n - s > 0.01) { // 第一個大區塊模擬被截斷
      truncatedOnce = true;
      return json({ remark: 'runtime error: Query timed out', elements: [] });
    }
    const elements = [];
    for (let la = s; la < n; la += 0.0004) {
      for (let lo = w; lo < e; lo += 0.0004) elements.push({ type: 'way', id: elements.length + calls * 1e6, center: { lat: la, lon: lo }, tags: { building: 'yes' } });
    }
    return json({ elements });
  };
  const progress = [];
  const pois = await fetchPois(LAT, LON, 1200, (d, t) => progress.push(`${d}/${t}`));
  globalThis.fetch = realFetch;
  const resi = pois.filter((p) => p.type === 'residential').length;
  assert(classify({ building: 'yes' }) === 'residential', 'building=yes 視為住宅');
  assert(truncatedOnce && calls >= 9, `被截斷的區塊會切小重抓（請求 ${calls} 次）`);
  // 模擬資料約每 1,800 平方公尺一棟，1.2 公里圓內約 2,500 棟，應全部取得
  assert(resi > 2400, `分區抓取取得範圍內所有建築（住宅 ${resi}）`);
  assert(pois.every((p) => haversine(LAT, LON, p.lat, p.lon) <= 1200 + 1), '只保留圓形掃描範圍內的建築');
  assert(pois.some((p) => p.type === 'shop' && p.name === '測試超商'), '設施查詢結果保留');
  assert(progress.at(-1) === '5/5', `回報掃描進度（${progress.join(' ')}）`);
}

// ---- 8. 裝備品級與素質 ----
{
  const ge = Game.newGame({ playerName: 'Gear', classId: 'warrior', lat: 0, lon: 0 });
  const eq = ge.equipment;
  assert(Object.keys(ITEM_TYPES).length >= 15 && SLOT_KEYS.length === 8, `裝備類型 ${Object.keys(ITEM_TYPES).length} 種、裝備欄 ${SLOT_KEYS.length} 個`);
  // 每個品級範圍首尾相接、不重疊
  RARITY_ORDER.slice(1).forEach((r, i) => {
    assert(RARITIES[r].min >= RARITIES[RARITY_ORDER[i]].max, `${RARITIES[r].name}最低倍率 ≥ ${RARITIES[RARITY_ORDER[i]].name}最高倍率`);
  });
  // 實際生成：同類型同等級，高一階的每項最低素質 ≥ 低一階的最高素質
  let violations = 0;
  Object.keys(ITEM_TYPES).forEach((type) => {
    const range = {};
    RARITY_ORDER.forEach((rar) => {
      for (let i = 0; i < 60; i += 1) {
        const it = eq.generate({ level: 12, model: Object.keys(ITEM_MODELS).find((k) => ITEM_MODELS[k].type === type), rarity: rar });
        Object.entries(it.stats).forEach(([k, v]) => {
          range[rar] = range[rar] || {};
          const cur = range[rar][k] || { min: Infinity, max: -Infinity };
          range[rar][k] = { min: Math.min(cur.min, v), max: Math.max(cur.max, v) };
        });
      }
    });
    RARITY_ORDER.slice(1).forEach((rar, i) => {
      Object.entries(range[rar]).forEach(([k, { min }]) => {
        const lowerMax = range[RARITY_ORDER[i]][k].max;
        if (min < lowerMax) violations += 1;
      });
    });
  });
  assert(violations === 0, `所有類型的每項素質都符合「高品級最低 ≥ 低品級最高」（違規 ${violations}）`);
  // 同品級素質隨機
  const sameTier = Array.from({ length: 30 }, () => eq.generate({ level: 10, model: 'ak47', rarity: 'rare' }).stats.atk);
  assert(new Set(sameTier).size > 5, '同品級素質為隨機');
  // 製作：品級與素質隨機
  ge.state.map.pois = fillPois([], 0, 0);
  ge.shelter.establish(ge.state.map.pois[0]);
  ge.state.player.coins = 1e7;
  Object.keys(ge.state.resources).forEach((k) => { ge.state.resources[k] = 1e7; });
  ge.state.bases[0].facilities.warehouse.level = 10;
  const crafted = Array.from({ length: 300 }, () => eq.craft('knife').item);
  const tiers = new Set(crafted.map((it) => it.rarity));
  assert(crafted.every(Boolean) && tiers.size >= 4, `製作的品級隨機（出現 ${[...tiers].map((r) => RARITIES[r].name).join('、')}）`);
  // 吸血與探索速度詞綴生效
  const sv = ge.survivors.leader();
  const ls = eq.generate({ level: 10, type: 'melee', rarity: 'legendary' });
  eq.addItem(ls);
  eq.equip(sv.id, ls.id);
  assert(ge.survivors.stats(sv).lifeSteal > 0, '近戰武器吸血屬性生效');
  const boots = eq.generate({ level: 10, type: 'boots', rarity: 'epic' });
  eq.addItem(boots);
  eq.equip(sv.id, boots.id);
  assert(ge.survivors.stats(sv).exploreSpeed > 0, '鞋子探索速度屬性生效');
  // 舊存檔：灰色「普通」→「劣質」，補上新裝備欄
  const old = JSON.parse(JSON.stringify(SaveManager.pack(ge.state)));
  old.version = 3;
  old.inventory.items[0].rarity = 'common';
  delete old.survivors[0].equipment.gloves;
  const mig = SaveManager.migrate(old);
  assert(mig.inventory.items[0].rarity === 'poor' && mig.survivors[0].equipment.gloves === null, 'v3 → v4：舊普通裝備轉為劣質、補上新裝備欄');
}

// ---- 9. v2.0：重傷 / 飢餓 / 死亡 / 招募 / 突破 / 據點規模 / 每日物資 ----
{
  const gv = Game.newGame({ playerName: 'Vital', classId: 'warrior', lat: 0, lon: 0 });
  gv.state.map.pois = fillPois([], 0, 0);
  gv.shelter.establish(gv.state.map.pois.find((p) => p.type === 'military'));
  const sv = gv.survivors;
  const leader = sv.leader();
  // 重傷懲罰：扣升級所需經驗 10%，不足時降級
  leader.level = 5;
  leader.xp = 2;
  sv.becomeSevere(leader, '測試');
  assert(leader.severe && leader.level === 4 && sv.hpOf(leader) === 0, `重傷扣經驗並降級（Lv5 → Lv${leader.level}）`);
  assert(!sv.isAvailable(leader), '重傷無法行動');
  // 有食物時自然恢復，回到 30% 解除重傷
  gv.state.starving = false;
  sv.updateVitals(Date.now(), 60 * 60000, 0);
  assert(!leader.severe && sv.hpOf(leader) > 0, '有食物時生命恢復並脫離重傷');
  // 飢餓扣血直到重傷，飢餓時無法治療
  gv.state.starving = true;
  const npc = gv.survivors.makeCandidate(5);
  gv.state.survivors.push(npc);
  sv.updateVitals(Date.now(), 30 * 60000, 30 * 60000);
  assert(npc.severe && sv.hpOf(npc) === 0, '飢餓持續扣血直到重傷');
  gv.state.resources.medicine = 100;
  assert(!sv.heal(npc.id).ok, '飢餓中無法治療');
  // 重傷 + 飢餓滿遊戲內 3 天 → 永久死亡（領袖不會死亡）
  sv.becomeSevere(leader, '測試');
  leader.zeroSince = Date.now() - 4 * DAY_REAL_MS;
  npc.zeroSince = Date.now() - 4 * DAY_REAL_MS;
  sv.updateVitals(Date.now(), 1000, 1000);
  assert(!gv.state.survivors.includes(npc) && gv.state.survivors.includes(leader), '重傷且飢餓滿 3 天的隊員永久死亡，領袖不會死亡');
  // 食物收支：人越多消耗越多；食物見底且淨收入為負 → 飢餓
  gv.state.starving = false;
  for (let i = 0; i < 6; i += 1) gv.state.survivors.push(gv.survivors.makeCandidate(1));
  gv.state.resources.food = 1;
  gv.resources.apply(60 * 60000);
  assert(gv.state.starving && gv.resources.lastStarvingMs > 0, `人數多、食物見底時進入飢餓（淨收入 ${gv.resources.rates().net.food.toFixed(1)}/時）`);
  // 人員上限：依領袖等級與據點等級提高，最多 10 人
  leader.level = 50;
  gv.state.bases[0].facilities = Object.fromEntries(Object.keys(gv.state.bases[0].facilities).map((k) => [k, { level: 10 }]));
  assert(sv.housing() === 10, `人員上限最多 10 人（目前 ${sv.housing()}）`);
  // 品級越高成長越多
  const a = gv.survivors.makeCandidate(30);
  const b = { ...a, id: 'x', rarity: 'legendary' };
  a.rarity = 'poor';
  assert(sv.stats(b).atk > sv.stats(a).atk, '倖存者品級越高，升級提升的能力越多');
  // 驅逐
  const kick = gv.state.survivors.find((s) => !s.isLeader);
  assert(sv.dismiss(kick.id).ok && !sv.get(kick.id), '可驅逐隊員');
  // 據點規模：巨型據點可建 20 棟建築
  const base = gv.shelter.primary();
  assert(gv.shelter.sizeInfo(base).total === 20 && base.defenses.length === 12, '最大（巨型）據點可建造 20 棟建築');
  const small = gv.shelter.sizeInfo(gv.state.map.pois.find((p) => p.type === 'gasStation'));
  assert(small.total < 20, `其他規模可建造數較少（${small.name} ${small.total} 棟）`);
  // 突破：資源 -50%，建築可能降級或被拆毀，當晚不再來襲
  Object.keys(gv.state.resources).forEach((k) => { gv.state.resources[k] = 1000; });
  base.defenses.forEach((d) => Object.assign(d, { type: 'trap', level: 1 }));
  const siege = gv.siege.of(base.id);
  let destroyed = 0;
  siege.breach();
  assert(Math.round(gv.state.resources.wood) === 500, `突破損失 50% 資源（木材 1000 → ${Math.round(gv.state.resources.wood)}）`);
  setHour(gv, 22);
  assert(siege.quiet() && !siege.active() && base.quietUntil > Date.now(), '防線被突破後當晚不再有屍潮');
  assert(!siege.quiet(base.quietUntil + 1), '天亮後恢復');
  destroyed = base.defenses.filter((d) => !d.type).length;
  for (let i = 0; i < 5 && !destroyed; i += 1) {
    siege.breach();
    destroyed = base.defenses.filter((d) => !d.type).length;
  }
  assert(destroyed > 0, `突破後 1 級建築可能被拆毀（${destroyed} 棟）`);
  assert(base.facilities.wall.level >= 1, '圍牆最低保留 1 級');
}
{
  // 每日物資：探索後清空，隔天 00:00 重置且隨機
  const { stockOf, dayKey } = await import('../src/systems/LootStock.js');
  const poi = { id: 'osm_w1', type: 'shop', name: 'x', lat: 0, lon: 0 };
  const today = stockOf(poi);
  assert(!today.empty && Object.keys(today.resources).length >= 1, '建築每天有物資');
  assert(JSON.stringify(stockOf(poi)) === JSON.stringify(today), '同一天物資固定');
  poi.lootedDay = dayKey();
  assert(stockOf(poi).empty, '探索後物資清空');
  const tomorrow = Date.now() + 86400000;
  assert(!stockOf(poi, tomorrow).empty, '隔天 00:00 重置');
  const days = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(stockOf({ ...poi, lootedDay: 0 }, Date.now() + i * 86400000).resources)));
  assert(days.size > 5, '每天物資的種類與數量隨機');
}

// ---- 10. v4：區域危險度、屍潮分波、載具、放棄據點、NPC 據點 ----
{
  const { ZONES, zoneIndexAt, zoneAt } = await import('../src/config/zones.js');
  const { stockOf } = await import('../src/systems/LootStock.js');
  const counts = ZONES.map(() => 0);
  for (let i = 0; i < 20000; i += 1) counts[zoneIndexAt(25 + (i % 141) * 0.0011, 121 + Math.floor(i / 141) * 0.0011)] += 1;
  assert(counts.every((c) => c > 0), `六種區域都會出現（${counts.join('/')}）`);
  assert(zoneIndexAt(25.01, 121.52) === zoneIndexAt(25.01, 121.52), '同一座標的區域固定（所有玩家相同）');
  // 找一棟安全區與一棟深淵區的建築比較物資
  const find = (idx) => {
    for (let i = 0; i < 40000; i += 1) {
      const lat = 25 + (i % 200) * 0.0009;
      const lon = 121 + Math.floor(i / 200) * 0.0009;
      if (zoneIndexAt(lat, lon) === idx) return { lat, lon };
    }
    return null;
  };
  const safe = find(0);
  const abyss = find(5);
  const sum = (pos) => Array.from({ length: 30 }, (_, i) => stockOf({ id: `z${i}`, type: 'shop', name: 'x', ...pos }))
    .reduce((t, st) => t + Object.values(st.resources).reduce((a2, b2) => a2 + b2, 0), 0);
  assert(sum(abyss) > sum(safe) * 2.5, '深淵區物資遠多於安全區');
  assert(zoneAt(abyss.lat, abyss.lon).siegeLevel > zoneAt(safe.lat, safe.lon).siegeLevel, '區域越危險屍潮越強');

  // 屍潮分波 + 據點越大越難守
  const gw = Game.newGame({ playerName: 'W', classId: 'warrior', lat: 0, lon: 0 });
  gw.state.map.pois = fillPois([], 0, 0);
  gw.shelter.establish(gw.state.map.pois[0]);
  setHour(gw, 21);
  gw.shelter.primary().facilities.wall.level = 10; // 避免測試中防線被突破
  gw.shelter.primary().wallHp = null;
  const sw = gw.siege.of();
  const seen = [];
  for (let i = 0; i < 1500; i += 1) {
    gw.siege.update(0.1);
    gw.shelter.primary().wallHp = null; // 測試波次節奏，不讓防線被突破
    seen.push(sw.waveLeft > 0 ? 1 : 0);
  }
  const bursts = seen.reduce((n, v, i) => n + (v && !seen[i - 1] ? 1 : 0), 0);
  assert(sw.wave >= 2 && bursts >= 2, `夜晚屍潮一波一波來襲（${sw.wave} 波，突破 ${gw.state.stats.breaches}，${gw.time.phase().name}，quiet ${sw.quiet()}）`);
  const base = gw.shelter.primary();
  base.size = 'small';
  const small = sw.spawnInterval();
  base.size = 'huge';
  assert(sw.spawnInterval() < small * 0.6, '巨型據點屍潮比小型據點多');

  // 生產下修、升級成本變陡
  const { FACILITIES: F } = await import('../src/config/facilities.js');
  assert(F.farm.cost(10).wood > F.farm.cost(1).wood * 150, '升級成本隨等級快速成長');
  const rates = gw.resources.rates().gross;
  assert(rates.food < 15, `生產只是輔助（起始食物 ${rates.food.toFixed(1)}/時）`);

  // 載具：速度、運載量、耗油、磨損、維修
  const vs = gw.vehicles;
  const bike = vs.create('bicycle');
  const truck = vs.create('truck', 0.5);
  vs.add(bike);
  vs.add(truck);
  const walk = vs.tripStats(2, [], 1000);
  const ride = vs.tripStats(2, [truck], 1000);
  assert(walk.speed === 1 && ride.speed > 1 && ride.cargo > walk.cargo * 10, '載具提升速度與運載量');
  assert(vs.tripStats(2, [bike], 1000).seated === false && vs.tripStats(2, [bike], 1000).speed === 1, '座位不足時全隊步行');
  assert(vs.tripStats(1, [bike], 1000).fuel === 0 && ride.fuel > 0, '腳踏車不耗油，貨車耗油');
  assert(!vs.validate([bike.id, truck.id], 1, 1000).ok, '每台載具至少需要一名駕駛');
  gw.state.resources.fuel = 0;
  assert(!vs.validate([truck.id], 2, 1000).ok, '燃料不足無法出車');
  gw.state.resources.fuel = 500;
  const homeW = gw.shelter.primary();
  const poiFar = gw.state.map.pois.filter((p) => !gw.shelter.baseAtPoi(p.id))
    .sort((p1, p2) => (p2.lat - homeW.lat) ** 2 + (p2.lon - homeW.lon) ** 2 - ((p1.lat - homeW.lat) ** 2 + (p1.lon - homeW.lon) ** 2))[0];
  const plainMs = gw.exploration.plan(poiFar, [gw.survivors.leader()], 15).travelMs;
  const carMs = gw.exploration.plan(poiFar, [gw.survivors.leader()], 15, Date.now(), [bike]).travelMs;
  assert(carMs < plainMs, '騎腳踏車縮短路程時間');
  const r = gw.exploration.start(poiFar.id, ['leader'], 15, false, Date.now(), { vehicleIds: [bike.id] });
  assert(r.ok && bike.status === 'out', '帶載具出發');
  const dur0 = bike.durability;
  gw.exploration.update(Date.now() + 3 * 3600e3, { silent: true });
  assert(bike.status === 'idle' && bike.durability < dur0, `返回後載具磨損（${dur0} → ${bike.durability}）`);
  gw.state.resources.metal = 1e4;
  gw.state.player.parts = 100;
  assert(vs.repair(truck.id).ok && truck.durability === vs.maxDurability(truck), '維修載具');

  // 運載量限制物資
  const gc = Game.newGame({ playerName: 'C', classId: 'scout', lat: 0, lon: 0 });
  gc.state.map.pois = fillPois([], 0, 0);
  gc.shelter.establish(gc.state.map.pois[0]);
  setHour(gc, 10);
  const rich = gc.state.map.pois.find((p) => p.type === 'military');
  gc.exploration.start(rich.id, ['leader'], 60);
  gc.state.expeditions[0].cargo = 10;
  const before = Object.values(gc.state.resources).reduce((a2, b2) => a2 + b2, 0);
  const [rep] = gc.exploration.update(Date.now() + 6 * 3600e3, { silent: true });
  const gainedTotal = Object.entries(rep.resources).filter(([k]) => k in gc.state.resources).reduce((a2, [, v]) => a2 + v, 0);
  assert(gainedTotal <= 12 && Object.values(gc.state.resources).reduce((a2, b2) => a2 + b2, 0) - before <= 12 + 1, `運載量限制帶回的物資（${gainedTotal}）`);

  // 放棄據點：退還 25%，搬家時超過運載量的物資被遺棄
  const ga = Game.newGame({ playerName: 'A', classId: 'warrior', lat: 0, lon: 0 });
  ga.state.map.pois = fillPois([], 0, 0);
  ga.shelter.establish(ga.state.map.pois[0]);
  const home = ga.shelter.primary();
  home.facilities.farm.level = 3;
  const built = ga.shelter.builtCost(home);
  const preview = ga.shelter.abandonPreview(home.id);
  assert(preview.refund.wood === Math.floor(built.wood * 0.25), '放棄據點退還 25% 建造資源');
  Object.keys(ga.state.resources).forEach((k) => { ga.state.resources[k] = 1000; });
  const ab = ga.shelter.abandon(home.id);
  const left = Object.values(ga.state.resources).reduce((a2, b2) => a2 + b2, 0);
  assert(ab.ok && !ga.shelter.hasShelter() && left <= preview.carry + 6, `搬家只能帶走運載量內的物資（剩 ${Math.round(left)} / 可搬 ${preview.carry}）`);
  assert(ga.shelter.canEstablish(ga.state.map.pois[1]).ok && ga.shelter.establish(ga.state.map.pois[1]).base.kind === 'shelter', '放棄後可重新建立避難所');

  // NPC 據點：生成、升級、探索、掠奪、被攻陷後重生
  const gn = Game.newGame({ playerName: 'N', classId: 'warrior', lat: 25.0339, lon: 121.5645 });
  gn.state.map.pois = fillPois([], 25.0339, 121.5645);
  gn.shelter.establish(gn.state.map.pois[0]);
  setHour(gn, 10);
  const t0 = Date.now();
  gn.npcs.update(t0);
  gn.npcs.update(t0 + 61000);
  gn.npcs.update(t0 + 122000);
  const perCell = {};
  gn.npcs.list.forEach((n) => { perCell[n.cell] = (perCell[n.cell] || 0) + 1; });
  assert(gn.npcs.list.length >= 3 && Object.values(perCell).every((c) => c <= 3) && Object.values(perCell).some((c) => c === 3), `每平方公里約 3 個 NPC 據點（共 ${gn.npcs.list.length} 個、${Object.keys(perCell).length} 格）`);
  const npc = gn.npcs.list[0];
  const lv = npc.level;
  npc.nextLevelAt = t0;
  gn.npcs.update(t0 + 1000);
  assert(npc.level === lv + 1, 'NPC 據點會升級');
  npc.trip = null;
  npc.nextExploreAt = t0;
  npc.nextRaidAt = t0 + 1e9;
  gn.npcs.update(t0 + 2000);
  assert(npc.trip?.kind === 'explore', 'NPC 會外出探索');
  const target = gn.state.map.pois.find((p) => p.id === npc.trip.poiId);
  gn.npcs.update(npc.trip.endAt + 1);
  assert(target.lootedDay, 'NPC 探索後建築被搜刮一空');
  assert(gn.npcs.aggression() < 0.5, '文明度低時 NPC 不太積極');
  // 掠奪：玩家沒有防禦且無人在家 → 被搶
  gn.state.survivors.forEach((s) => { s.status = 'exploring'; });
  Object.keys(gn.state.resources).forEach((k) => { gn.state.resources[k] = 1000; });
  npc.level = 30;
  npc.trip = null;
  npc.nextRaidAt = t0;
  gn.npcs.update(t0 + 3000);
  assert(npc.trip?.kind === 'raid', '白天 NPC 會出動掠奪');
  gn.npcs.update(npc.trip.startAt + npc.trip.travelMs + 1);
  assert(gn.state.resources.wood < 1000, `掠奪成功搶走資源（木材 1000 → ${gn.state.resources.wood}）`);
  // 夜晚屍潮期間不出動
  npc.trip = null;
  npc.nextRaidAt = t0;
  setHour(gn, 22);
  gn.npcs.update(Date.now());
  assert(!npc.trip, '夜晚屍潮期間 NPC 不會來襲');
  // 玩家攻陷 NPC 據點
  setHour(gn, 10);
  gn.state.survivors.forEach((s) => { s.status = 'idle'; });
  const weak = gn.npcs.list[1];
  weak.level = 1;
  weak.trip = null;
  const hero = gn.survivors.leader();
  hero.level = 50;
  hero.hp = null;
  hero.severe = false;
  const atk = gn.exploration.start(weak.id, ['leader'], 5, false, Date.now(), { kind: 'raid' });
  assert(atk.ok, '派隊攻打 NPC 據點');
  const coinsBefore = gn.state.player.coins;
  const [rr] = gn.exploration.update(Date.now() + 3 * 3600e3, { silent: true });
  assert(rr.success && !gn.npcs.get(weak.id) && gn.state.player.coins > coinsBefore, '攻陷 NPC 據點搶到資源，據點被摧毀');
  assert(gn.npcs.state.cellNext[weak.cell] > Date.now(), '被摧毀後該區域一段時間後才會重新出現 NPC');
}

// ---- 11. v5：研究等級制、招募、裝備型號、分級製作、圍牆修繕 ----
{
  const { MAX_RESEARCH_LEVEL } = await import('../src/config/research.js');
  const { craftRarityTable } = await import('../src/config/equipment.js');
  const { survivorRarityTable } = await import('../src/config/survivors.js');
  const gr = Game.newGame({ playerName: 'R', classId: 'warrior', lat: 0, lon: 0 });
  gr.state.map.pois = fillPois([], 0, 0);
  gr.shelter.establish(gr.state.map.pois[0]);
  // 研究
  assert(Object.keys(RESEARCH).length >= 69, `研究項目至少為原本三倍（${Object.keys(RESEARCH).length}）`);
  assert(Object.values(RESEARCH).every((r) => r.maxLevel >= 1 && r.maxLevel <= MAX_RESEARCH_LEVEL), '每項科技都有等級，最高 10 級');
  const atk0 = gr.survivors.stats(gr.survivors.leader()).atk;
  gr.state.research.levels.w_atk = 10;
  gr.research.invalidate();
  const atk5 = gr.survivors.stats(gr.survivors.leader()).atk;
  assert(atk5 > atk0 * 1.15, `科技等級越高效果越大（攻擊 ${atk0} → ${atk5}）`);
  Object.keys(gr.state.resources).forEach((k) => { gr.state.resources[k] = 1e7; });
  gr.state.player.coins = 1e7;
  gr.state.player.parts = 1e4;
  assert(!gr.research.canStart('w_crit').ok, '沒有研究中心不能研究');
  gr.shelter.primary().facilities.researchCenter.level = 1;
  assert(gr.research.start('w_crit').ok, '開始研究 Lv1');
  gr.research.update(Date.now() + 1e9);
  assert(gr.research.level('w_crit') === 1, '研究完成升到 Lv1');
  assert(!gr.research.canStart('w_crit').ok, '第 2 級需要研究中心 Lv2');
  assert(!gr.shelter.isDefenseUnlocked('machineGun'), '未研究不能建機槍塔');
  gr.state.research.levels.d_mg = 1;
  gr.research.invalidate();
  assert(gr.shelter.isDefenseUnlocked('machineGun'), '研究「機槍塔」解鎖機槍塔');
  // 舊研究遷移
  const old = JSON.parse(JSON.stringify(gr.state));
  old.version = 6;
  old.research = { completed: ['wpn1', 'def1', 'srv1'], active: { id: 'wpn2', startAt: 0, endAt: 1 } };
  const mig = SaveManager.migrate(old);
  assert(mig.research.levels.w_atk === 3 && mig.research.levels.d_mg === 1 && mig.research.levels.s_scout === 3 && !mig.research.active, '舊研究轉換為新科技等級');

  // 招募品級機率
  const so0 = survivorRarityTable(0);
  const so10 = survivorRarityTable(10);
  assert(so0.legendary === 0 && Math.abs(so0.epic - 0.1) < 1e-9, '倖存者初始稀有 0%、罕見 0.1%');
  assert(Math.abs(so10.legendary - 0.2) < 1e-9 && Math.abs(Object.values(so10).reduce((a2, b2) => a2 + b2, 0) - 100) < 1e-9, '招募技術滿級稀有 0.2%');
  gr.survivors.updateBoard(Date.now());
  assert(gr.state.recruitBoard.list.length === 2, '固定出現兩位可招募的倖存者');
  const firstIds = gr.state.recruitBoard.list.map((c) => c.id).join();
  gr.survivors.updateBoard(Date.now() + 1000);
  assert(gr.state.recruitBoard.list.map((c) => c.id).join() === firstIds, '一小時內名單不變');
  gr.survivors.updateBoard(Date.now() + 3600e3 + 1000);
  assert(gr.state.recruitBoard.list.map((c) => c.id).join() !== firstIds, '每小時更新名單');
  const n0 = gr.state.survivors.length;
  assert(gr.survivors.hireFromBoard(gr.state.recruitBoard.list[0].id).ok && gr.state.survivors.length === n0 + 1, '招募固定出現的倖存者');
  const legends = Array.from({ length: 3000 }, () => gr.survivors.rollRarity()).filter((r) => r === 'legendary').length;
  assert(legends === 0, '初始不會招募到稀有倖存者');

  // 裝備型號
  const byType = {};
  Object.values(ITEM_MODELS).forEach((md) => { byType[md.type] = (byType[md.type] || 0) + 1; });
  const meleeNames = Object.values(ITEM_MODELS).filter((md) => md.type === 'melee').map((md) => md.name);
  assert(['拳套', '小刀', '菜刀', '球棒', '水管', '鐵鍬', '開山刀', '斧頭', '武士刀', '電鋸'].every((n) => meleeNames.includes(n)), '近戰武器 10 種');
  assert(['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'lmg', 'crossbow'].every((t) => byType[t] >= 10), `槍類各至少 10 種（${['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'lmg'].map((t) => byType[t]).join('/')}）`);
  assert(['helmet', 'armor', 'legs', 'gloves', 'boots'].every((t) => byType[t] >= 10), '頭盔、衣服、護腿、手套、鞋子各至少 10 種');
  assert(byType.backpack === 7, '背包 7 種大小');
  const lowDrops = Array.from({ length: 400 }, () => gr.equipment.generate({ level: 1, type: 'rifle' }).tier);
  const highDrops = Array.from({ length: 400 }, () => gr.equipment.generate({ level: 45, type: 'rifle' }).tier);
  const avg = (a2) => a2.reduce((x, y) => x + y, 0) / a2.length;
  assert(avg(lowDrops) < avg(highDrops) && lowDrops.filter((t) => t >= 9).length < 8, `越強的型號越難取得（低等平均 T${avg(lowDrops).toFixed(1)}、高等平均 T${avg(highDrops).toFixed(1)}）`);
  // 製作
  assert(craftRarityTable(0).legendary === 0 && Math.abs(craftRarityTable(0).epic - 0.1) < 1e-9 && Math.abs(craftRarityTable(10).legendary - 0.2) < 1e-9, '製作初始稀有 0%、罕見 0.1%，滿級稀有 0.2%');
  const eq = gr.equipment;
  assert(eq.canCraftModel('knuckles').ok && eq.workbench() === 0, '簡易製作不需要工作台');
  assert(!eq.canCraftModel('bat').ok, '其他裝備需要工作台');
  gr.shelter.primary().facilities.workbench.level = 3;
  assert(eq.canCraftModel('bat').ok && !eq.canCraftModel('machete').ok, '工作台等級越高可製作的型號越多');
  assert(!eq.canCraftModel('revolver').ok, '槍械需要研究「槍械製造」');
  gr.state.research.levels.c_gun = 1;
  gr.research.invalidate();
  assert(eq.canCraftModel('revolver').ok && !eq.canCraftModel('uzi').ok, '槍械製造等級決定可製作的槍種');
  const made = Array.from({ length: 2000 }, () => eq.craft('knife').item.rarity);
  assert(!made.includes('legendary'), '製作技術 0 級時不會做出稀有裝備');
  // 背包增加運載量、電鋸耗油
  const lead = gr.survivors.leader();
  const cargo0 = gr.vehicles.tripStats([lead], []).cargo;
  const pack = eq.generate({ level: 5, model: 'pack3', rarity: 'common' });
  eq.addItem(pack);
  eq.equip(lead.id, pack.id);
  assert(gr.vehicles.tripStats([lead], []).cargo > cargo0 + 100, '背包越大運載量越多');
  const saw = eq.generate({ level: 5, model: 'chainsaw', rarity: 'common' });
  eq.addItem(saw);
  eq.equip(lead.id, saw.id);
  gr.state.resources.fuel = 10;
  gr.combat.simulate([lead], [gr.combat.createEnemy('walker', 1)]);
  assert(gr.state.resources.fuel === 7, '電鋸每場戰鬥消耗燃料');
  // 圍牆不會自行修復，需修繕人員並消耗資源
  const home = gr.shelter.primary();
  home.wallHp = 100;
  lead.job = 'idle';
  gr.state.survivors.forEach((x) => { x.job = 'idle'; });
  gr.shelter.update(Date.now(), 60000);
  assert(Math.round(gr.shelter.wallHp(home)) === 100, '沒有修繕人員時圍牆不會恢復');
  lead.job = 'repair';
  const wood0 = gr.state.resources.wood;
  gr.shelter.update(Date.now(), 60000);
  assert(gr.shelter.wallHp(home) > 100 && gr.state.resources.wood < wood0, '修繕人員修理圍牆並消耗木材');
  gr.state.resources.wood = 0;
  const hpNow = gr.shelter.wallHp(home);
  gr.shelter.update(Date.now(), 60000);
  assert(gr.shelter.wallHp(home) === hpNow, '材料不足時無法修繕');
}

// ---- 12. v6：即時存檔防重讀、突破、招募費、探索時間、背包倉庫 ----
{
  const gs = Game.newGame({ playerName: 'S', classId: 'scout', lat: 25.03, lon: 121.56 });
  gs.state.map.pois = fillPois([], 25.03, 121.56);
  gs.shelter.establish(gs.state.map.pois[0]);
  Object.keys(gs.state.resources).forEach((k) => { gs.state.resources[k] = 1e5; });
  gs.state.player.coins = 1e6;
  // 固定種子：讀回同一份存檔，製作結果相同（無法靠重新讀檔刷結果）
  const snap = JSON.parse(JSON.stringify(SaveManager.pack(gs.state)));
  const a1 = gs.equipment.craft('knife').item;
  const gs2 = new Game(SaveManager.migrate(JSON.parse(JSON.stringify(snap))));
  const a2 = gs2.equipment.craft('knife').item;
  assert(a1.rarity === a2.rarity && JSON.stringify(a1.stats) === JSON.stringify(a2.stats) && a1.name === a2.name, '重新讀檔後製作結果相同（種子隨存檔保存）');
  const b1 = gs.equipment.craft('knife').item;
  assert(JSON.stringify(b1.stats) !== JSON.stringify(a1.stats) || b1.rarity !== a1.rarity || b1.name !== a1.name, '連續製作結果仍然隨機');
  const r1 = gs.survivors.recruitRoll().offer.map((c) => `${c.rarity}${c.classId}${c.level}`).join();
  const gs3 = new Game(SaveManager.migrate(JSON.parse(JSON.stringify(snap))));
  gs3.equipment.craft('knife');
  const r3 = gs3.survivors.recruitRoll().offer.map((c) => `${c.rarity}${c.classId}${c.level}`).join();
  assert(r1 === r3, '重新讀檔後招募候選人相同');
  // 即時存檔：主存檔不含地圖建築，體積小；建築另存
  const main = JSON.stringify(SaveManager.packMain(gs.state));
  const full = JSON.stringify(SaveManager.pack(gs.state));
  assert(main.length < full.length && !main.includes('poiPack'), `即時存檔不含地圖建築（${Math.round(main.length / 1024)}KB / 完整 ${Math.round(full.length / 1024)}KB）`);
  gs.state.map.pois[3].lootedDay = 99999;
  const back = SaveManager.mergeMap(SaveManager.migrate(JSON.parse(JSON.stringify(SaveManager.packMain(gs.state)))), JSON.parse(JSON.stringify(SaveManager.packMap(gs.state))));
  assert(back.map.pois.length === gs.state.map.pois.length && back.map.pois[3].lootedDay === 99999, '主存檔＋建築清單合併後還原搜刮紀錄');
  let saves = 0;
  gs.bus.on('game:save', () => { saves += 1; });
  gs.started = true;
  gs.log('測試事件');
  await new Promise((r) => setTimeout(r, 0));
  assert(saves >= 1, '任何事件都會立即存檔');

  // 招募需要額外支付金錢
  gs.survivors.updateBoard(Date.now());
  const cand = gs.state.recruitBoard.list[0];
  const fee = gs.survivors.hireCost(cand).coins;
  const coins0 = gs.state.player.coins;
  assert(fee > 0 && gs.survivors.hireFromBoard(cand.id).ok && gs.state.player.coins === coins0 - fee, `附近的倖存者需支付雇用費（💰${fee}）`);
  const offer = gs.survivors.recruitRoll().offer;
  const coins1 = gs.state.player.coins;
  gs.survivors.pickRecruit(offer[0].id);
  assert(gs.state.player.coins === coins1 - gs.survivors.hireCost(offer[0]).coins, '廣播招募選擇後也要支付雇用費');

  // 探索時間依地點大小與危險度
  const { baseSizeOf } = await import('../src/config/civilization.js');
  const huge = gs.state.map.pois.find((p) => baseSizeOf(p) === 'huge');
  const smallP = gs.state.map.pois.find((p) => baseSizeOf(p) === 'small');
  const mins = gs.state.map.pois.map((p) => gs.exploration.searchMinutes(p));
  assert(Math.max(...mins) <= 30 && gs.exploration.searchMinutes(huge) > gs.exploration.searchMinutes(smallP), `搜索時間依大小與危險度（最長 ${Math.max(...mins)} 分鐘）`);
  const lead = gs.survivors.leader();
  Object.assign(lead, { status: 'idle', severe: false, hp: null });
  const ex = gs.exploration.start(huge.id, ['leader'], 60);
  assert(ex.ok && ex.exp.durationMin === gs.exploration.searchMinutes(huge), '派遣探索不再選擇時長，由地點決定');
  gs.exploration.recall(ex.exp.id);

  // 個人背包與倉庫
  gs.state.resources.food = 500;
  assert(gs.survivors.withdraw('leader', 'food', 30).ok && lead.bag.food === 30 && gs.state.resources.food === 470, '從倉庫取出放進背包');
  assert(gs.survivors.withdraw('leader', 'food', 1e6).n === gs.survivors.bagCap(lead) - 30, '背包受負重上限限制');
  assert(gs.survivors.deposit('leader', 'food', 10).ok && gs.survivors.carried('food') === gs.survivors.bagCap(lead) - 10, '背包存入倉庫，總量含隊員攜帶');
  lead.status = 'exploring';
  assert(!gs.survivors.deposit('leader', 'food', 1).ok, '不在避難所無法存取倉庫');
  lead.status = 'idle';
  lead.bag = {};
  const lost = gs.survivors.stash([lead], { wood: 10000 });
  assert(lead.bag.wood === gs.survivors.bagCap(lead) && lost === 10000 - gs.survivors.bagCap(lead), '倉庫放不下的探索物資由隊員背包攜帶');

  // 重新掃描包含前哨站附近（較小範圍）
  gs.state.research.levels.e_outpost = 1;
  gs.research.invalidate();
  gs.shelter.establish(gs.state.map.pois.find((p) => !gs.shelter.baseAtPoi(p.id)));
  const areas = gs.scanAreas(25.03, 121.56);
  assert(areas.length === 2 && areas[1].radius < areas[0].radius, '重新掃描包含前哨站附近，範圍較小');
}

// ---- 5. 通行碼雜湊（純 JS SHA-256 與 Node crypto 結果一致）----
let ref = 'jdqs-gate:密碼 test';
for (let i = 0; i < ACCESS_ITERATIONS; i += 1) ref = crypto.createHash('sha256').update(ref).digest('hex');
assert(hashAccessCode('  密碼 test ') === ref, '通行碼雜湊與 Node crypto 一致（並忽略前後空白）');

if (failures) {
  console.error(`\n${failures} 項檢查失敗`);
  process.exit(1);
}
console.log(`✓ 全部通過（擊殺 ${g.state.stats.siegeKills}，探索事件 ${reports[0].events.length}）`);
