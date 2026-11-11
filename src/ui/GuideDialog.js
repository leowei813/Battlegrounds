/**
 * 📖 遊戲說明：改版後第一次登入自動顯示，設定頁可以重複查看。
 * 內容：新地圖與控制點（v14）＋基本玩法。
 */

/** 說明的版本：內容大改時提高，讓所有人再看一次 */
export const GUIDE_VERSION = 15;

const TABS = [
  {
    id: 'new',
    name: '🆕 地圖與控制點',
    html: `<ol>
      <li><b>地圖分區</b>（v15 重劃、地圖縮小）：左邊最安全，越往右越危險：安全區 → 一般 → 警戒 → 危險 → 致死 → 深淵區。巨型、大型建築集中在致死區與深淵區，物資也最豐富。</li>
      <li><b>左側安全區</b>是玩家據點區，避難所只能建在這裡。左側的安全區與一般區可以自由探索。</li>
      <li><b>最右側</b>窄條是三大勢力（赤月、黑曜、冥府）的大本營領地，沒有可探索的建築，也不能攻打。</li>
      <li><b>控制點</b>：警戒區到深淵區分成多個範圍不規則的控制點。<b>先佔領控制點，才能探索該區域的建築</b>；自己或好友佔領的區域可以探索。<b>只能進攻和自己或好友控制點相鄰的控制點</b>，最西側一排隨時可以進攻。</li>
      <li><b>每日收益</b>：每天 06:00（遊戲時間），控制點會派運輸隊把少量資源與零件送回避難所。佔領者與駐守者都能拿，同一人只拿一份。</li>
      <li><b>駐防</b>：佔領者與佔領者的好友都可以駐防，每名玩家每個控制點最多 2 人，用來抵擋 NPC 進攻。</li>
      <li><b>集結</b>：可以對控制點發起集結，集結打下的控制點為參加者共同擁有；共同擁有者變成敵對時，該控制點回到中立。敵對關係的玩家可以互相攻打控制點。</li>
      <li><b>NPC 勢力</b>：只會攻打和自己相鄰的控制點，優先打沒人駐守的，打下後會留下一半守軍（現實每 10 分鐘補回 1 人）；最遠只會打到左側的警戒區。勢力進攻時會先派兵行軍（地圖上看得到部隊與剩餘時間），佔領者與駐防者會收到提醒。越靠近深淵區的守軍越強。勢力也會在控制點裡建立據點，從據點出兵攻擊玩家（控制點裡有據點時，要先打掉據點才能佔領）；沒有據點時改由大本營出兵。地圖右側的 🏯 是三大勢力的大本營，點擊可以查看勢力資訊。</li>
      <li><b>圖層</b>：地圖右側 ☣️ 按鈕可以切換「危險度 ⇄ 勢力圖」。勢力圖中淡藍色＝可以探索（自己或好友）；灰色（其他玩家、中立）與三大勢力的顏色＝不能探索。不能探索的區域會蓋上淺黑灰、不顯示建築，只顯示控制點。</li>
      <li><b>地下感染區（副本）</b>：地圖上不再顯示副本圖示，直接從地圖左上角的「地下感染區」選單點選報名，玩法不變。</li>
    </ol>`,
  },
  {
    id: 'basic',
    name: '基本玩法',
    html: `<ol>
      <li>在地圖左側安全區選一棟建築作為<b>避難所</b>，倖存者在這裡居住、生產、出發探索。</li>
      <li>派倖存者<b>探索建築</b>帶回食物、木材、燃料、零件、布料、藥品與裝備；區域越危險，物資越多、殭屍越強。</li>
      <li>用材料<b>建造與升級設施</b>（倉庫、宿舍、醫療站、工作台…）與防禦建築，並進行研究。</li>
      <li>每晚會有<b>屍潮</b>來襲：駐守的倖存者、圍牆與防禦建築一起抵擋；被突破會損失資源與受傷。</li>
      <li>倖存者需要食物；生命只會在避難所休息時回復（醫療站越高回復越快）。</li>
    </ol>`,
  },
  {
    id: 'explore',
    name: '探索與戰鬥',
    html: `<ol>
      <li>點地圖上的建築可以派遣探索，可以排連續探索的佇列；隊伍會依負重回家。</li>
      <li>遇到殭屍或 NPC 會自動戰鬥，戰報裡可以看到每一場的詳細紀錄。</li>
      <li>槍械需要子彈、弓需要箭矢；藥品欄的藥品會在戰後自動補血。</li>
      <li>遊戲時間 21:30 可設定自動回家，避免隊伍在夜晚留在外面。</li>
    </ol>`,
  },
  {
    id: 'shelter',
    name: '避難所',
    html: `<ol>
      <li>避難所沒有大小之分：設施都能升到最高等級、防禦欄位都一樣多，屍潮強度與警戒範圍一律比照巨型；建築規模只影響探索。</li>
      <li>宿舍決定可住人數（最多 12 人）；地窖可以藏起部分資源，並提高倉庫上限，屍潮突破時等級最高的駐守者會躲進地窖。</li>
      <li>工作台可製作裝備、子彈；醫療站可製作藥品。</li>
    </ol>`,
  },
  {
    id: 'multi',
    name: '多人與集結',
    html: `<ol>
      <li>可以和其他玩家設為好友或敵對；好友可以協防屍潮、參加集結。</li>
      <li>廣播塔可以發起集結，好友派隊到集結點會合後一起出發。</li>
      <li>黑市每 30 分鐘換新商品，也可以交換、出售材料；地下感染區每天 18:00 開打，00:00 起可從地圖左上角選單報名。</li>
    </ol>`,
  },
];

