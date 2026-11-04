import { escapeHtml } from '../utils/dom.js';
import {
  parseShare, shareReportText, shareDefenseText, isShared, markShared, SHARE_NOTE_MAX,
} from '../multiplayer/ReportShare.js';
import { btn } from './components.js';

/** 分享卡片（聊天室與分享前預覽共用） */
export function shareCardHtml(text) {
  const s = parseShare(text);
  if (!s) return null;
  return `<span class="share-card ${s.cls}"><span class="t">${escapeHtml(s.title)}</span>${s.lines.map((l) => `<span class="l">${escapeHtml(l)}</span>`).join('')}${s.note ? `<span class="n">「${escapeHtml(s.note)}」</span>` : ''}</span>`;
}

/** 分享按鈕（已分享過顯示「✓ 已分享」） */
export function shareBtn(game, kind, id) {
  const done = isShared(game, id);
  return btn(done ? '✓ 已分享' : '💬 分享', kind === 'report' ? 'shareReport' : 'shareDefense', { id }, { cls: 'btn-xs btn-ghost share-btn', disabled: done, title: done ? '每份報告只能分享一次' : '分享到全服聊天室' });
}

/**
 * 分享前確認：預覽卡片、可加一句話，確認後送到全服聊天室。
 * @param {'report'|'defense'} kind
 */
export function openShareDialog(ui, kind, id) {
  const g = ui.game;
  const src = kind === 'report' ? (g.state.reports || []).find((r) => r.id === id) : (g.state.defenseLog || []).find((e) => e.id === id);
  if (!src) return ui.result({ ok: false, reason: '找不到這份報告' });
  if (isShared(g, id)) return ui.result({ ok: false, reason: '這份報告已經分享過了' });
  const why = g.chat?.blockReason?.();
  if (why) return ui.result({ ok: false, reason: why });
  let note = '';
  let busy = false;
  const text = () => (kind === 'report' ? shareReportText(src, note) : shareDefenseText(src, note));
  const body = () => `<p class="muted">分享到<b>全服聊天室</b>，所有玩家都看得到。</p>
    <div class="share-preview">${shareCardHtml(text())}</div>
    <label class="share-note"><small class="muted">附加一句話（選填，最多 ${SHARE_NOTE_MAX} 字）</small>
      <input type="text" class="share-note-in" maxlength="${SHARE_NOTE_MAX}" value="${escapeHtml(note)}" placeholder="例如：運氣不錯！"></label>
    <small class="muted block">只會分享地點名稱與結果，不會公開你的避難所位置與倉庫數量。每份報告只能分享一次。</small>
    <div class="btn-row end">${btn('取消', 'shareCancel', {}, { cls: 'btn-ghost' })}${btn(busy ? '分享中…' : '💬 分享', 'shareSend', {}, { cls: 'btn-primary', disabled: busy })}</div>`;
  const modal = ui.modal.open({
    title: '💬 分享到聊天室',
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'shareCancel') { m.close(); return; }
      if (action !== 'shareSend' || busy) return;
      busy = true;
      m.update(body());
      g.chat.send(text()).then((r) => {
        busy = false;
        if (r?.ok) {
          markShared(g, id);
          g.requestSave?.();
          ui.toastEl.show('💬 已分享到聊天室', 'success');
          m.close();
          ui.refresh(true);
        } else {
          ui.result(r || { ok: false, reason: '分享失敗' });
          m.update(body());
        }
      });
    },
  });
  // 輸入附加的話時即時更新預覽（不重畫輸入框）
  modal.body?.addEventListener('input', (e) => {
    if (!e.target.classList?.contains('share-note-in')) return;
    note = e.target.value.slice(0, SHARE_NOTE_MAX);
    const pv = modal.body.querySelector('.share-preview');
    if (pv) pv.innerHTML = shareCardHtml(text());
  });
  return modal;
}
