import Phaser from 'phaser';
import './styles/main.css';
import { Game } from './core/Game.js';
import { BootScene } from './scenes/BootScene.js';
import { ShelterScene } from './scenes/ShelterScene.js';
import { UIManager } from './ui/UIManager.js';
import { SetupScreen } from './ui/SetupScreen.js';
import { AuthScreen } from './ui/AuthScreen.js';
import { SaveManager } from './core/SaveManager.js';
import { CloudSync } from './cloud/CloudSync.js';
import { createProvider } from './cloud/providers/index.js';
import { requireAccess } from './security/AccessGate.js';
import { showWhatsNew, markVersionSeen } from './ui/ChangelogView.js';
import { WorldSync } from './multiplayer/WorldSync.js';
import { gainsHtml } from './ui/components.js';
import { $ } from './utils/dom.js';
import { formatDuration } from './utils/math.js';

/**
 * 進入點：登入帳號讀取雲端進度（或建立新角色）→ 掃描真實地圖 → 啟動 Phaser 與 UI。
 */
function setLoading(text) {
  const el = $('#loading');
  if (!el) return;
  el.classList.toggle('show', !!text);
  el.querySelector('p').textContent = text || '';
}

function createPhaser(core) {
  const phaser = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#1d2118',
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    render: { antialias: true },
    // 不監聽整個視窗的輸入：點擊 HTML 面板時不應觸發畫布上的物件
    input: { windowEvents: false },
    scene: [BootScene, ShelterScene],
  });
  phaser.registry.set('core', core);
  phaser.registry.set('viewInset', { right: 0, bottom: 0, top: 0 });
  // HUD 換行等版面變化不會觸發 window resize，需監聽容器尺寸
  const root = $('#game-root');
  new ResizeObserver(() => phaser.scale.resize(root.clientWidth, root.clientHeight)).observe(root);
  return phaser;
}

function showOfflineReport(ui, report) {
  return ui.modal.open({
    title: '🌙 離線收益',
    body: `
      <p>你離開了 <b>${formatDuration(report.elapsed)}</b>${report.capped ? '（已達 24 小時上限）' : ''}。倖存者們持續運作避難所：</p>
      <div class="gains big">${gainsHtml(report.gains)}</div>
      ${report.expeditions ? `<p>🧭 完成探索 ${report.expeditions} 次（詳見「探索」頁報告）</p>` : ''}
      ${report.starving ? '<p class="warn">🍽️ 食物已耗盡，人員正在挨餓並持續扣血！請盡快補充食物。</p>' : ''}
      ${report.deaths > 0 ? `<p class="warn">⚰️ 離線期間有 ${report.deaths} 名隊員因長期飢餓死亡。</p>` : ''}
      ${report.defense ? `<p>🛡️ 離線防守擊殺 ${report.defense.kills} 隻殭屍，獲得 💰${report.defense.coins}</p>` : '<p class="muted">研究「夜行者」可解鎖離線防守收益。</p>'}
      <div class="btn-row end"><button class="btn btn-primary" data-action="close">太好了！</button></div>`,
  });
}

function showWelcome(ui) {
  ui.modal.open({
    title: '☣️ 歡迎來到末日',
    body: `
      <ol class="tutorial">
        <li>🗺️ 在<b>地圖</b>上點選任一棟真實建築，設為你的<b>避難所</b>。</li>
        <li>🏠 在<b>避難所</b>升級農場、工作台等設施，資源會自動累積（離線也會，最多 24 小時）。</li>
        <li>🧭 點地圖建築<b>派遣探索</b>，帶回物資、裝備、設計圖，甚至遇到新的倖存者。</li>
        <li>🛡️ 在避難所外圍空地建造<b>防禦建築</b>，抵擋越來越強的屍潮。<b>夜晚與午夜</b>格外危險！</li>
        <li>🔬 建造研究中心解鎖新科技，📜 完成任務領取獎勵。</li>
      </ol>
      <p class="muted">提示：現實 30 分鐘 = 遊戲 1 天。</p>
      <div class="btn-row end"><button class="btn btn-primary" data-action="close">開始求生</button></div>`,
  });
}

/**
 * 登入帳號並讀取雲端進度（遊戲進度只存在雲端）。
 * @returns {Promise<{state:object|null, meta?:object, legacy?:object}>}
 */
