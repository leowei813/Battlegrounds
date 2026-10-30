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
  open({ title, body, onAction, wide = false, onClose, live }) {
    this.close();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <header class="modal-head"><h3></h3><button class="icon-btn" data-action="close" aria-label="關閉">✕</button></header>
        <div class="modal-body"></div>
      </div>`;
    wrap.querySelector('h3').textContent = title;
    const bodyEl = wrap.querySelector('.modal-body');
    bodyEl.innerHTML = body;
    const handle = {
      el: wrap,
      body: bodyEl,
      update: (html) => {
        const top = bodyEl.scrollTop;
        bodyEl.innerHTML = html;
        bodyEl.scrollTop = top;
      },
      setTitle: (t) => { wrap.querySelector('h3').textContent = t; },
      close: () => this.close(),
      onClose,
      live,
      lastLive: body,
    };
    delegateActions(wrap, (action, data, el) => {
      if (action === 'close') return this.close();
      onAction?.(action, data, handle, el);
      return null;
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) this.close(); });
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