/**
 * 打開遊戲說明。
 * @param {object} ui
 * @param {{tab?:string, onClose?:Function}} [opts]
 */
export function openGuide(ui, { tab = 'new', onClose } = {}) {
  const g = ui.game;
  let cur = tab;
  const body = () => {
    const t = TABS.find((x) => x.id === cur) || TABS[0];
    const reloc = g.state.freeRelocate ? `<div class="guide-reloc">🏠 地圖已重新規劃（v15）：你有<b>一次免費</b>重新選擇避難所的機會（只能選左側安全區），設施、資源、防禦建築全部保留。避難所現在沒有大小之分：設施都能升到最高等級、防禦欄位都一樣多，屍潮強度與警戒範圍一律比照巨型。
      <div class="btn-row"><button class="btn btn-primary" data-action="relocGo">前往選擇位置</button><button class="btn btn-ghost" data-action="relocLater">稍後再說</button><button class="btn btn-ghost" data-action="relocSkip">留在原地</button></div></div>` : '';
    return `<div class="guide"><div class="chips guide-tabs">${TABS.map((x) => `<button class="chip ${x.id === cur ? 'active' : ''}" data-action="guideTab" data-t="${x.id}">${x.name}</button>`).join('')}</div>
      <div class="guide-body">${t.html}</div>${reloc}</div>`;
  };
  g.state.guideSeen = GUIDE_VERSION;
  g.requestSave?.();
  const m = ui.modal.open({
    title: '📖 遊戲說明',
    wide: true,
    body: body(),
    onAction: (action, data, md) => {
      if (action === 'guideTab') { cur = data.t; md.update(body()); return; }
      if (action === 'relocGo') {
        md.close();
        ui.switchTab('map');
        ui.toastEl?.show('🏠 點地圖左側安全區的建築，選「免費搬到這裡」', 'info', 6000);
        return;
      }
      if (action === 'relocLater') { md.close(); return; }
      if (action === 'relocSkip') {
        ui.result(g.shelter.skipFreeMove());
        md.update(body());
      }
    },
    onClose,
  });
  return m;
}

/** 改版後（或新玩家）第一次登入：還沒看過這一版的說明就打開 */
export function showGuideIfNeeded(ui) {
  if ((ui.game.state.guideSeen || 0) >= GUIDE_VERSION) return false;
  openGuide(ui);
  return true;
}
