import { CLASSES } from '../config/survivors.js';
import { EXPLORE_DURATIONS, MAX_TEAM_SIZE } from '../config/constants.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration } from '../utils/math.js';
import { survivorStatus } from './components.js';
import { VEHICLES } from '../config/vehicles.js';

/** 載具選擇：座位、速度、運載量、耗油。選了臨時小隊時以小隊成員與目前使用中的載具判定 */
function vehicleHtml(game, cars, members, distanceM, squad = null) {
  const vs = game.vehicles;
  if (!game.state.vehicles.length) return `<p class="muted">🚗 沒有載具（可在「製作」頁製作，或探索時找到）・隊伍運載量 ${vs.tripStats(members, []).cargo}（背包可增加）</p>`;
  const current = squad ? (squad.vehicleIds || []) : [];
  const locked = squad && (squad.nextVehicleIds || []).length > 0;
  const rows = game.state.vehicles.map((v) => {
    const def = VEHICLES[v.type];
    const mine = current.includes(v.id) || (squad && (squad.nextVehicleIds || []).includes(v.id));
    const ok = vs.isAvailable(v) && !locked;
    const on = cars.has(v.id) || mine;
    const why = mine ? (current.includes(v.id) ? '・小隊使用中' : '・已指定給這支小隊')
      : v.status === 'reserved' ? '・已指定給其他小隊' : v.status === 'out' ? '・出勤中' : vs.isBroken(v) ? '・損壞' : '';
    return `<button class="pick-row ${on ? 'on' : ''}" data-action="car" data-id="${v.id}" ${ok ? '' : 'disabled'}>
      <span class="check">${on ? '☑' : '☐'}</span><span>${def.icon} <b>${def.name}</b></span>
      <span class="muted">🪑${def.seats}・×${def.speed}・📦${def.cargo}・耐久 ${v.durability}/${def.durability}${why}</span>
    </button>`;
  }).join('');
  const all = [...new Set([...current, ...(squad?.nextVehicleIds || []), ...cars])].map((id) => vs.get(id)).filter(Boolean);
  const st = vs.tripStats(members, all, distanceM);
  const warn = all.length > members.length ? `<span class="neg">每台載具至少需要一名駕駛（${squad ? '小隊' : '隊伍'} ${members.length} 人，載具 ${all.length} 台）</span>`
    : all.length && !st.seated ? '<span class="neg">座位不足，全隊仍以步行速度移動</span>' : '';
  const fuelWarn = st.fuel > game.state.resources.fuel ? '<span class="neg">（燃料不足）</span>' : '';
  const note = !squad ? '' : locked ? '<small class="block muted">🔒 這支小隊已指定載具，回到避難所後下一次出門時生效，無法取消或變更。</small>'
    : '<small class="block muted">選擇的載具會在小隊回到避難所後、下一次出門時自動生效；確認後無法取消或變更，期間其他人不能選用，也不能拆解。</small>';
  return `<div class="label">載具（選填）</div><div class="pick-list">${rows}</div>
    <p class="muted">速度 ×${st.speed}・運載量 <b>${st.cargo}</b>・耗油 ${st.fuel}${fuelWarn} ${warn}</p>${note}`;
}

/**
 * 時間明細：去程、搜索（或交戰）、返程分開顯示（依隊員速度、載具、路線與日夜修正）。
 * @param {{poi:object, searchMin:number, searchLabel?:string}} [trip]
 */
