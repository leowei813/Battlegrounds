import { delegateActions } from '../utils/dom.js';

/**
 * 通用彈窗。內容以 HTML 字串提供，按鈕以 data-action 觸發 onAction。
 * 同時只會存在一個彈窗。
 */
export class Modal {
  constructor(root) {
    this.root = root;
    this.current = null;
  }

  /**
   * @param {{title:string, body:string, live?:()=>string, onAction?:(action:string, data:DOMStringMap, modal:object, el:HTMLElement)=>void, wide?:boolean, onClose?:Function}} opts
   */
  open({ title, body, onAction, wide = false, onClose, live, dismissible = true }) {
    // 不可關閉的彈窗（例如雲端鎖定）不能被其他彈窗取代
    if (this.current && !this.current.dismissible) return this.current;
    this.close();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <header class="modal-head"><h3></h3><button class="icon-btn" data-action="close" aria-label="關閉">✕</button></header>
        <div class="modal-body"></div>
      </div>`;
    wrap.querySelector('h3').textContent = title;
    if (!dismissible) wrap.querySelector('[data-action="close"]').remove();
    const bodyEl = wrap.querySelector('.modal-body');
    bodyEl.innerHTML = body;
    const handle = {
      el: wrap,
      body: bodyEl,
      // 重繪時保留捲動位置與使用者輸入的數量（例如背包存取）
      update: (html) => {
        const top = bodyEl.scrollTop;
        const inputs = [...bodyEl.querySelectorAll('input[type=number]')];
        const values = inputs.map((el) => el.value);
        const focused = inputs.indexOf(document.activeElement);
        bodyEl.innerHTML = html;
        const after = [...bodyEl.querySelectorAll('input[type=number]')];
        if (after.length === values.length) after.forEach((el, i) => { el.value = values[i]; });
        if (focused >= 0) after[focused]?.focus();
        bodyEl.scrollTop = top;
      },
      setTitle: (t) => { wrap.querySelector('h3').textContent = t; },
      close: () => this.close(),
      onClose,
      live,
      lastLive: body,
      dismissible,
    };
    delegateActions(wrap, (action, data, el) => {
      if (action === 'close') return dismissible ? this.close() : null;
      onAction?.(action, data, handle, el);
      this.onAnyAction?.();
      return null;
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap && dismissible) this.close(); });
    this.root.appendChild(wrap);
    this.current = handle;
    return handle;
  }

  /** 若彈窗提供 live()，每次狀態更新時重繪內容 */
  refreshLive() {
    const cur = this.current;
    if (!cur?.live) return;
    const html = cur.live();
    if (html === cur.lastLive) return;
    cur.lastLive = html;
    cur.update(html);
  }

  /** 強制關閉（包含不可關閉的彈窗） */
  forceClose() {
    if (this.current) this.current.dismissible = true;
    this.close();
  }

  close() {
    if (!this.current) return;
    const { el, onClose } = this.current;
    this.current = null;
    el.remove();
    onClose?.();
  }

  get isOpen() {
    return !!this.current;
  }
}