async function signIn(cloud) {
  const auth = new AuthScreen($('#setup-root'), cloud);
  let message = '';
  for (;;) {
    if (cloud.enabled) {
      setLoading(`☁️ 正在讀取 ${cloud.username} 的雲端進度…`);
      try {
        const r = await cloud.loadCurrent();
        setLoading('');
        return r.state ? r : { ...r, legacy: offerLegacy() };
      } catch (err) {
        setLoading('');
        message = err.kind === 'network' ? `無法連線到雲端伺服器（${err.message}），請檢查網路後重試。` : err.message;
        if (cloud.enabled) {
          // 仍是登入狀態（連線問題）：提供重試或改用其他帳號
          if (confirm(`${message}\n\n按「確定」重試，按「取消」改用其他帳號登入。`)) continue;
          cloud.logout();
        }
      }
    }
    const r = await auth.show({ message });
    message = '';
    if (r.type === 'login' && r.state) return r;
    return { state: null, legacy: offerLegacy() };
  }
}

/** 此裝置有舊版本機存檔時，詢問是否轉移到目前帳號 */
function offerLegacy() {
  const legacy = SaveManager.legacyLoad();
  if (!legacy) return null;
  const ok = confirm(`此裝置有舊版的本機存檔（倖存者「${legacy.player.name}」）。\n要把它轉移到這個帳號繼續玩嗎？\n\n按「取消」會建立新角色（舊存檔保留在此裝置）。`);
  return ok ? legacy : null;
}

async function boot() {
  // 通行碼（建置時設定 VITE_ACCESS_HASH 才會啟用）
  await requireAccess($('#gate-root'));

  const cloud = new CloudSync(createProvider());
  const { state, meta: cloudMeta, legacy } = await signIn(cloud);

  let game;
  let fresh = false;
  if (state) {
    game = new Game(state);
  } else {
    // 新帳號或重置後：轉移舊版本機存檔，或建立新角色
    game = legacy ? new Game(legacy) : Game.newGame(await new SetupScreen($('#setup-root'), cloud.username).show());
    fresh = !legacy;
    setLoading('☁️ 正在建立雲端存檔…');
    try {
      await cloud.create(game);
    } catch (err) {
      cloud.logout();
      setLoading('');
      alert(`建立雲端存檔失敗：${err.message}`);
      location.reload();
      return;
    }
    if (legacy) SaveManager.clearLegacy();
  }

  // 第一次進入：先快速抓主要設施（最多等 12 秒）讓遊戲立刻開始，一般建築在背景補齊
  const needFullScan = !game.state.map.pois.length;
  if (needFullScan) {
    setLoading('📡 正在掃描附近的真實建築（OpenStreetMap）…');
    const { lat, lon } = game.state.map.center;
    await game.scanMap(lat, lon, null, { quick: true, maxWaitMs: 12000 });
  }
  setLoading('');

  const phaser = createPhaser(game);
  const report = game.start();
  const ui = new UIManager(game, phaser, cloud);
  ui.init();
  game.save();
  cloud.attach(game);
  // 多人互動（與雲端存檔共用後端）
  game.world = new WorldSync(game, cloud.provider, cloud);
  game.world.start();

  if (needFullScan) {
    const { lat, lon } = game.state.map.center;
    ui.toastEl.show('📡 背景載入附近所有建築中，可以先開始遊戲…', 'info', 5000);
    game.scanMap(lat, lon).then((r) => {
      if (r.source === 'overpass') ui.toastEl.show(`🏙️ 附近建築載入完成：${r.count} 個地點`, 'success');
      game.save();
    });
  }

  if (fresh) {
    markVersionSeen(); // 新玩家不需要看更新內容
    showWelcome(ui);
  } else if (report) {
    // 先看離線收益，關閉後再顯示更新內容
    showOfflineReport(ui, report).onClose = () => showWhatsNew(ui);
  } else {
    showWhatsNew(ui);
  }
  ui.toastEl.show(`☁️ 已登入 ${cloud.username}${cloudMeta?.deviceName ? `・進度來自 ${cloudMeta.deviceName}` : ''}`, 'success', 4000);

  if (import.meta.env.DEV) {
    window.__game = game;
    window.__cloud = cloud;
    window.__ui = ui;
  }
}

boot().catch((err) => {
  console.error(err);
  setLoading(`啟動失敗：${err.message}`);
});
