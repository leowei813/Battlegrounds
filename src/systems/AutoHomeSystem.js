import { DAY_REAL_MS } from '../config/constants.js';

/** 自動回家的時間（遊戲時間） */
export const AUTO_HOME_HOUR = 19.5;
/** 顯示用的時間文字 */
export const AUTO_HOME_LABEL = `${Math.floor(AUTO_HOME_HOUR)}:${String(Math.round((AUTO_HOME_HOUR % 1) * 60)).padStart(2, '0')}`;

/**
 * 自動回家（地圖右側 🏠，預設打開）：遊戲時間每天 19:30 觸發一次，
 * 所有外派中的隊伍（探索、攻打、淨化、攔截、協防、集結…）收到召回命令回家，並清空所有探索佇列。
 * 回家後可以自由再派出，當天不會再被召回。離線時在下次上線結算，照 19:30 當下的狀態召回。
 */
export class AutoHomeSystem {
  constructor(game) {
    this.game = game;
  }

  on() {
    return this.game.state.settings?.autoHome !== false;
  }

  toggle() {
    const st = this.game.state;
    st.settings = st.settings || {};
    st.settings.autoHome = !this.on();
    return { ok: true, msg: this.on() ? `🏠 自動回家已打開：遊戲時間 ${AUTO_HOME_LABEL} 所有外派隊伍會自動回家` : '🏠 自動回家已關閉' };
  }

  /** 第幾個 19:30（每天換一次） */
  keyAt(at) {
    return Math.floor((this.game.time.totalHours(at) - AUTO_HOME_HOUR) / 24);
  }

  /** at 之前最近一次 19:30 的現實時間 */
  triggerAt(at) {
    const h = this.game.time.totalHours(at);
    const since = h - AUTO_HOME_HOUR - this.keyAt(at) * 24;
    return Math.round(at - (since / 24) * DAY_REAL_MS);
  }

  /** 每次更新時檢查：跨過 19:30 就觸發一次 */
  check(now = Date.now(), { silent = false } = {}) {
    const st = this.game.state;
    const k = this.keyAt(now);
    // 第一次（剛更新到這一版）：從下一個 19:30 開始
    if (st.autoHomeKey == null) { st.autoHomeKey = k; return null; }
    if (k <= st.autoHomeKey) return null;
    st.autoHomeKey = k;
    if (!this.on()) return null;
    const at = Math.min(now, this.triggerAt(now));
    return this.run(at, { silent });
  }

  /** 在 at（19:30）召回所有外派隊伍並清空探索佇列 */
  run(at, { silent = false } = {}) {
    const g = this.game;
    const ex = g.exploration;
    // 先把 19:30 以前的行程結算完（離線時）
    ex.update(at, { silent: true });
    let recalled = 0;
    let queued = 0;
    [...g.state.expeditions].forEach((exp) => {
      if ((exp.queue || []).length) {
        queued += exp.queue.length;
        exp.travelEvents = [...(exp.travelEvents || []), `🧭 探索佇列已清空（原本還有 ${exp.queue.length} 個地點）`];
        exp.queue = [];
      }
      if (exp.kind === 'rally') {
        if (g.rally.withdraw(exp, at)) recalled += 1;
        return;
      }
      // 控制點駐防隊：駐防到撤回或被打下為止，19:30 不叫回
      if (exp.kind === 'cpGuard') return;
      if (!ex.canRecall(exp, at) || exp.startAt > at) return;
      const r = ex.recall(exp.id, at);
      if (!r.ok) return;
      recalled += 1;
      exp.travelEvents = exp.travelEvents.map((t) => (t === '↩️ 收到召回命令，隊伍折返避難所' ? `🏠 ${AUTO_HOME_LABEL} 自動回家：收到召回命令，隊伍折返避難所` : t));
    });
    if (recalled || queued) {
      const msg = `🏠 ${AUTO_HOME_LABEL} 了：${recalled} 支隊伍收到召回命令，正在返回避難所${queued ? '（探索佇列已清空）' : ''}`;
      g.log(msg, 'info');
      if (!silent) g.toast(msg, 'info');
      g.bus.emit('map:changed');
    }
    return { recalled, queued };
  }
}
