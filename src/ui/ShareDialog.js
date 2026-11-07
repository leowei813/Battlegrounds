import { escapeHtml } from '../utils/dom.js';
import {
  parseShare, shareReportText, shareDefenseText, isShared, markShared, SHARE_NOTE_MAX,
  SHARE_OBJ_KIND, SHARE_QUERY_KM, shareCoord, shareDetail,
} from '../multiplayer/ReportShare.js';
import { btn, flagText } from './components.js';
import { reportCardHtml } from './MessageDialog.js';

/** 分享卡片（聊天室與分享前預覽共用） */
export function shareCardHtml(text) {
  const s = parseShare(text);
  if (!s) return null;
  const attrs = s.link ? ` data-chat="share" data-id="${escapeHtml(s.link)}" role="button"` : '';
  return `<span class="share-card ${s.cls}${s.link ? ' linked' : ''}"${attrs}><span class="t">${flagText(escapeHtml(s.title))}</span>${s.lines.map((l) => `<span class="l">${escapeHtml(l)}</span>`).join('')}${s.note ? `<span class="n">「${escapeHtml(s.note)}」</span>` : ''}${s.link ? '<span class="more">▸ 點擊查看詳細</span>' : ''}</span>`;
}

/** 分享編號（8～12 個英數字） */
const shareId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 把完整內容存到共用資料；失敗時回傳空字串（照樣分享摘要，只是不能點開） */
async function putDetail(g, kind, src) {
  if (!g.shared?.online) return '';
  const id = shareId();
  const put = () => g.shared.update(SHARE_OBJ_KIND, id, () => ({ data: shareDetail(kind, src) }), shareCoord(id));
  try {
    let r = await put();
    // 剛上線還沒完成世界同步時會被拒：先同步一次再試
    if (!r?.ok && g.world?.sync) {
      await g.world.sync().catch(() => {});
      r = await put();
    }
    return r?.ok ? id : '';
  } catch {
    return '';
  }
}

/** 點聊天室的分享卡片：讀取完整內容並顯示 */
export async function openSharedDetail(ui, id, name = '') {
  const g = ui.game;
  const title = `${name ? `${name} 分享的` : ''}紀錄`;
  const modal = ui.modal.open({ title, body: '<p class="muted">讀取中…</p>' });
  let obj = null;
  try {
    const { b } = g.shared.store();
    const c = shareCoord(id);
    const list = await b.objList(SHARE_OBJ_KIND, c.lat, c.lon, SHARE_QUERY_KM);
    obj = (list || []).find((o) => o.id === id) || null;
  } catch { /* 讀取失敗 */ }
  const d = obj?.data;
  if (!d?.x) {
    modal.update?.('<p class="muted">找不到這份紀錄（可能已超過保存期限，或目前無法連線）。</p>');
    return modal;
  }
  const head = '<small class="muted block">分享的內容不含據點位置與倉庫數量。</small>';
  const body = d.t === 'defense' ? ui.panels.shelter.defenseCardHtml(d.x, { shared: true }) : reportCardHtml(g, d.x, { shared: true });
  modal.update?.(`${head}${body}`);
  return modal;
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
  const text = (link = '') => (kind === 'report' ? shareReportText(src, note, link) : shareDefenseText(src, note, link));
  const body = () => `<p class="muted">分享到<b>全服聊天室</b>，所有玩家都看得到。</p>
    <div class="share-preview">${shareCardHtml(text())}</div>
    <label class="share-note"><small class="muted">附加一句話（選填，最多 ${SHARE_NOTE_MAX} 字）</small>
      <input type="text" class="share-note-in" maxlength="${SHARE_NOTE_MAX}" value="${escapeHtml(note)}" placeholder="例如：運氣不錯！"></label>
    <small class="muted block">只會分享地點名稱與結果，不會公開你的避難所位置與倉庫數量；其他玩家可以點卡片查看這份紀錄的詳細內容。每份報告只能分享一次。</small>
    <div class="btn-row end">${btn('取消', 'shareCancel', {}, { cls: 'btn-ghost' })}${btn(busy ? '分享中…' : '💬 分享', 'shareSend', {}, { cls: 'btn-primary', disabled: busy })}</div>`;
  const modal = ui.modal.open({
    title: '💬 分享到聊天室',
    body: body(),
    onAction: (action, data, m) => {
      if (action === 'shareCancel') { m.close(); return; }
      if (action !== 'shareSend' || busy) return;
      busy = true;
      m.update(body());
      putDetail(g, kind === 'report' ? 'report' : 'defense', src).then((link) => g.chat.send(text(link))).then((r) => {
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