function timeHtml(game, trip, ids, vids, avoidHostile) {
  if (!trip?.poi) return '';
  if (!ids.length) return '<p class="muted">⏱ 選擇隊員後顯示移動與搜索時間</p>';
  const members = ids.map((id) => game.survivors.get(id)).filter(Boolean);
  const vehicles = vids.map((id) => game.vehicles.get(id)).filter(Boolean);
  const p = game.exploration.plan(trip.poi, members, trip.searchMin, Date.now(), vehicles, { avoidHostile });
  const km = p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(2)} 公里` : `${p.distanceM} 公尺`;
  const search = trip.searchMin > 0 ? `<span>🔍 ${trip.searchLabel || '搜索'} <b>${formatDuration(p.searchMs)}</b></span>` : '';
  return `<div class="time-breakdown">
    <span>🚶 去程 <b>${formatDuration(p.travelMs)}</b><small>（單程 ${km}）</small></span>
    ${search}
    <span>🏃 返程 <b>${formatDuration(p.travelMs)}</b></span>
    <span class="total">⏱ 總計 <b>${formatDuration(p.totalMs)}</b></span>
  </div>`;
}

/**
 * 隊伍選擇彈窗：探索與地圖戰鬥共用。
 * @param {import('./UIManager.js').UIManager} ui
 * @param {{title:string, intro:string, withDuration?:boolean, vehicles?:boolean, distanceM?:number,
 *   trip?:{poi:object, searchMin:number, searchLabel?:string},
 *   confirmLabel:string, onConfirm:(ids:string[], dur:number, auto:boolean, vehicleIds:string[])=>object}} opts
 */
export function openTeamPicker(ui, opts) {
  const { game } = ui;
  const available = game.state.survivors.filter((s) => game.survivors.isAvailable(s));
  // 不預設勾選任何人（由玩家自己選擇）
  const selected = new Set();
  void available;
  const cars = new Set();
  let avoidHostile = false;
  // 臨時小隊：已派出探索的隊伍，可把這個地點加入它的探索佇列（與勾選個別人員互斥）
  let squadId = null;
  const squads = opts.squads ? game.exploration.squads() : [];
  let duration = EXPLORE_DURATIONS[1];
  const autoUnlocked = game.research.hasUnlock('autoExplore');
  // 自動探索：解鎖後預設勾選
  let auto = autoUnlocked;

  const render = () => {
    const inSquad = new Set(squads.flatMap((e) => e.memberIds));
    const rows = game.state.survivors.filter((sv) => !opts.squads || !inSquad.has(sv.id)).map((sv) => {
      const ok = game.survivors.isAvailable(sv) && !squadId;
      const s = game.survivors.stats(sv);
      const on = selected.has(sv.id);
      return `<button class="pick-row ${on ? 'on' : ''}" data-action="toggle" data-id="${sv.id}" ${ok ? '' : 'disabled'}>
        <span class="check">${on ? '☑' : '☐'}</span>
        <span>${CLASSES[sv.classId].icon} <b>${escapeHtml(sv.name)}</b> Lv${sv.level}
          <small class="pick-vitals"><span class="${game.survivors.hpOf(sv) < s.hp * 0.3 ? 'neg' : ''}">❤️ ${Math.floor(game.survivors.hpOf(sv))}/${s.hp}</span>・<span class="${game.survivors.bagLoad(sv) >= game.survivors.bagCap(sv) ? 'neg' : ''}">🎒 ${Math.floor(game.survivors.bagLoad(sv))}/${game.survivors.bagCap(sv)}</span></small></span>
        <span class="muted">戰力 ${s.power}</span>
        ${ok ? '' : survivorStatus(game, sv)}
      </button>`;
    }).join('');
    const squad = squadId ? squads.find((e) => e.id === squadId) : null;
    // 選了臨時小隊：以小隊成員與小隊的載具判定（時間、座位、駕駛人數）
    const ids = squad ? [...squad.memberIds] : [...selected];
    const vids = squad ? [...new Set([...(squad.vehicleIds || []), ...(squad.nextVehicleIds || []), ...cars])] : [...cars];
    const power = ids.reduce((sum, id) => sum + (game.survivors.get(id) ? game.survivors.stats(game.survivors.get(id)).power : 0), 0);
    const vehicles = opts.vehicles ? vehicleHtml(game, cars, ids.map((id) => game.survivors.get(id)).filter(Boolean), opts.distanceM || 0, squad) : '';
    const durs = opts.withDuration
      ? `${opts.fixedDuration ? '' : `<div class="label">探索時長</div><div class="chips">${EXPLORE_DURATIONS.map((d) => `<button class="chip ${d === duration ? 'active' : ''}" data-action="dur" data-d="${d}">${d} 分鐘</button>`).join('')}</div>`}
         <label class="toggle ${autoUnlocked ? '' : 'disabled'}"><input type="checkbox" data-role="auto" ${auto ? 'checked' : ''} ${autoUnlocked ? '' : 'disabled'}> 🔁 自動探索（完成後自動再出發）${autoUnlocked ? '' : '<small>（需研究「斥候訓練」）</small>'}</label>
         ${autoUnlocked ? '<small class="muted block">同一個地點的物資拿光才結束；有探索佇列時接著前往下一個地點。隊員重傷、戰敗，或背包與倉庫都滿了時停止。</small>' : ''}`
      : '';
    const squadRows = squads.map((e) => {
      const names = e.memberIds.map((id) => game.survivors.get(id)?.name).filter(Boolean).map(escapeHtml).join('、');
      const full = (e.queue || []).length >= game.exploration.queueLimit();
      const on = squadId === e.id;
      return `<button class="pick-row squad ${on ? 'on' : ''}" data-action="squad" data-id="${e.id}" ${full || selected.size ? 'disabled' : ''}>
        <span class="check">${on ? '☑' : '☐'}</span>
        <span>🧭 <b>臨時小隊</b>：${names}<small class="muted block">正在探索「${escapeHtml(game.exploration.poi(e.poiId)?.name || '')}」・佇列 ${(e.queue || []).length}/${game.exploration.queueLimit()}${full ? '（已滿）' : ''}</small></span>
      </button>`;
    }).join('');
    return `${opts.intro}
      <div class="label">選擇隊員（最多 ${MAX_TEAM_SIZE} 人）・隊伍戰力 <b>${power}</b></div>
      <div class="pick-list">${rows || '<p class="muted">沒有可派出的倖存者</p>'}</div>
      ${squads.length ? `<div class="label">🧭 臨時小隊 <small class="muted">（選擇後這個地點會加入該小隊的探索佇列，完成目前探索後自動前往；與勾選個別人員互斥）</small></div><div class="pick-list">${squadRows}</div>` : ''}
      ${vehicles}
      ${opts.routeOption ? '<small class="muted block">🛡️ 路線會自動繞開 NPC、敵對與中立玩家據點的警戒範圍；友好玩家的範圍可以直接通過。</small>' : ''}
      ${timeHtml(game, opts.trip, ids, vids, avoidHostile)}
      ${durs}
      <div class="btn-row end"><button class="btn btn-primary" data-action="confirm" ${ids.length || squadId ? '' : 'disabled'}>${squadId ? '加入小隊佇列' : opts.confirmLabel}</button></div>`;
  };

  const modal = ui.modal.open({
    title: opts.title,
    body: render(),
    onAction(action, data, m, el) {
      if (action === 'toggle') {
        if (squadId) return;
        if (selected.has(data.id)) selected.delete(data.id);
        else if (selected.size < MAX_TEAM_SIZE) selected.add(data.id);
      } else if (action === 'squad') {
        if (selected.size) return;
        squadId = squadId === data.id ? null : data.id;
        cars.clear();
      } else if (action === 'car') {
        if (cars.has(data.id)) cars.delete(data.id);
        else cars.add(data.id);
      } else if (action === 'dur') {
        duration = +data.d;
      } else if (action === 'confirm') {
        if (squadId && cars.size && !confirm('指定的載具會在小隊回到避難所後、下一次出門時生效。確認後無法取消或變更，期間其他人不能選用，也不能拆解。確定要指定嗎？')) return;
        const res = opts.onConfirm(squadId ? [] : [...selected], duration, auto, [...cars], { avoidHostile, squadId });
        if (res?.ok !== false) m.close();
        return;
      }
      m.update(render());
      void el;
    },
  });
  modal.body.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'auto') auto = e.target.checked;
    if (e.target.dataset.role === 'avoid') avoidHostile = e.target.checked;
  });
  return modal;
}
