import { APP_VERSION } from './config/version.js';
import Phaser from 'phaser';
import './styles/main.css';
import { Game } from './core/Game.js';
import { RESEARCH, effectText } from './config/research.js';
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
import { showGuideIfNeeded, openGuide } from './ui/GuideDialog.js';
import { WorldSync } from './multiplayer/WorldSync.js';
import { gainsHtml } from './ui/components.js';
import { $, escapeHtml } from './utils/dom.js';
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

/** 離線期間完成的研究與建造 */
function offlineDoneHtml(report) {
  const d = report.done || {};
  const rs = (d.research || []).map((x) => `<div class="li-row"><span>${RESEARCH[x.id]?.name || x.id} Lv${x.from} → Lv${x.to}</span><span class="pos">${x.from ? `${effectText(x.id, x.from)} → ` : ''}${effectText(x.id, x.to)}</span></div>`).join('');
  const bd = (d.builds || []).map((m) => `<div class="li-row"><span>${m}</span><span class="pos">完成</span></div>`).join('');
  if (!rs && !bd && !report.labIdle) return '';
  return `<div class="offline-done"><h4>📬 離線期間完成</h4>
    ${rs ? `<div class="sr-sec">🔬 研究</div>${rs}` : ''}
    ${bd ? `<div class="sr-sec">🏗️ 建造</div>${bd}` : ''}
    ${report.labIdle ? '<div class="li-row warn-row"><span>⚠️ 研究中心目前閒置</span><span>可以開始下一項研究</span></div>' : ''}</div>`;
}

function showOfflineReport(ui, report) {
  const body = () => `
      <p>你離開了 <b>${formatDuration(report.elapsed)}</b>${report.capped ? '（已達 24 小時上限）' : ''}。倖存者們持續運作避難所：</p>
      <div class="gains big">${gainsHtml(report.gains)}</div>
      ${report.expeditions ? `<p>🧭 完成探索 ${report.expeditions} 次（詳見「探索」頁報告）</p>` : ''}
      ${report.starving ? '<p class="warn">🍽️ 食物已耗盡，人員正在挨餓並持續扣血！請盡快補充食物。</p>' : ''}
      ${report.deaths > 0 ? `<p class="warn">⚰️ 離線期間有 ${report.deaths} 名隊員因長期飢餓死亡。</p>` : ''}
      ${report.defense ? `<p>🛡️ 離線防守擊殺 ${report.defense.kills} 隻殭屍，獲得 💰${report.defense.coins}</p>` : '<p class="muted">研究「夜行者」可解鎖離線防守收益。</p>'}
      ${offlineDoneHtml(report)}
      ${report.cpIncome ? `<p>🚚 控制點收益（離線期間 ${report.cpIncome.times} 次${report.cpIncome.missed > report.cpIncome.times ? `，最多補 ${report.cpIncome.times} 次` : ''}）：${report.cpIncome.text}</p>` : ''}
      <div class="btn-row end">${report.labIdle ? '<button class="btn btn-ghost" data-action="gotoResearch">🔬 前往研究</button>' : ''}<button class="btn btn-primary" data-action="close">太好了！</button></div>`;
  const m = ui.modal.open({
    onAction: (action, _d, md) => { if (action === 'gotoResearch') { md.close(); ui.switchTab('research'); } },
    title: '🌙 離線收益',
    body: body(),
  });
  // v15.5：控制點收益要等讀到共用資料後才補發：視窗還開著就補上這一行
  const add = (res) => {
    report.cpIncome = res;
    if (ui.modal.current === m) m.update(body());
  };
  if (ui.game.cp?.lastCatchUp) add(ui.game.cp.lastCatchUp);
  else ui.game.bus.once('cp:offlineIncome', add);
  return m;
}


/**
 * 登入帳號並讀取雲端進度（遊戲進度只存在雲端）。
 * @returns {Promise<{state:object|null, meta?:object, legacy?:object}>}
 */
/**
 * v15.7：每天 06:00 控制點物資直接入庫後跳出視窗：預設只顯示合計，展開才列出各控制點。
 * 正在顯示其他視窗（例如離線收益）時，等它關掉再跳。
 */
