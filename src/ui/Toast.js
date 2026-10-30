import { escapeHtml } from '../utils/dom.js';

/** 右上角浮動通知 */
export class Toast {
  constructor(root) {
    this.root = root;
  }

  show(msg, type = 'info', ms = 3200) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = escapeHtml(msg);
    this.root.appendChild(el);
    while (this.root.children.length > 5) this.root.firstChild.remove();
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }
}
