import { CLASSES } from '../config/survivors.js';
import { EXPLORE_DURATIONS, MAX_TEAM_SIZE } from '../config/constants.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDuration, haversine } from '../utils/math.js';
import { survivorStatus } from './components.js';
import { VEHICLES } from '../config/vehicles.js';

/** 載具選擇：座位、速度、運載量、耗油。選了臨時小隊時以小隊成員與目前使用中的載具判定 */
function vehicleHtml(game, cars, members, distanceM, squad = null, showAll = false) {
  const vs = game.vehicles;
  if (!game.state.vehicles.length) return `<p class="muted">🚗 沒有載具（可在「製作」頁製作，或探索時找到）・隊伍運載量 ${vs.tripStats(members, []).cargo}（背包可增加）</p>`;
  const current = squad ? (squad.vehicleIds || []) : [];
  const locked = squad && (squad.nextVehicleIds || []).length > 0;
  // 排序：可用的（含這支小隊自己的）在上面，依載貨量、耐久由高到低；無法使用的排到最下面。
  // 只看載具本身的狀態，選擇／取消小隊時順序不變
  const isMine = (v) => current.includes(v.id) || !!(squad && (squad.nextVehicleIds || []).includes(v.id));
  const usable = (v) => vs.isAvailable(v) || isMine(v);
  const sorted = [...game.state.vehicles].sort((a, b) => (usable(b) - usable(a))
    || (isMine(b) - isMine(a)) || VEHICLES[b.type].cargo - VEHICLES[a.type].cargo || b.durability - a.durability);
  // 收合時：已選的＋可用的第一台（依載貨量最高）；其餘收在「顯示其他」裡
  const chosen = (v) => cars.has(v.id) || isMine(v);
  const bestFree = sorted.find((v) => usable(v) && !chosen(v));
  const visible = showAll ? sorted : sorted.filter((v) => chosen(v) || v === bestFree);
  const hidden = sorted.length - visible.length;
  const firstOff = visible.findIndex((v) => !usable(v));
  const rows = visible.map((v, i) => {
    const def = VEHICLES[v.type];
    const mine = isMine(v);
    const ok = vs.isAvailable(v) && !locked;
    const on = cars.has(v.id) || mine;
    const why = mine ? (current.includes(v.id) ? '・小隊使用中' : '・已指定給這支小隊')
      : v.status === 'reserved' ? '・已指定給其他小隊' : v.status === 'out' ? '・出勤中' : vs.isBroken(v) ? '・損壞' : '';
    const sep = i === firstOff && firstOff > 0 ? '<div class="pick-sep">無法使用</div>' : '';
    return `${sep}<button class="pick-row pk ${on ? 'on' : ''}" data-action="car" data-id="${v.id}" ${ok ? '' : 'disabled'}>
      <span class="check">${on ? '☑' : '☐'}</span>
      <span class="pk-main"><b class="pk-nm">${def.icon} ${def.name}</b><small class="pk-sub">🪑${def.seats}・速度 ×${def.speed}・📦${def.cargo}${why}</small></span>
      <span class="pk-side">耐久 ${v.durability}/${def.durability}</span>
    </button>`;
  }).join('') + (sorted.length > 1 && (hidden > 0 || showAll)
    ? `<button class="pick-more" data-action="carsMore">${showAll ? '▲ 收合載具' : `▼ 顯示其他 ${hidden} 台載具`}</button>` : '');
  const all = [...new Set([...current, ...(squad?.nextVehicleIds || []), ...cars])].map((id) => vs.get(id)).filter(Boolean);
  const st = vs.tripStats(members, all, distanceM);
  const warn = all.length > members.length ? `<span class="neg">每台載具至少需要一名駕駛（${squad ? '小隊' : '隊伍'} ${members.length} 人，載具 ${all.length} 台）</span>`
    : all.length && !st.seated ? '<span class="neg">座位不足，全隊仍以步行速度移動</span>' : '';
  const fuelWarn = st.fuel > game.state.resources.fuel ? '<span class="neg">（燃料不足）</span>' : '';
  const note = !squad ? '' : locked ? '<small class="block muted">🔒 這支小隊已指定載具，回到避難所後下一次出門時生效，無法取消或變更。</small>'
    : '<small class="block muted">選擇的載具會在小隊回到避難所後、下一次出門時自動生效；確認後無法取消或變更，期間其他人不能選用，也不能維修或拆解；回程時損壞會自動解除指定。</small>';
  return `<div class="label pk-label">🚗 載具（選填）<span class="pk-r">已選 ${all.length} 台・運載量 ${st.cargo}</span></div><div class="pick-list pk-cars">${rows}</div>
    <p class="muted">速度 ×${st.speed}・運載量 <b>${st.cargo}</b>・耗油 ${st.fuel}${fuelWarn} ${warn}</p>${note}`;
}