function watchDailyIncome(ui) {
  const queue = [];
  const nameRow = (x) => `<div class="cpi-row"><b>控制點 #${x.no}</b><span class="muted">${escapeHtml(x.zone)}</span><span class="cpi-tag">${escapeHtml(x.role)}</span><div class="cpi-g">${escapeHtml(x.text || '沒有東西')}</div></div>`;
  const show = (res) => {
    let open = false;
    const body = () => `<p class="muted">今天 ${res.list.length} 個控制點的收益已經直接存進倉庫。</p>
      <div class="cpi-sum"><small class="muted">合計</small><div>${escapeHtml(res.text || '沒有東西')}</div></div>
      <button class="btn-link cpi-fold" data-action="fold">${open ? '▾ 收起' : '▸ 展開'}各控制點（${res.list.length}）</button>
      ${open ? `<div class="cpi-list">${res.list.map(nameRow).join('')}</div>` : ''}
      <div class="btn-row end"><button class="btn btn-primary" data-action="close">好</button></div>`;
    ui.modal.open({
      title: '🚚 06:00 控制點物資送達',
      body: body(),
      onAction: (action, _d, m) => { if (action === 'fold') { open = !open; m.update(body()); } },
    });
  };
  const pump = () => {
    if (!queue.length || ui.modal.current) return;
    show(queue.shift());
  };
  ui.game.bus.on('cp:dailyIncome', (res) => { queue.push(res); pump(); });
  setInterval(pump, 1000);
}

/** 每 5 分鐘檢查網站是否有新版本；有的話提醒重新整理 */
function watchForUpdate(ui) {
  let told = false;
  const check = async () => {
    if (told || import.meta.env.DEV) return;
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { version } = await res.json();
      if (version && version !== APP_VERSION && isNewer(version, APP_VERSION)) {
        told = true;
        ui.modal.open({
          title: '🔔 有新版本',
          body: `<p>遊戲已更新到 <b>v${version}</b>（你目前是 v${APP_VERSION}）。</p><p class="muted">重新整理後就會使用新版本，進度已自動存檔。</p>
            <div class="btn-row"><button class="btn btn-primary" data-action="reload">🔄 立即更新</button></div>`,
          onAction: (action) => { if (action === 'reload') window.location.reload(); },
        });
      }
    } catch { /* 離線時略過 */ }
  };
  setTimeout(check, 15000);
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

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

// v15.12：長按不跳出系統選單（複製、搜尋、儲存圖片）；輸入框與可選取的文字除外
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable="true"], .chat-bubble, .sync-code, .selectable')) return;
  e.preventDefault();
});

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

  // v10：地圖地點由固定格子產生，不需要網路掃描（game.start() 會產生）
  setLoading('');

  const phaser = createPhaser(game);
  const report = game.start();
  const ui = new UIManager(game, phaser, cloud);
  watchForUpdate(ui);
  watchDailyIncome(ui);
  ui.init();
  game.save();
  cloud.attach(game);
  // 多人互動（與雲端存檔共用後端）
  game.world = new WorldSync(game, cloud.provider, cloud);
  game.world.start();

  // v14：更新內容看完之後顯示遊戲說明（改版後或新玩家第一次登入）
  const guide = () => showGuideIfNeeded(ui);
  const whatsNew = () => { if (!showWhatsNew(ui, { onClose: guide })) guide(); };
  if (fresh) {
    markVersionSeen(); // 新玩家不需要看更新內容
    openGuide(ui, { tab: 'basic' }); // 新玩家：遊戲說明（基本玩法）
  } else if (report) {
    // 先看離線收益，關閉後再顯示更新內容
    showOfflineReport(ui, report).onClose = whatsNew;
  } else {
    whatsNew();
  }
  ui.toastEl.show(`☁️ 已登入 ${cloud.username}${cloudMeta?.deviceName ? `・進度來自 ${cloudMeta.deviceName}` : ''}`, 'success', 4000);

  if (import.meta.env.DEV) {
    window.__game = game;
    window.__cloud = cloud;
    window.__ui = ui;
    window.__offline = (r) => showOfflineReport(ui, r); // 開發用：預覽離線報告
  }
}

boot().catch((err) => {
  console.error(err);
  setLoading(`啟動失敗：${err.message}`);
});
