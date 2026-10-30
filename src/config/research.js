/**
 * 研究樹。tier 決定需要的研究中心等級（tier n 需 Lv n*2-1）。
 * effects 為累加型數值或解鎖旗標：
 *  - atkPct, critAdd, critDmgAdd, hpPct, defPct：全隊戰鬥加成
 *  - wallHpPct, towerDmgPct：防禦加成
 *  - foodPct, medicinePerHour, fuelPerHour, storagePct：生產加成
 *  - exploreSpeed, lootPct, nightPenaltyReduce, injuryReduce
 * *  - outposts：可建立的前哨站數量
 *  - unlock: ['autoExplore'|...]：新功能
 */
export const RESEARCH_BRANCHES = {
  weapons: { name: '武器科技', icon: '🔫' },
  defense: { name: '防禦科技', icon: '🛡️' },
  medical: { name: '醫療科技', icon: '💉' },
  agriculture: { name: '農業科技', icon: '🌾' },
  survival: { name: '生存科技', icon: '🧭' },
  expansion: { name: '擴張科技', icon: '🏴' },
};

export const RESEARCH = {
  // 武器
  wpn1: { branch: 'weapons', tier: 1, name: '改良槍管', desc: '攻擊 +10%，解鎖步槍、衝鋒槍製作', cost: { metal: 120, wood: 60 }, time: 60, effects: { atkPct: 0.1 } },
  wpn2: { branch: 'weapons', tier: 2, name: '霰彈工藝', desc: '暴擊率 +5%，解鎖散彈槍製作', cost: { metal: 260, fuel: 60, parts: 2 }, time: 180, requires: ['wpn1'], effects: { critAdd: 0.05 } },
  wpn3: { branch: 'weapons', tier: 3, name: '精準射擊', desc: '暴擊傷害 +25%，解鎖狙擊槍製作', cost: { metal: 520, fuel: 120, parts: 6 }, time: 420, requires: ['wpn2'], effects: { critDmgAdd: 0.25 } },
  wpn4: { branch: 'weapons', tier: 4, name: '穿甲彈', desc: '攻擊 +20%，解鎖輕機槍製作', cost: { metal: 1100, fuel: 260, parts: 15 }, time: 900, requires: ['wpn3'], effects: { atkPct: 0.2 } },
  // 防禦
  def1: { branch: 'defense', tier: 1, name: '加固工事', desc: '圍牆耐久 +20%，解鎖機槍塔', cost: { wood: 150, metal: 100 }, time: 60, effects: { wallHpPct: 0.2 } },
  def2: { branch: 'defense', tier: 2, name: '燃燒劑', desc: '解鎖火焰塔', cost: { metal: 250, fuel: 120, parts: 2 }, time: 180, requires: ['def1'], effects: {} },
  def3: { branch: 'defense', tier: 3, name: '電磁學', desc: '解鎖電磁塔', cost: { metal: 500, fuel: 150, parts: 6 }, time: 420, requires: ['def2'], effects: {} },
  def4: { branch: 'defense', tier: 4, name: '自動化防禦', desc: '防禦塔傷害 +25%，圍牆 +20%', cost: { metal: 1000, fuel: 300, parts: 15 }, time: 900, requires: ['def3'], effects: { towerDmgPct: 0.25, wallHpPct: 0.2 } },
  // 醫療
  med1: { branch: 'medical', tier: 1, name: '急救訓練', desc: '受傷恢復時間 -30%', cost: { cloth: 100, medicine: 20 }, time: 60, effects: { injuryReduce: 0.3 } },
  med2: { branch: 'medical', tier: 2, name: '草藥學', desc: '藥品 +1/時', cost: { cloth: 200, medicine: 50, food: 150 }, time: 180, requires: ['med1'], effects: { medicinePerHour: 1 } },
  med3: { branch: 'medical', tier: 3, name: '戰地醫療', desc: '全隊生命 +15%', cost: { cloth: 400, medicine: 120, parts: 4 }, time: 420, requires: ['med2'], effects: { hpPct: 0.15 } },
  med4: { branch: 'medical', tier: 4, name: '抗病毒血清', desc: '受傷恢復 -40%，生命 +10%', cost: { medicine: 300, parts: 12, metal: 400 }, time: 900, requires: ['med3'], effects: { injuryReduce: 0.4, hpPct: 0.1 } },
  // 農業
  agr1: { branch: 'agriculture', tier: 1, name: '輪作', desc: '食物 +15%', cost: { food: 120, wood: 80 }, time: 60, effects: { foodPct: 0.15 } },
  agr2: { branch: 'agriculture', tier: 2, name: '滴灌', desc: '食物 +20%', cost: { food: 250, wood: 150, metal: 80 }, time: 180, requires: ['agr1'], effects: { foodPct: 0.2 } },
  agr3: { branch: 'agriculture', tier: 3, name: '生質燃料', desc: '燃料 +3/時', cost: { food: 500, metal: 200, parts: 4 }, time: 420, requires: ['agr2'], effects: { fuelPerHour: 3 } },
  agr4: { branch: 'agriculture', tier: 4, name: '溫室', desc: '食物 +40%', cost: { food: 900, metal: 500, parts: 10 }, time: 900, requires: ['agr3'], effects: { foodPct: 0.4 } },
  // 生存
  srv1: { branch: 'survival', tier: 1, name: '斥候訓練', desc: '探索時間 -15%，解鎖「自動探索」', cost: { food: 100, cloth: 60 }, time: 60, effects: { exploreSpeed: 0.15, unlock: ['autoExplore'] } },
  srv2: { branch: 'survival', tier: 2, name: '拾荒技巧', desc: '探索物資 +25%', cost: { food: 200, cloth: 150, fuel: 40 }, time: 180, requires: ['srv1'], effects: { lootPct: 0.25 } },
  srv3: { branch: 'survival', tier: 3, name: '夜行者', desc: '夜間探索懲罰 -60%，解鎖「離線防守收益」', cost: { cloth: 350, fuel: 120, parts: 5 }, time: 420, requires: ['srv2'], effects: { nightPenaltyReduce: 0.6, unlock: ['offlineDefense'] } },
  // 擴張：每一階可多建一座前哨站（只有防禦功能）
  out1: { branch: 'expansion', tier: 1, name: '前哨站', desc: '可建立 1 座前哨站（只有防禦功能，不能生產）', cost: { wood: 300, metal: 200, cloth: 100 }, time: 120, effects: { outposts: 1 } },
  out2: { branch: 'expansion', tier: 2, name: '前哨網路', desc: '前哨站上限 +1（共 2 座）', cost: { wood: 700, metal: 500, fuel: 150, parts: 5 }, time: 360, requires: ['out1'], effects: { outposts: 1 } },
  out3: { branch: 'expansion', tier: 3, name: '防線聯盟', desc: '前哨站上限 +1（共 3 座）', cost: { wood: 1400, metal: 1000, fuel: 300, parts: 12 }, time: 720, requires: ['out2'], effects: { outposts: 1 } },
  srv4: { branch: 'survival', tier: 4, name: '物資管理', desc: '資源上限 +40%', cost: { wood: 800, metal: 600, parts: 12 }, time: 900, requires: ['srv3'], effects: { storagePct: 0.4 } },
};

export const requiredLabLevel = (tier) => tier * 2 - 1;
