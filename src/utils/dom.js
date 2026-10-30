/** DOM 輔助工具。 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 跳脫，所有來自外部（OSM 名稱、玩家輸入）的字串都必須經過此函式。 */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);

export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 建立元素並設定屬性。 */
export function h(tag, attrs = {}, html = '') {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else node.setAttribute(k, v);
  });
  if (html) node.innerHTML = html;
  return node;
}

/**
 * 事件委派：點擊帶有 data-action 的元素時呼叫 handler(action, dataset, element)。
 */
export function delegateActions(root, handler) {
  root.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    ev.preventDefault();
    handler(target.dataset.action, target.dataset, target);
  });
}
