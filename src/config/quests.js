/**
 * 任務與成就。
 * 條件 (cond) 類型：
 *  - { type: 'shelterSet' }
 *  - { type: 'facility', id, value }      設施等級
 *  - { type: 'stat', key, value }          累計統計
 *  - { type: 'survivors', value }          倖存者人數
 *  - { type: 'defenses', value }           防禦建築數量
 *  - { type: 'research', value }           完成研究數
 *  - { type: 'bases', value }              據點數量
 *  - { type: 'civilization', value }       目前文明度
 * 每日任務使用 { type: 'statDelta', key, value }：自每日重置起的增量。
 */
export const MAIN_QUESTS = [
  { id: 'm1', name: '落腳之處', desc: '在地圖上選擇一棟建築作為避難所', cond: { type: 'shelterSet' }, reward: { coins: 50, food: 100 } },
  { id: 'm2', name: '第一次出擊', desc: '完成 1 次探索', cond: { type: 'stat', key: 'explorations', value: 1 }, reward: { coins: 60, wood: 100 } },
  { id: 'm3', name: '自給自足', desc: '將農場升到 Lv2', cond: { type: 'facility', id: 'farm', value: 2 }, reward: { coins: 80, metal: 80 } },
  { id: 'm4', name: '人多力量大', desc: '擁有 2 名以上倖存者', cond: { type: 'survivors', value: 2 }, reward: { coins: 80, medicine: 20 } },
  { id: 'm5', name: '築起防線', desc: '建造 1 座防禦建築', cond: { type: 'defenses', value: 1 }, reward: { coins: 100, metal: 120 } },
  { id: 'm6', name: '清理街道', desc: '累計擊殺 30 隻殭屍', cond: { type: 'stat', key: 'kills', value: 30 }, reward: { coins: 150, parts: 2 } },
  { id: 'm7', name: '知識就是力量', desc: '建造研究中心', cond: { type: 'facility', id: 'researchCenter', value: 1 }, reward: { coins: 150, cloth: 120 } },
  { id: 'm8', name: '科學家', desc: '完成 1 項研究', cond: { type: 'research', value: 1 }, reward: { coins: 200, parts: 3 } },
  { id: 'm9', name: '精良裝備', desc: '獲得 1 件稀有以上的裝備', cond: { type: 'stat', key: 'rareItems', value: 1 }, reward: { coins: 200, fuel: 100 } },
  { id: 'm10', name: '銅牆鐵壁', desc: '將圍牆升到 Lv5', cond: { type: 'facility', id: 'wall', value: 5 }, reward: { coins: 300, parts: 5 } },
  { id: 'm11', name: '屠龍者', desc: '擊敗 1 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 1 }, reward: { coins: 500, parts: 8, item: 'epic' } },
  { id: 'm12', name: '一週生還', desc: '存活 7 天', cond: { type: 'stat', key: 'daysSurvived', value: 7 }, reward: { coins: 600, parts: 10 } },
  { id: 'm12b', name: '開疆拓土', desc: '擁有 2 個據點', cond: { type: 'bases', value: 2 }, reward: { coins: 600, wood: 400, metal: 300 } },
  { id: 'm12c', name: '文明的火種', desc: '文明度達到 200（城鎮）', cond: { type: 'civilization', value: 200 }, reward: { coins: 800, parts: 12 } },
  { id: 'm13', name: '重建文明', desc: '完成 12 項研究', cond: { type: 'research', value: 12 }, reward: { coins: 1500, parts: 25, item: 'legendary' } },
];

export const DAILY_POOL = [
  { id: 'd_kill', name: '日常清剿', desc: '擊殺 25 隻殭屍', cond: { type: 'statDelta', key: 'kills', value: 25 }, reward: { coins: 80, parts: 1 } },
  { id: 'd_explore', name: '日常搜索', desc: '完成 3 次探索', cond: { type: 'statDelta', key: 'explorations', value: 3 }, reward: { coins: 80, food: 120 } },
  { id: 'd_build', name: '日常修繕', desc: '完成 2 次建築升級', cond: { type: 'statDelta', key: 'upgrades', value: 2 }, reward: { coins: 60, wood: 150 } },
  { id: 'd_battle', name: '日常戰鬥', desc: '在地圖上贏得 2 場戰鬥', cond: { type: 'statDelta', key: 'battlesWon', value: 2 }, reward: { coins: 100, metal: 100 } },
  { id: 'd_craft', name: '日常製作', desc: '製作 1 件裝備', cond: { type: 'statDelta', key: 'crafted', value: 1 }, reward: { coins: 60, cloth: 100 } },
  { id: 'd_items', name: '日常尋寶', desc: '獲得 3 件裝備', cond: { type: 'statDelta', key: 'itemsFound', value: 3 }, reward: { coins: 90, fuel: 60 } },
  { id: 'd_defend', name: '日常守夜', desc: '防禦塔擊殺 15 隻殭屍', cond: { type: 'statDelta', key: 'siegeKills', value: 15 }, reward: { coins: 80, medicine: 15 } },
];
export const DAILY_COUNT = 3;

export const ACHIEVEMENTS = [
  { id: 'a_kill100', name: '殭屍獵人', desc: '擊殺 100 隻殭屍', cond: { type: 'stat', key: 'kills', value: 100 }, reward: { coins: 200 } },
  { id: 'a_kill1000', name: '屠戮者', desc: '擊殺 1,000 隻殭屍', cond: { type: 'stat', key: 'kills', value: 1000 }, reward: { coins: 1000, parts: 10 } },
  { id: 'a_kill10000', name: '末日死神', desc: '擊殺 10,000 隻殭屍', cond: { type: 'stat', key: 'kills', value: 10000 }, reward: { coins: 5000, parts: 50 } },
  { id: 'a_exp10', name: '拾荒者', desc: '完成 10 次探索', cond: { type: 'stat', key: 'explorations', value: 10 }, reward: { coins: 200 } },
  { id: 'a_exp100', name: '廢土行者', desc: '完成 100 次探索', cond: { type: 'stat', key: 'explorations', value: 100 }, reward: { coins: 1500, parts: 15 } },
  { id: 'a_boss1', name: '巨人殺手', desc: '擊敗 1 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 1 }, reward: { coins: 300 } },
  { id: 'a_boss10', name: '傳奇獵手', desc: '擊敗 10 隻 Boss', cond: { type: 'stat', key: 'bossKills', value: 10 }, reward: { coins: 2000, item: 'legendary' } },
  { id: 'a_legend', name: '天選之人', desc: '獲得 1 件傳說裝備', cond: { type: 'stat', key: 'legendaryItems', value: 1 }, reward: { coins: 500, parts: 10 } },
  { id: 'a_day10', name: '老練倖存者', desc: '存活 10 天', cond: { type: 'stat', key: 'daysSurvived', value: 10 }, reward: { coins: 500 } },
  { id: 'a_day30', name: '末日之王', desc: '存活 30 天', cond: { type: 'stat', key: 'daysSurvived', value: 30 }, reward: { coins: 3000, parts: 30 } },
  { id: 'a_team5', name: '小隊成形', desc: '擁有 5 名倖存者', cond: { type: 'survivors', value: 5 }, reward: { coins: 300 } },
  { id: 'a_team10', name: '倖存者聯盟', desc: '擁有 10 名倖存者', cond: { type: 'survivors', value: 10 }, reward: { coins: 1500, parts: 10 } },
  { id: 'a_research', name: '末日學者', desc: '完成全部 20 項研究', cond: { type: 'research', value: 20 }, reward: { coins: 5000, item: 'legendary' } },
  { id: 'a_civ100', name: '聚落成形', desc: '文明度達到 100', cond: { type: 'civilization', value: 100 }, reward: { coins: 300 } },
  { id: 'a_civ550', name: '新文明', desc: '文明度達到 550', cond: { type: 'civilization', value: 550 }, reward: { coins: 5000, item: 'legendary' } },
  { id: 'a_bases5', name: '據點網路', desc: '擁有 5 個據點', cond: { type: 'bases', value: 5 }, reward: { coins: 2000, parts: 20 } },
  { id: 'a_breach', name: '浴火重生', desc: '避難所首次被突破後存活', cond: { type: 'stat', key: 'breaches', value: 1 }, reward: { coins: 100, wood: 300 } },
];
