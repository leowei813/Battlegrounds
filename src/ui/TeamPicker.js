import { CLASSES } from '../config/survivors.js';
import { EXPLORE_DURATIONS, MAX_TEAM_SIZE } from '../config/constants.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { survivorStatus } from './components.js';
import { VEHICLES } from '../config/vehicles.js';

/** 載具選擇：座位、速度、運載量、耗油 */
function vehicleHtml(game, cars, members, distanceM) {
  const vs = game.vehicles;
  if (!game.state.vehicles.length) return `<p class="muted">🚗 沒有載具（可在背包 → 車庫製作，或探索時找到）・隊伍運載量 ${vs.tripStats(members, []).cargo}（背包可增加）</p>`;
  const rows = game.state.vehicles.map((v) => {
    const def = VEHICLES[v.type];
    const ok = vs.isAvailable(v);
    const on = cars.has(v.id);
    return `<button class="pick-row ${on ? 'on' : ''}" data-action="car" data-id="${v.id}" ${ok ? '' : 'disabled'}>
      <span class="check">${on ? '☑' : '☐'}</span><span>${def.icon} <b>${def.name}</b></span>
      <span class="muted">🪑${def.seats}・×${def.speed}・📦${def.cargo}・耐久 ${v.durability}/${def.durability}${ok ? '' : v.status === 'out' ? '・出勤中' : '・損壞'}</span>
    </button>`;
  }).join('');
  const st = vs.tripStats(members, [...cars].map((id) => vs.get(id)), distanceM);
  const warn = cars.size > members.length ? '<span class="neg">每台載具至少需要一名駕駛</span>'
    : cars.size && !st.seated ? '<span class="neg">座位不足，全隊仍以步行速度移動</span>' : '';
  const fuelWarn = st.fuel > game.state.resources.fuel ? '<span class="neg">（燃料不足）</span>' : '';
  return `<div class="label">載具（選填）</div><div class="pick-list">${rows}</div>
    <p class="muted">速度 ×${st.speed}・運載量 <b>${st.cargo}</b>・耗油 ${st.fuel}${fuelWarn} ${warn}</p>`;
}

/**
 * 隊伍選擇彈窗：探索與地圖戰鬥共用。
 * @param {import('./UIManager.js').UIManager} ui
 * @param {{title:string, intro:string, withDuration?:boolean, vehicles?:boolean, distanceM?:number,
 *   estimate?:(ids:string[], dur:number, vehicleIds:string[])=>number,
 *   confirmLabel:string, onConfirm:(ids:string[], dur:number, auto:boolean, vehicleIds:string[])=>object}} opts
 */
export function openTeamPicker(ui, opts) {
  const { game } = ui;
  const available = game.state.survivors.filter((s) => game.survivors.isAvailable(s));
  const selected = new Set(available.slice(0, Math.min(2, MAX_TEAM_SIZE)).map((s) => s.id));
  const cars = new Set();
  let duration = EXPLORE_DURATIONS[1];
  let auto = false;
  const autoUnlocked = game.research.hasUnlock('autoExplore');

  const render = () => {
    const rows = game.state.survivors.map((sv) => {
      const ok = game.survivors.isAvailable(sv);
      const s = game.survivors.stats(sv);
      const on = selected.has(sv.id);
      return `<button class="pick-row ${on ? 'on' : ''}" data-action="toggle" data-id="${sv.id}" ${ok ? '' : 'disabled'}>
        <span class="check">${on ? '☑' : '☐'}</span>
        <span>${CLASSES[sv.classId].icon} <b>${escapeHtml(sv.name)}</b> Lv${sv.level}</span>
        <span class="muted">戰力 ${s.power}</span>
        ${ok ? '' : survivorStatus(game, sv)}
      </button>`;
    }).join('');
    const ids = [...selected];
    const vids = [...cars];
    const power = ids.reduce((sum, id) => sum + game.survivors.stats(game.survivors.get(id)).power, 0);
    const vehicles = opts.vehicles ? vehicleHtml(game, cars, ids.map((id) => game.survivors.get(id)), opts.distanceM || 0) : '';
    const durs = opts.withDuration
      ? `<div class="label">探索時長</div><div class="chips">${EXPLORE_DURATIONS.map((d) => `<button class="chip ${d === duration ? 'active' : ''}" data-action="dur" data-d="${d}">${d} 分鐘</button>`).join('')}</div>
         ${opts.estimate && ids.length ? `<p class="muted">預估實際時間（含往返路程與日夜修正）：<b>${formatDuration(opts.estimate(ids, duration, vids))}</b></p>` : ''}
         <label class="toggle ${autoUnlocked ? '' : 'disabled'}"><input type="checkbox" data-role="auto" ${auto ? 'checked' : ''} ${autoUnlocked ? '' : 'disabled'}> 🔁 自動探索（完成後自動再出發）${autoUnlocked ? '' : '<small>（需研究「斥候訓練」）</small>'}</label>`
      : '';
    return `${opts.intro}
      <div class="label">選擇隊員（最多 ${MAX_TEAM_SIZE} 人）・隊伍戰力 <b>${power}</b></div>
      <div class="pick-list">${rows || '<p class="muted">沒有倖存者</p>'}</div>
      ${vehicles}
      ${durs}
      <div class="btn-row end"><button class="btn btn-primary" data-action="confirm" ${ids.length ? '' : 'disabled'}>${opts.confirmLabel}</button></div>`;
  };

  const modal = ui.modal.open({
    title: opts.title,
    body: render(),
    onAction(action, data, m, el) {
      if (action === 'toggle') {
        if (selected.has(data.id)) selected.delete(data.id);
        else if (selected.size < MAX_TEAM_SIZE) selected.add(data.id);
      } else if (action === 'car') {
        if (cars.has(data.id)) cars.delete(data.id);
        else cars.add(data.id);
      } else if (action === 'dur') {
        duration = +data.d;
      } else if (action === 'confirm') {
        const res = opts.onConfirm([...selected], duration, auto, [...cars]);
        if (res?.ok !== false) m.close();
        return;
      }
      m.update(render());
      void el;
    },
  });
  modal.body.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'auto') auto = e.target.checked;
  });
  return modal;
}
