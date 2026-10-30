import { APP_VERSION, CHANGELOG } from '../config/version.js';
import { compareVersions } from '../utils/changelog.js';
import { escapeHtml } from '../utils/dom.js';

const SEEN_KEY = 'jdqs_seen_version';
const SECTION_ICON = { 新增: '✨', 調整: '🔧', 修正: '🐛', 移除: '🗑️' };

/** 單一版本的改動內容 */
export function versionHtml(entry, { open = true, label = '' } = {}) {
  const body = entry.sections.map((s) => `
    <div class="cl-section"><b>${SECTION_ICON[s.title] || '•'} ${escapeHtml(s.title)}</b>
      <ul>${s.items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>
    </div>`).join('');
  return `<details class="cl-entry" ${open ? 'open' : ''}>
    <summary>${label ? `<b>${label}</b>` : ''}<span class="ver-tag">v${escapeHtml(entry.version)}</span><small>${escapeHtml(entry.date)}</small>${entry.version === APP_VERSION ? '<span class="tag tag-amber">目前版本</span>' : ''}</summary>
    ${body}
  </details>`;
}

/** 完整更新日誌彈窗 */
export function showChangelog(ui) {
  ui.modal.open({
    title: `📋 更新內容（目前 v${APP_VERSION}）`,
    wide: true,
    body: `<div class="changelog">${CHANGELOG.map((e, i) => versionHtml(e, { open: i < 2 })).join('')}</div>`,
  });
}

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** 記錄玩家已看過目前版本 */
export function markVersionSeen() {
  try {
    localStorage.setItem(SEEN_KEY, APP_VERSION);
  } catch {
    /* ignore */
  }
}

/**
 * 更新後第一次開啟：列出上次看過的版本之後的所有改動。
 * @returns {boolean} 是否有顯示
 */
export function showWhatsNew(ui, { onClose } = {}) {
  const seen = readSeen();
  if (seen === APP_VERSION) return false;
  // 舊玩家第一次看到此功能（沒有紀錄）：只顯示最新版本
  const entries = seen ? CHANGELOG.filter((e) => compareVersions(e.version, seen) > 0) : CHANGELOG.slice(0, 1);
  markVersionSeen();
  if (!entries.length) return false;
  ui.modal.open({
    title: `🆕 已更新至 v${APP_VERSION}`,
    wide: true,
    body: `<p class="muted">${seen ? `自 v${escapeHtml(seen)} 以來的更新：` : '這次的更新內容：'}</p>
      <div class="changelog">${entries.map((e) => versionHtml(e)).join('')}</div>
      <div class="btn-row end"><button class="btn btn-ghost" data-action="all">查看全部版本</button><button class="btn btn-primary" data-action="close">開始遊戲</button></div>`,
    onAction: (action) => { if (action === 'all') showChangelog(ui); },
    onClose,
  });
  return true;
}