/** 固定在底部的出發列摘要：人數、載具、戰力與時間 */
function footHtml(game, trip, ids, vids, avoidHostile, power, squad) {
  if (!ids.length) return '<span class="muted">選擇隊員後顯示時間</span>';
  const head = `${squad ? '🧭 臨時小隊' : `👥 ${ids.length} 人`}${vids.length ? `・🚙 ${vids.length} 台` : ''}・⚔️ <b>${power}</b>`;
  if (!trip?.poi) return head;
  const members = ids.map((id) => game.survivors.get(id)).filter(Boolean);
  const vehicles = vids.map((id) => game.vehicles.get(id)).filter(Boolean);
  const p = game.exploration.plan(trip.poi, members, trip.searchMin, Date.now(), vehicles, { avoidHostile });
  const km = p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(2)} 公里` : `${p.distanceM} 公尺`;
  const search = trip.searchMin > 0 ? `・${trip.searchLabel || '搜索'} ${formatDuration(p.searchMs)}` : '';
  return `${head}<br><span title="單程 ${km}">⏱ 總計 <b>${formatDuration(p.totalMs)}</b>（來回 ${formatDuration(p.travelMs * 2)}${search}）</span>`;
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
  // 探索一律自動進行（不再提供開關）
  const auto = true;
  // 載具很多時預設收合：只顯示已選的與最適合的 1 台
  let showAllCars = false;

  const render = () => {
    const inSquad = new Set(squads.flatMap((e) => e.memberIds));
    // 排序：可派遣的在上面、依戰力由高到低；無法派遣的（探索中、重傷…）排到最下面。
    // 只看倖存者本身的狀態（選擇臨時小隊時全部暫時不能勾選，但順序不變，畫面不跳動）
    const list = game.state.survivors.filter((sv) => !opts.squads || !inSquad.has(sv.id))
      .map((sv) => ({ sv, s: game.survivors.stats(sv), free: game.survivors.isAvailable(sv) }))
      .sort((a, b) => (b.free - a.free) || b.s.power - a.s.power);
    const firstOff = list.findIndex((x) => !x.free);
    const rows = list.map(({ sv, s, free }, i) => {
      const ok = free && !squadId;
      const sep = i === firstOff && firstOff > 0 ? '<div class="pick-sep">無法派遣</div>' : '';
      const on = selected.has(sv.id);
      return `${sep}<button class="pick-row pk ${on ? 'on' : ''}" data-action="toggle" data-id="${sv.id}" ${ok ? '' : 'disabled'}>
        <span class="check">${on ? '☑' : '☐'}</span>
        <span class="pk-main"><b class="pk-nm">${CLASSES[sv.classId].icon} ${escapeHtml(sv.name)} Lv${sv.level}</b>
          <small class="pk-sub"><span class="${game.survivors.hpOf(sv) < s.hp * 0.3 ? 'neg' : ''}">❤️ ${Math.floor(game.survivors.hpOf(sv))}/${s.hp}</span>・<span class="${game.survivors.bagLoad(sv) >= game.survivors.bagCap(sv) ? 'neg' : ''}">🎒 ${Math.floor(game.survivors.bagLoad(sv))}/${game.survivors.bagCap(sv)}</span>${ok ? '' : ` ${survivorStatus(game, sv)}`}</small></span>
        <span class="pk-side">戰力 <b>${s.power}</b></span>
      </button>`;
    }).join('');
    const squad = squadId ? squads.find((e) => e.id === squadId) : null;
    // 選了臨時小隊：以小隊成員與小隊的載具判定（時間、座位、駕駛人數）
    const ids = squad ? [...squad.memberIds] : [...selected];
    const vids = squad ? [...new Set([...(squad.vehicleIds || []), ...(squad.nextVehicleIds || []), ...cars])] : [...cars];
    const power = ids.reduce((sum, id) => sum + (game.survivors.get(id) ? game.survivors.stats(game.survivors.get(id)).power : 0), 0);
    const vehicles = opts.vehicles ? vehicleHtml(game, cars, ids.map((id) => game.survivors.get(id)).filter(Boolean), opts.distanceM || 0, squad, showAllCars) : '';
    const durs = opts.withDuration
      ? `${opts.fixedDuration ? '' : `<div class="label">探索時長</div><div class="chips">${EXPLORE_DURATIONS.map((d) => `<button class="chip ${d === duration ? 'active' : ''}" data-action="dur" data-d="${d}">${d} 分鐘</button>`).join('')}</div>`}`
      : '';
    const squadPower = (e) => e.memberIds.reduce((sum, id) => { const m = game.survivors.get(id); return sum + (m ? game.survivors.stats(m).power : 0); }, 0);
    const squadFull = (e) => (e.queue || []).length >= game.exploration.queueLimit();
    // 臨時小隊：佇列還有空位的在上面，離這個地點近的優先（從佇列最後一站出發），再依總戰力
    const target = opts.trip?.poi;
    const squadDist = (e) => {
      const last = game.exploration.poi((e.queue || []).length ? e.queue[e.queue.length - 1] : e.poiId);
      return target && last ? Math.round(haversine(last.lat, last.lon, target.lat, target.lon)) : null;
    };
    const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${m} 公尺`);
    const squadRows = [...squads].sort((a, b) => (squadFull(a) - squadFull(b)) || ((squadDist(a) ?? Infinity) - (squadDist(b) ?? Infinity)) || squadPower(b) - squadPower(a)).map((e) => {
      const names = e.memberIds.map((id) => game.survivors.get(id)?.name).filter(Boolean).map(escapeHtml).join('、');
      const full = (e.queue || []).length >= game.exploration.queueLimit();
      const on = squadId === e.id;
      const sp = e.memberIds.reduce((sum, id) => { const m = game.survivors.get(id); return sum + (m ? game.survivors.stats(m).power : 0); }, 0);
      const d = squadDist(e);
      return `<button class="pick-row pk squad ${on ? 'on' : ''}" data-action="squad" data-id="${e.id}" ${full || selected.size ? 'disabled' : ''}>
        <span class="check">${on ? '☑' : '☐'}</span>
        <span class="pk-main"><b class="pk-nm">${names}</b><small class="pk-sub">探索「${escapeHtml(game.exploration.poi(e.poiId)?.name || '')}」・佇列 ${(e.queue || []).length}/${game.exploration.queueLimit()}${full ? '（已滿）' : ''}</small></span>
        <span class="pk-side">⚔️ <b>${sp}</b>${d == null ? '' : `<br><b class="sq-dist" title="${(e.queue || []).length ? '從佇列最後一站' : '從目前地點'}到這裡的距離">📍 ${fmtDist(d)}</b>`}</span>
      </button>`;
    }).join('');
    return `${opts.intro}
      <div class="label">選擇隊員（最多 ${opts.maxPick || MAX_TEAM_SIZE} 人）・隊伍戰力 <b>${power}</b></div>
      <div class="pick-list">${rows || '<p class="muted">沒有可派出的倖存者</p>'}</div>
      ${squads.length ? `<div class="label">🧭 臨時小隊 <small class="muted">（加入該小隊的探索佇列；與勾選個別人員互斥）</small></div><div class="pick-list">${squadRows}</div>` : ''}
      ${vehicles}
      ${opts.routeOption ? '<small class="muted block">🛡️ 路線會自動繞開 NPC、敵對與中立玩家據點的警戒範圍；友好玩家的範圍可以直接通過。</small>' : ''}
      ${durs}
      <div class="pick-foot"><div class="pk-sum">${footHtml(game, opts.trip, ids, vids, avoidHostile, power, squad)}${ids.length && opts.footNote ? `<br>${opts.footNote(ids, vids)}` : ''}</div>
        ${opts.quickQueue ? (() => { const on = game.exploration.quickQueueOn(); return `<button class="pk-qq ${on ? 'on' : ''}" data-action="qqToggle" title="出發時自動把附近的探索點加入佇列（最多 ${game.exploration.queueLimit()} 個）">⚡ 快速佇列<small>${on ? `開・最多 ${game.exploration.queueLimit()} 個` : '關'}</small></button>`; })() : ''}
        <button class="btn btn-primary" data-action="confirm" ${ids.length || squadId ? '' : 'disabled'}>${squadId ? '加入小隊佇列' : opts.confirmLabel}</button></div>`;
  };

  const modal = ui.modal.open({
    title: opts.title,
    body: render(),
    onAction(action, data, m, el) {
      if (action === 'toggle') {
        if (squadId) return;
        if (selected.has(data.id)) selected.delete(data.id);
        else if (selected.size < (opts.maxPick || MAX_TEAM_SIZE)) selected.add(data.id);
      } else if (action === 'squad') {
        if (selected.size) return;
        squadId = squadId === data.id ? null : data.id;
        cars.clear();
      } else if (action === 'car') {
        if (cars.has(data.id)) cars.delete(data.id);
        else cars.add(data.id);
      } else if (action === 'qqToggle') {
        game.exploration.setQuickQueue(!game.exploration.quickQueueOn());
      } else if (action === 'carsMore') {
        showAllCars = !showAllCars;
      } else if (action === 'dur') {
        duration = +data.d;
      } else if (action === 'confirm') {
        // 小隊在視窗開著時可能已經前往下一站（換了新的隊伍編號）：以成員找回目前的小隊
        const sq0 = squadId ? squads.find((e) => e.id === squadId) : null;
        const sqNow = sq0 ? game.exploration.squadNow(squadId, sq0.memberIds) : null;
        if (squadId && !sqNow) { ui.result({ ok: false, reason: '這支小隊已經回到避難所，請重新選擇' }); return; }
        const res = opts.onConfirm(squadId ? [] : [...selected], duration, auto, [...cars], { avoidHostile, squadId: sqNow ? sqNow.id : null });
        if (res?.ok !== false) m.close();
        return;
      }
      m.update(render());
      void el;
    },
  });
  modal.body.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'avoid') avoidHostile = e.target.checked;
  });
  return modal;
}
