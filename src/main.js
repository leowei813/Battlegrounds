import Phaser from 'phaser';
import './styles/main.css';
import { Game } from './core/Game.js';
import { BootScene } from './scenes/BootScene.js';
import { ShelterScene } from './scenes/ShelterScene.js';
import { UIManager } from './ui/UIManager.js';
import { SetupScreen } from './ui/SetupScreen.js';
import { SaveManager } from './core/SaveManager.js';
import { CloudSync } from './cloud/CloudSync.js';
import { createProvider } from './cloud/providers/index.js';
import { requireAccess } from './security/AccessGate.js';
import { gainsHtml } from './ui/components.js';
import { $ } from './utils/dom.js';
import { formatDuration } from './utils/math.js';

/**
 * 進入點：讀檔或建立新遊戲 → 掃描真實地圖 → 啟動 Phaser 與 UI。
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
  ui.modal.open({
    title: '🌙 離線收益',
    body: `
      <p>你離開了 <b>${formatDuration(report.elapsed)}</b>${report.capped ? '（已達 24 小時上限）' : ''}。倖存者們持續運作避難所：</p>
      <div class="gains big">${gainsHtml(report.gains)}</div>
      ${report.expeditions ? `<p>🧭 完成探索 ${report.expeditions} 次（詳見「探索」頁報告）</p>` : ''}
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

async function boot() {
  // 通行碼（建置時設定 VITE_ACCESS_HASH 才會啟用）
  await requireAccess($('#gate-root'));

  const cloud = new CloudSync(createProvider());
  let state = SaveManager.load();
  let cloudMeta = null;
  if (cloud.enabled) {
    setLoading('☁️ 正在同步雲端存檔…');
    const r = await cloud.resolveBoot(state);
    state = r.state;
    if (r.source === 'cloud') cloudMeta = r.meta;
  }
  setLoading('');

  let game = state ? new Game(state) : null;
  let fresh = false;
  if (!game) {
    const setup = new SetupScreen($('#setup-root'), cloud);
    const choice = await setup.show();
    if (choice.type === 'import') {
      game = new Game(choice.data);
      if (choice.meta) cloudMeta = choice.meta;
    } else {
      game = Game.newGame(choice);
      fresh = true;
    }
  }

  if (!game.state.map.pois.length) {
    setLoading('📡 正在掃描附近的真實建築（OpenStreetMap）…');
    const { lat, lon } = game.state.map.center;
    const r = await game.scanMap(lat, lon, (done, total) => {
      setLoading(`📡 正在分區掃描附近的真實建築（OpenStreetMap）… ${done}/${total}`);
    });
    setLoading(r.source === 'overpass' ? `找到 ${r.count} 個地點` : '');
  }
  setLoading('');

  const phaser = createPhaser(game);
  const report = game.start();
  const ui = new UIManager(game, phaser, cloud);
  ui.init();
  game.save();
  cloud.attach(game);

  if (fresh) showWelcome(ui);
  else if (report) showOfflineReport(ui, report);
  if (cloudMeta) {
    ui.toastEl.show(`☁️ 已載入雲端最新進度（來自 ${cloudMeta.deviceName || '其他裝置'}）`, 'success', 5000);
  }

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
