/**
 * 任務與成就。
 * 條件 (cond) 類型：
 *  - { type: 'shelterSet' }
 *  - { type: 'facility', id, value }      設施等級
 *  - { type: 'stat', key, value }          累計統計
 *  - { type: 'survivors', value }          倖存者人數
 *  - { type: 'defenses', value }           防禦建築數量
 *  - { type: 'research', value }           科技總等級
 *  - { type: 'bases', value }              據點數量
 *  - { type: 'civilization', value }       目前文明度
 * 每日任務使用 { type: 'statDelta', key, value }：自每日重置起的增量。
 */
export const MAIN_QUESTS = [
  { id: 'm1', name: '落腳之處', desc: '在地圖上選擇一棟建築作為避難所', cond: { type: 'shelterSet' }, reward: { coins: 50, food: 100 } },
  { id: 'm2', name: '第一次出擊', desc: '完成 1 次探索', cond: { type: 'stat', key: 'explorations', value: 1 }, reward: { coins: 60, wood: 100 } },
  { id: 'm3', name: '自給自足', desc: '將農場升到 Lv2', cond: { type: 'facility', id: 'farm', value: 2 }, reward: { coins: 80, nail: 30, screw: 30, ironWire: 15 } },
  { id: 'm4', name: '人多力量大', desc: '擁有 2 名以上倖存者', cond: { type: 'survivors', value: 2 }, reward: { coins: 80, bandage: 5, gauze: 5 } },
  { id: 'm4b', name: '急救訓練', desc: '使用藥品治療隊員 1 次', cond: { type: 'stat', key: 'healed', value: 1 }, reward: { coins: 60, bandage: 5, painkiller: 2 } },
  { id: 'm5', name: '築起防線', desc: '建造 1 座防禦建築', cond: { type: 'defenses', value: 1 }, reward: { coins: 100, bolt: 20, rubber: 10, scrap: 30 } },
  { id: 'm5b', name: '箭在弦上', desc: '製作 1 批彈藥或箭矢', cond: { type: 'stat', key: 'ammoCrafted', value: 1 }, reward: { coins: 80, arrow: 30, nail: 20 } },
  { id: 'm6', name: '清理街道', desc: '累計擊殺 30 隻殭屍', cond: { type: 'stat', key: 'kills', value: 30 }, reward: { coins: 150, parts: 2 } },
  { id: 'm7', name: '知識就是力量', desc: '建造研究中心', cond: { type: 'facility', id: 'researchCenter', value: 1 }, reward: { coins: 150, wire: 20, bulb: 15, tape: 15, linen: 15 } },
  { id: 'm8', name: '科學家', desc: '完成 1 個科技等級', cond: { type: 'research', value: 1 }, reward: { coins: 200, parts: 3 } },
  { id: 'm9', name: '精良裝備', desc: '獲得 1 件精良（藍色）以上的裝備', cond: { type: 'stat', key: 'rareItems', value: 1 }, reward: { coins: 200, fuel: 100 } },
  { id: 'm9b', name: '每日勤務', desc: '開啟 1 個每日物資箱（完成當天全部每日任務）', cond: { type: 'stat', key: 'chestsOpened', value: 1 }, reward: { coins: 200, ironPlate: 10, techCotton: 5 } },
  { id: 'm10', name: '銅牆鐵壁', desc: '將圍牆升到 Lv5', cond: { type: 'facility', id: 'wall', value: 5 }, reward: { coins: 300, parts: 5 } },
  { id: 'm11', name: '屠龍者', desc: '擊敗 1 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 1 }, reward: { coins: 500, parts: 8, item: 'epic' } },
  { id: 'm11b', name: '攔路虎', desc: '攔截並擊敗 1 支野外隊伍（NPC 或其他玩家）', cond: { type: 'stat', key: 'intercepts', value: 1 }, reward: { coins: 400, ammo9: 60, smallKit: 2 } },
  { id: 'm12', name: '一週生還', desc: '存活 7 天', cond: { type: 'stat', key: 'daysSurvived', value: 7 }, reward: { coins: 600, parts: 10 } },
  { id: 'm12b', name: '開疆拓土', desc: '擁有 2 個據點', cond: { type: 'bases', value: 2 }, reward: { coins: 600, wood: 400, ironPlate: 20, hinge: 15, rebar: 15 } },
  { id: 'm12c', name: '文明的火種', desc: '文明度達到 200（城鎮）', cond: { type: 'civilization', value: 200 }, reward: { coins: 800, parts: 12 } },
  { id: 'm13', name: '重建文明', desc: '科技總等級達 30', cond: { type: 'research', value: 30 }, reward: { coins: 1500, parts: 25, item: 'legendary' } },
];

export const DAILY_POOL = [
  { id: 'd_kill', name: '日常清剿', desc: '擊殺 25 隻殭屍', cond: { type: 'statDelta', key: 'kills', value: 25 }, reward: { coins: 80, parts: 1 } },
  { id: 'd_explore', name: '日常搜索', desc: '完成 3 次探索', cond: { type: 'statDelta', key: 'explorations', value: 3 }, reward: { coins: 80, food: 120 } },
  { id: 'd_build', name: '日常修繕', desc: '完成 2 次建築升級', cond: { type: 'statDelta', key: 'upgrades', value: 2 }, reward: { coins: 60, wood: 150 } },
  { id: 'd_battle', name: '日常戰鬥', desc: '在地圖上贏得 2 場戰鬥', cond: { type: 'statDelta', key: 'battlesWon', value: 2 }, reward: { coins: 100, scrap: 20, nail: 20, ammo9: 20 } },
  { id: 'd_craft', name: '日常製作', desc: '製作 1 件裝備', cond: { type: 'statDelta', key: 'crafted', value: 1 }, reward: { coins: 60, coarse: 15, cotton: 15 } },
  { id: 'd_items', name: '日常尋寶', desc: '獲得 3 件裝備', cond: { type: 'statDelta', key: 'itemsFound', value: 3 }, reward: { coins: 90, fuel: 60 } },
  { id: 'd_heal', name: '日常醫護', desc: '使用藥品治療 2 次', cond: { type: 'statDelta', key: 'healed', value: 2 }, reward: { coins: 60, gauze: 4, vitamin: 3 } },
  { id: 'd_ammo', name: '日常軍火', desc: '製作 2 批彈藥或箭矢', cond: { type: 'statDelta', key: 'ammoCrafted', value: 2 }, reward: { coins: 70, scrap: 15, spring: 3 } },
  { id: 'd_forest', name: '日常伐木', desc: '探索樹林 1 次', cond: { type: 'statDelta', key: 'forestVisits', value: 1 }, reward: { coins: 50, wood: 200 } },
  { id: 'd_research', name: '日常研究', desc: '完成 1 個科技等級', cond: { type: 'statDelta', key: 'researchDone', value: 1 }, reward: { coins: 90, wire: 8, battery: 2 } },
  { id: 'd_defend', name: '日常守夜', desc: '防禦塔擊殺 15 隻殭屍', cond: { type: 'statDelta', key: 'siegeKills', value: 15 }, reward: { coins: 80, bandage: 4, arrow: 20 } },
];
export const DAILY_COUNT = 4;

/**
 * 每日物資箱：當天全部每日任務都領取後可開啟一次。
 * 開出 3～5 項隨機物品；材料越高階、裝備品級越高，出現機率越低。
 */
export const DAILY_CHEST = {
  rolls: [3, 5],
  kinds: { supply: 70, gear: 24, blueprint: 6 },
  /** 裝備品級權重（越高越稀有） */
  gearRarity: {
    poor: 30, common: 34, uncommon: 22, rare: 10, epic: 2, legendary: 0.2,
  },
};

export const ACHIEVEMENTS = [
  { id: 'a_kill100', name: '殭屍獵人', desc: '擊殺 100 隻殭屍', cond: { type: 'stat', key: 'kills', value: 100 }, reward: { coins: 200 } },
  { id: 'a_kill1000', name: '屠戮者', desc: '擊殺 1,000 隻殭屍', cond: { type: 'stat', key: 'kills', value: 1000 }, reward: { coins: 1000, parts: 10 } },
  { id: 'a_kill10000', name: '末日死神', desc: '擊殺 10,000 隻殭屍', cond: { type: 'stat', key: 'kills', value: 10000 }, reward: { coins: 5000, parts: 50 } },
  { id: 'a_exp10', name: '拾荒者', desc: '完成 10 次探索', cond: { type: 'stat', key: 'explorations', value: 10 }, reward: { coins: 200 } },
  { id: 'a_exp100', name: '廢土行者', desc: '完成 100 次探索', cond: { type: 'stat', key: 'explorations', value: 100 }, reward: { coins: 1500, parts: 15 } },
  { id: 'a_boss1', name: '巨人殺手', desc: '擊敗 1 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 1 }, reward: { coins: 300 } },
  { id: 'a_boss10', name: '傳奇獵手', desc: '擊敗 10 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 10 }, reward: { coins: 2000, item: 'legendary' } },
  { id: 'a_legend', name: '天選之人', desc: '獲得 1 件稀有（橘色）裝備', cond: { type: 'stat', key: 'legendaryItems', value: 1 }, reward: { coins: 500, parts: 10 } },
  { id: 'a_day10', name: '老練倖存者', desc: '存活 10 天', cond: { type: 'stat', key: 'daysSurvived', value: 10 }, reward: { coins: 500 } },
  { id: 'a_day30', name: '末日之王', desc: '存活 30 天', cond: { type: 'stat', key: 'daysSurvived', value: 30 }, reward: { coins: 3000, parts: 30 } },
  { id: 'a_team5', name: '小隊成形', desc: '擁有 5 名倖存者', cond: { type: 'survivors', value: 5 }, reward: { coins: 300 } },
  { id: 'a_team10', name: '倖存者聯盟', desc: '擁有 10 名倖存者', cond: { type: 'survivors', value: 10 }, reward: { coins: 1500, parts: 10 } },
  { id: 'a_research', name: '末日學者', desc: '科技總等級達 200', cond: { type: 'research', value: 200 }, reward: { coins: 5000, item: 'legendary' } },
  { id: 'a_civ100', name: '聚落成形', desc: '文明度達到 100', cond: { type: 'civilization', value: 100 }, reward: { coins: 300 } },
  { id: 'a_civ550', name: '新文明', desc: '文明度達到 550', cond: { type: 'civilization', value: 550 }, reward: { coins: 5000, item: 'legendary' } },
  { id: 'a_bases5', name: '據點網路', desc: '擁有 5 個據點', cond: { type: 'bases', value: 5 }, reward: { coins: 2000, parts: 20 } },
  { id: 'a_heal50', name: '戰地醫師', desc: '使用藥品治療 50 次', cond: { type: 'stat', key: 'healed', value: 50 }, reward: { coins: 800, mediumKit: 3 } },
  { id: 'a_ammo20', name: '軍火工匠', desc: '製作 20 批彈藥或箭矢', cond: { type: 'stat', key: 'ammoCrafted', value: 20 }, reward: { coins: 800, firingPin: 10, barrel: 2 } },
  { id: 'a_icpt5', name: '荒野獵人', desc: '攔截並擊敗 5 支野外隊伍', cond: { type: 'stat', key: 'intercepts', value: 5 }, reward: { coins: 1000, item: 'rare' } },
  { id: 'a_icpt30', name: '公路之王', desc: '攔截並擊敗 30 支野外隊伍', cond: { type: 'stat', key: 'intercepts', value: 30 }, reward: { coins: 4000, item: 'epic' } },
  { id: 'a_chest7', name: '勤勞的一週', desc: '開啟 7 個每日物資箱', cond: { type: 'stat', key: 'chestsOpened', value: 7 }, reward: { coins: 1000, largeKit: 1 } },
  { id: 'a_chest30', name: '全勤獎', desc: '開啟 30 個每日物資箱', cond: { type: 'stat', key: 'chestsOpened', value: 30 }, reward: { coins: 5000, item: 'legendary' } },
  { id: 'a_craft50', name: '工匠', desc: '製作 50 件裝備', cond: { type: 'stat', key: 'crafted', value: 50 }, reward: { coins: 1500, precision: 3 } },
  { id: 'a_rare10', name: '收藏家', desc: '獲得 10 件精良以上的裝備', cond: { type: 'stat', key: 'rareItems', value: 10 }, reward: { coins: 1000, parts: 10 } },
  { id: 'a_forest20', name: '伐木工', desc: '探索樹林 20 次', cond: { type: 'stat', key: 'forestVisits', value: 20 }, reward: { coins: 600, wood: 1500 } },
  { id: 'a_won100', name: '百戰百勝', desc: '贏得 100 場戰鬥', cond: { type: 'stat', key: 'battlesWon', value: 100 }, reward: { coins: 2000, item: 'epic' } },
  { id: 'a_upg100', name: '建築大師', desc: '完成 100 次建築升級', cond: { type: 'stat', key: 'upgrades', value: 100 }, reward: { coins: 3000, titanium: 5 } },
  { id: 'a_day60', name: '不朽', desc: '存活 60 天', cond: { type: 'stat', key: 'daysSurvived', value: 60 }, reward: { coins: 8000, item: 'legendary' } },
  { id: 'a_breach', name: '浴火重生', desc: '避難所首次被突破後存活', cond: { type: 'stat', key: 'breaches', value: 1 }, reward: { coins: 100, wood: 300 } },
];
