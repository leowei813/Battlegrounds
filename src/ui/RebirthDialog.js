import { QUALITY_KEYS, QUALITY_NAMES } from '../config/survivors.js';
import { LOCK_ITEM } from '../config/rebirth.js';
import { escapeHtml } from '../utils/dom.js';
import { formatNumber } from '../utils/math.js';
import { rarityTag } from './components.js';

/** 🧬 脫胎換骨還你漂漂重生器：超渡（洗鍊素質）視窗 */
export function openRebirthDialog(ui, svId) {
  const g = ui.game;
  const rb = g.rebirth;
  const st = { locks: [], result: null };
  const bar = (v, cls = '') => `<div class="rb-bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;
  const head = (sv) => `<div class="rb-who"><b>${escapeHtml(sv.name)}</b> ${rarityTag(sv.rarity)} Lv${sv.level}・可鎖 ${rb.lockSlots()} 種（重生器 Lv${rb.level()}）・${LOCK_ITEM.icon} ${LOCK_ITEM.name} 持有 <b>${rb.locks()}</b></div>`;
  const before = (sv) => {
    const q = rb.qualityOf(sv);
    const full = st.locks.length >= Math.min(rb.lockSlots(), rb.locks());
    const rows = QUALITY_KEYS.map((k) => {
      const on = st.locks.includes(k);
      const dis = !on && full;
      return `<div class="rb-row ${on ? 'locked' : ''}"><span class="rb-k">${QUALITY_NAMES[k]}</span>${bar(q[k])}<b>${q[k]}%</b>
        <button class="rb-lk ${on ? 'on' : ''}" data-action="rbLock" data-k="${k}" ${dis ? 'disabled' : ''}>${on ? '🔒 已鎖' : '🔓 鎖住'}</button></div>`;
    }).join('');
    const cost = rb.cost(sv, st.locks.length);
    const n = rb.todayCount(sv);
    const can = rb.canWash(sv, st.locks);
    return `${head(sv)}${rows}
      <div class="rb-cost">費用：💰<b>${formatNumber(cost)}</b>${st.locks.length ? `（含鎖定 +${st.locks.length * 50}%）＋ ${LOCK_ITEM.icon}×<b>${st.locks.length}</b>` : ''}${n ? `　<small class="muted">今天第 ${n + 1} 次超渡這位（+${n * 20}%）</small>` : ''}${rb.floor() ? `　<small class="muted">素質保底 ${rb.floor()}%</small>` : ''}</div>
      <small class="muted block">未鎖住的素質全部重新隨機（越接近 100% 越少見），結果可能更好也可能更差；超渡後可以選擇「快樂重生」或「還你原形」，費用不退。</small>
      ${can.ok ? '' : `<p class="tag tag-red">${escapeHtml(can.reason)}</p>`}
      <div class="btn-row rb-btns"><button class="btn btn-ghost" data-action="close">取消</button><button class="btn rb-go" data-action="rbWash" ${can.ok ? '' : 'disabled'}>🧬 進行超渡</button></div>`;
  };
  const after = (sv) => {
    const r = st.result;
    const rows = QUALITY_KEYS.map((k) => {
      const o = r.before[k];
      const v = r.after[k];
      const lk = r.locks.includes(k);
      const cls = lk ? 'same' : v > o ? 'up' : v < o ? 'dn' : '';
      return `<div class="rb-row cmp"><span class="rb-k">${QUALITY_NAMES[k]}</span><span class="rb-o">${o}%</span><span class="rb-ar">→</span>${bar(v, cls)}<b class="${cls}">${v}%${lk ? ' 🔒' : v > o ? ' ▲' : v < o ? ' ▼' : ''}</b></div>`;
    }).join('');
    const avg = (q) => Math.round(QUALITY_KEYS.reduce((s, k) => s + q[k], 0) / QUALITY_KEYS.length);
    const a0 = avg(r.before);
    const a1 = avg(r.after);
    const pc = (x, y) => (y > x ? 'up' : y < x ? 'dn' : '');
    return `${head(sv)}${rows}
      <div class="rb-sum">平均素質 ${a0}% → <b class="${pc(a0, a1)}">${a1}%</b>・戰力 ${formatNumber(r.powerBefore)} → <b class="${pc(r.powerBefore, r.powerAfter)}">${formatNumber(r.powerAfter)}</b></div>
      <div class="btn-row rb-btns"><button class="btn btn-ghost" data-action="rbKeep">還你原形</button><button class="btn rb-ok" data-action="rbAccept">✅ 快樂重生</button></div>
      <small class="muted block">選擇後會回到超渡畫面，可以直接再超渡；關閉視窗等於還你原形。</small>`;
  };
  const body = () => {
    const sv = g.survivors.get(svId);
    if (!sv) return '<p class="muted">找不到這位倖存者</p>';
    return st.result ? after(sv) : before(sv);
  };
  const finish = (accept) => {
    if (!st.result) return;
    ui.result(rb.decide(svId, accept));
    st.result = null;
    st.locks = st.locks.slice(0, Math.min(rb.lockSlots(), rb.locks()));
    ui.refresh(true);
  };
  const m = ui.modal.open({
    title: st.result ? '🧬 超渡結果' : '🧬 脫胎換骨還你漂漂重生器',
    body: body(),
    onClose: () => { if (st.result) finish(false); },
    onAction: (action, data, h) => {
      if (action === 'rbLock') {
        st.locks = st.locks.includes(data.k) ? st.locks.filter((k) => k !== data.k) : [...st.locks, data.k];
      }
      if (action === 'rbWash') {
        const r = rb.wash(svId, st.locks);
        if (!r.ok) ui.result(r);
        else st.result = r;
        ui.refresh(true);
      }
      // 快樂重生／還你原形：都不關視窗，回到超渡畫面（保留鎖定選擇），可以直接再超渡一次
      if (action === 'rbAccept' || action === 'rbKeep') finish(action === 'rbAccept');
      h.update(body());
      const t = h.el.querySelector('h3');
      if (t) t.textContent = st.result ? '🧬 超渡結果' : '🧬 脫胎換骨還你漂漂重生器';
    },
  });
  return m;
}

