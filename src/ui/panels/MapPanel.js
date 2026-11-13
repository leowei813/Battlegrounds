import { LOCK_ITEM } from '../../config/rebirth.js';
import { RARITY_ORDER } from '../../config/equipment.js';
import { DUNGEONS } from '../../config/dungeons.js';
import { CLASSES } from '../../config/survivors.js';
import { DungeonSystem } from '../../systems/DungeonSystem.js';
import {
  DG_PIN_SVG, hudHtml, hudOpen, openStatus, openDungeon,
} from '../DungeonView.js';
import { MapService } from '../../map/MapService.js';
import { POI_TYPES, LOOT_CATS } from '../../config/poiTypes.js';
import { ALL_ENEMIES } from '../../config/enemies.js';
import { BASE_SIZES } from '../../config/civilization.js';
import { delegateActions, escapeHtml } from '../../utils/dom.js';
import { haversine, formatDuration } from '../../utils/math.js';
import { POI_SHARE } from '../../systems/PoiShareSystem.js';
import { EXP_PHASES, phaseIcon, tripProgress } from '../../systems/ExplorationSystem.js';
import {
  btn, costHtml, metaOf, itemCard, progressBar,
  rallyFlag,
} from '../components.js';
import { SUPPLIES, SUPPLY_CATS } from '../../config/supplies.js';
import { INFECTED } from '../../systems/InfectedSystem.js';
import { cpById, cpAt, CP_INCOME, FACTIONS, FACTION_SLOW_AT, FACTION_BASE } from '../../config/controlPoints.js';
import { RALLY_DELAYS, RallySystem } from '../../systems/RallySystem.js';
import { AUTO_HOME_LABEL } from '../../systems/AutoHomeSystem.js';
import { PLASTIC_SPOTS } from '../../systems/LootStock.js';
import { openTeamPicker } from '../TeamPicker.js';
import { openMessages, unreadCount } from '../MessageDialog.js';
import { openAbandonDialog } from '../AbandonDialog.js';
import { zoneAt, ZONES } from '../../config/zones.js';

const stars = (n) => '☠'.repeat(Math.min(7, n));

/**
 * 地圖分頁：Leaflet 地圖 + 浮動控制列，以及 POI / 殭屍群互動彈窗。
 */
export class MapPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.lastRender = 0;
    this.scanning = false;
  }

  init() {
    const root = this.ui.mapRoot;
    root.innerHTML = '<div id="map-canvas"></div><div id="map-overlay" class="map-overlay"></div>';
    this.overlay = root.querySelector('#map-overlay');
    this.service = new MapService(root.querySelector('#map-canvas'), this.game);
    const c = this.game.shelter.primary() || this.game.state.map.center;
    this.service.init(c.lat, c.lon);
    delegateActions(this.overlay, (action, data) => this.onAction(action, data));
  }

  /** 多人資料更新：重畫其他玩家據點 */
  onWorld(players) {
    this.service.renderOthers(players, (id) => this.game.territory.relation(id));
    // 重度感染據點會避開玩家據點：其他玩家的據點更新後重新計算位置
    this.service.renderInfected(this.game.infected.list(), INFECTED.pin);
    this.service.renderCps(this.game);
    this.service.renderConvoys(this.game.cp.convoyView());
    this.renderDungeons();
    this.lastOverlay = '';
    if (this.ui.tab === 'map') this.renderOverlay();
  }

  onShow() {
    this.service.invalidate();
    this.renderMap(true);
    this.service.setLive(true);
  }

  onHide() {
    this.service.setLive(false);
  }

  renderMap(force = false) {
    if (this.ui.tab !== 'map' && !force) return;
    this.lastRender = Date.now();
    this.service.render(this.game.state);
    this.service.renderNpcs(this.game.npcs.list);
    this.service.renderInfected(this.game.infected.list(), INFECTED.pin);
    this.service.renderCps(this.game);
    this.renderDungeons();
  }

  /** 副本入口：圖示下方顯示今天的狀態（報名人數／攻略中層數） */
  renderDungeons(now = Date.now()) {
    const g = this.game;
    const ph = DungeonSystem.phase(now);
    const day = DungeonSystem.dayKey(now);
    const list = Object.entries(DUNGEONS).map(([id, d]) => {
      const data = g.dungeon.data(id, day);
      const n = (data?.list || []).length;
      let label = ph === 'before' ? '00:00 開放報名' : ph === 'signup' ? `報名 ${n}` : ph === 'run' ? (n >= 3 ? '攻略中' : '今日休息') : ph === 'after' ? '今日已結束' : n >= 3 ? '即將開打' : `報名 ${n}`;
      const rec = g.dungeon.record(id, now);
      if (rec && !rec.cancelled && ph === 'run') {
        const mine = g.dungeon.myRun(rec);
        // 自己這團已經結束（通關或失敗）：顯示結果，不再顯示攻略中
        if (mine?.run) {
          label = now >= mine.run.endAt
            ? `${mine.run.result === 'clear' ? '🏆 通關' : '失敗'} ${mine.run.endFloor}/20`
            : `攻略中 ${DungeonSystem.floorAt(mine.run, now)}/20`;
        }
      }
      return { id, name: d.name, lat: d.lat, lon: d.lon, label: `${CLASSES[d.cls].icon} ${label}` };
    });
    // v15：地圖上不再顯示副本圖示，改由左側地下感染區選單報名
    this.service.renderDungeons([], DG_PIN_SVG);
    void list;
  }

  /** 發起集結：選擇出發倒數與自己的隊伍 */
  openRallySetup(target) {
    const g = this.game;
    let delay = RALLY_DELAYS[1];
    const body = () => `<p>${rallyFlag(16)} 目標：<b>${escapeHtml(target.name)}</b>・距避難所 ${g.rally.distanceTo(target)} 公尺</p>
      <p class="muted">發起後好友會收到通知，可以派隊參加（最多 ${g.rally.maxTeams()} 支隊伍，含你自己）。參加的隊伍會先走到你的避難所集合，倒數結束（或滿員）且全員到齊後一起出發；出發前可以取消。成功後金錢平分，其他物品隨機分配給參加的隊伍。</p>
      <div class="label">出發倒數</div><div class="chips">${RALLY_DELAYS.map((d) => `<button class="chip ${d === delay ? 'active' : ''}" data-action="delay" data-d="${d}">${d} 分鐘</button>`).join('')}</div>
      <div class="btn-row">${btn('選擇隊伍', 'pick', {}, { cls: 'btn-primary' })}</div>`;
    this.ui.modal.open({
      title: '🚩 發起集結',
      body: body(),
      onAction: (action, data, m) => {
        if (action === 'delay') {
          delay = Number(data.d);
          m.update(body());
          return;
        }
        if (action !== 'pick') return;
        openTeamPicker(this.ui, {
          title: `🚩 集結：${target.name}`,
          intro: `<p class="muted">${delay} 分鐘後（或滿員時）出發。</p>`,
          vehicles: true,
          distanceM: g.rally.distanceTo(target),
          confirmLabel: '發起集結',
          onConfirm: (ids, _dur, _auto, vids) => {
            g.rally.start(target, delay, ids, vids).then((r) => {
              this.ui.result(r);
              if (r.ok) m.close();
              this.ui.refresh(true);
            });
            return { ok: true };
          },
        });
      },
    });
  }

  /** 集結狀況：隊伍、倒數、結果；可參加、退出或取消 */
  rallyBody(id) {
    const g = this.game;
    const now = Date.now();
    const d = g.rally.get(id);
    if (!d) return '<p class="muted">找不到這個集結（可能已經結束）。</p>';
    const me = g.rally.myId();
    const joined = (d.teams || []).some((t) => t.player === me);
    const sc = d.home ? RallySystem.schedule(d) : null;
    const status = {
      gathering: sc && now >= sc.trigger && sc.waitFor ? `⏳ ${d.early ? '已提前出發' : '倒數結束'}・等「${escapeHtml(sc.waitFor.name)}」抵達集結點・約 ${formatDuration(Math.max(0, sc.go - now))}`
        : sc && d.early ? '⏳ 已提前出發・部隊準備出發'
        : `⏳ 集結中・${formatDuration(Math.max(0, (sc ? sc.trigger : d.departAt) - now))}後出發`,
      departed: `🚶 行軍中・約 ${formatDuration(Math.max(0, (d.fightAt || now) - now))}後抵達`,
      resolving: '⚔️ 交戰中',
      done: d.result?.summary || '已結束',
      cancelled: '已取消',
    }[d.status] || d.status;
    const way = (t) => (d.status === 'gathering' && d.home && (t.arriveAt || 0) > now ? `・🚶 ${formatDuration(t.arriveAt - now)}後抵達集結點` : '');
    const teams = (d.teams || []).map((t) => `<li>${t.player === d.owner ? '⭐' : '🛡️'} ${escapeHtml(t.name)}・${(t.units || []).length} 人・戰力 ${Math.round((t.units || []).reduce((s, u) => s + DungeonSystem.powerOf({ u }), 0))}${way(t)}</li>`).join('');
    const canJoin = d.status === 'gathering' && now < d.departAt && !joined && d.owner !== me && g.territory.relation(d.owner) === 'friend' && (d.teams || []).length < d.maxTeams;
    const gatherHint = canJoin && d.home ? `<p class="pos">🚶 前往集結點（${escapeHtml(d.ownerName)}的避難所）約 ${formatDuration(g.rally.gatherEstimate(d))}・倒數結束時還沒到，全隊會等你抵達再出發</p>` : '';
    return `<p>${rallyFlag(16)} 「${escapeHtml(d.ownerName)}」發起的集結・目標 <b>${escapeHtml(d.target.name)}</b>（${d.target.kind === 'inf' ? '☣️ 重度感染據點' : '🏴‍☠️ NPC 據點'}）</p>
      <p><b>${status}</b></p>${gatherHint}
      <div class="label">隊伍 ${(d.teams || []).length}/${d.maxTeams}</div><ul class="event-list">${teams}</ul>
      ${this.rallyAsk === id && d.owner === me && d.status === 'gathering' && !d.early ? this.departAskHtml(d, now) : `<div class="btn-row">${canJoin ? btn('🛡️ 派隊參加', 'join', {}, { cls: 'btn-primary' }) : ''}${d.status === 'gathering' && d.home && d.owner === me && !d.early ? btn(`${rallyFlag(16)} 立即出發`, 'departAsk', {}, { cls: 'btn-rally' }) : ''}${d.status === 'gathering' && joined && !d.early ? btn(d.owner === me ? '取消集結' : '退出集結', 'leave', {}, { cls: 'btn-ghost' }) : ''}${btn('📍 查看目標', 'fly', {}, { cls: 'btn-ghost' })}</div>`}`;
  }

  /** 提前出發的確認提示（列出還在前往集結點的隊伍） */
  departAskHtml(d, now) {
    const late = (d.teams || []).filter((t) => (t.arriveAt || 0) > now).sort((a, b) => b.arriveAt - a.arriveAt);
    return `<div class="rally-ask"><b>${rallyFlag(18)} 提前出發？</b>
      <p>按下後倒數立刻結束，其他玩家不能再參加。<br>部隊會等最後一位參加的玩家抵達集結點（你的避難所）後再出發。</p>
      ${late.length ? `<p class="pos">目前還在路上：${late.map((t) => `${escapeHtml(t.name)}・約 ${formatDuration(t.arriveAt - now)}後抵達`).join('、')}</p>` : '<p class="pos">所有隊伍都已經到齊，確定後馬上出發。</p>'}
      <div class="btn-row">${btn('先不要', 'departNo', {}, { cls: 'btn-ghost' })}${btn('確定出發', 'departNow', {}, { cls: 'btn-rally' })}</div></div>`;
  }

  openRally(id) {
    const g = this.game;
    g.shared.list('rally', 20).then(() => this.ui.refresh(true)).catch(() => {});
    this.ui.modal.open({
      title: '🚩 集結',
      body: this.rallyBody(id),
      live: () => this.rallyBody(id),
      onAction: (action, _d, m) => {
        const d = g.rally.get(id);
        if (!d) return;
        if (action === 'fly') {
          m.close();
          this.service.focus(d.target.lat, d.target.lon, 17);
        }
        if (action === 'departAsk') { this.rallyAsk = id; m.update(this.rallyBody(id)); }
        if (action === 'departNo') { this.rallyAsk = null; m.update(this.rallyBody(id)); }
        if (action === 'departNow') {
          this.rallyAsk = null;
          g.rally.departNow(id).then((r) => { this.ui.result(r); m.update(this.rallyBody(id)); });
        }
        if (action === 'leave' && confirm(d.owner === g.rally.myId() ? '取消這次集結？' : '退出這次集結？')) {
          g.rally.leave(id).then((r) => { this.ui.result(r); m.update(this.rallyBody(id)); });
        }
        if (action === 'join') {
          openTeamPicker(this.ui, {
            title: `🚩 參加集結：${d.target.name}`,
            intro: `<p class="muted">先走到「${escapeHtml(d.ownerName)}」的避難所集合，再和大家一起出發攻打；打完從目標直接回家。</p>`,
            vehicles: true,
            distanceM: g.rally.distanceTo(d.target),
            confirmLabel: '參加',
            footNote: d.home ? (ids, vids) => `🚶 前往集結點約 <b>${formatDuration(g.rally.gatherEstimate(d, ids, vids))}</b>${vids.length ? '（含載具）' : ''}` : null,
            onConfirm: (ids, _dur, _auto, vids) => {
              g.rally.join(id, ids, vids).then((r) => { this.ui.result(r); m.update(this.rallyBody(id)); });
              return { ok: true };
            },
          });
        }
      },
    });
  }

  /** 重度感染據點資訊、派隊淨化、發起集結 */
  infectedBody(s) {
    const g = this.game;
    const now = Date.now();
    const v = g.infected.intelView(s);
    const sh = g.shelter.primary();
    const dist = sh ? Math.round(haversine(sh.lat, sh.lon, s.lat, s.lon)) : null;
    const zone = zoneAt(s.lat, s.lon);
    const unknown = '<span class="muted">？？？（需提升偵查）</span>';
    const rally = g.rally?.canStart?.({ kind: 'inf', id: s.id }) || { ok: false, reason: '需要建造📡廣播塔' };
    return `<p>☣️ <b>${escapeHtml(s.name)}</b>・${v.level}・<span class="zone-tag" style="--zc:${zone.color}">${zone.name}</span>${dist != null ? `・距避難所 ${dist} 公尺` : ''}</p>
      <div><small>淨化度</small>${progressBar(s.purity / 100, 'pos', `${s.purity.toFixed(1)}%`)}</div>
      <p class="muted">🔭 偵查 Lv${v.lv}（研究「偵查」取得更多情報）</p>
      <p>首領：${v.boss ? escapeHtml(v.boss) : unknown}</p>
      <p>守軍：${v.roster || unknown}</p>
      ${v.decay != null ? `<p class="muted">未清除時每小時回復 ${v.decay}% 感染</p>` : ''}
      ${v.power != null ? `<p class="muted">⚔️ 守軍總戰力約 ${v.power}（建議多人集結）</p>` : ''}
      <p class="muted">每場戰鬥打到全員倒下或淨化 100%，淨化度會累積（所有倖存者共用）。淨化 100% 時消滅據點，消滅後（現實時間）${INFECTED.respawnDays} 天在原地重新出現；未被消滅時淨化度不會歸零，只會緩慢回復感染。</p>
      <div class="sp-hint">✨ <b>特殊物品</b>：消滅時必得 🔒「${LOCK_ITEM.name}」×${LOCK_ITEM.infectBase}，參戰 ${LOCK_ITEM.infectBonusAt} 人以上 ×${LOCK_ITEM.infectBase + 1}（集結時每支隊伍各得一份）</div>
      <div class="btn-row">${btn('☣️ 派隊淨化', 'attackInf', {}, { cls: 'btn-danger', disabled: !g.shelter.hasShelter() })}${btn(`${rallyFlag(16)} 發起集結`, 'rallyInf', {}, { cls: 'btn-primary', disabled: !rally.ok, title: rally.reason || '' })}</div>`;
  }

  /** v14 控制點資訊：佔領狀態、駐防、收益；攻打、集結、駐防、撤回 */
  cpBody(id) {
    const g = this.game;
    const sm = g.cp.summary(id);
    const { cp } = sm;
    const zone = ZONES[cp.zone];
    const fac = g.cp.factionOf(id);
    const ownTxt = fac ? `🏴 ${FACTIONS[fac].name}勢力` : sm.owners.length ? sm.owners.map((o) => escapeHtml(o.n)).join('、') : '—';
    // 同一位玩家分多次派出的駐防隊合計顯示
    const byPlayer = new Map();
    sm.guards.forEach((h) => { const cur = byPlayer.get(h.p) || { n: h.n, c: 0 }; cur.c += (h.units || []).length; byPlayer.set(h.p, cur); });
    const guardTxt = byPlayer.size ? [...byPlayer.values()].map((x) => `${escapeHtml(x.n)} ${x.c} 人`).join('・') : '沒有駐防';
    const npc = sm.status === 'neutral' || sm.status === 'faction';
    const atk = g.cp.canAttack(id);
    const rally = g.rally.canStart({ kind: 'cp', id });
    const gd = g.cp.canGuard(id, 1);
    const mine = g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId === id && !e.recalled && !e.defeated);
    const inc = CP_INCOME[cp.zone];
    const tagCol = sm.status === 'mine' ? '#4fc3f7' : sm.status === 'faction' ? '#ef5350' : '#9e9e9e';
    const btns = [];
    if (atk.ok || atk.locked) {
      btns.push(btn('⚔️ 派隊攻打', 'cpAttack', {}, { cls: 'btn-danger', disabled: !atk.ok, title: atk.reason || '' }));
      btns.push(btn(`${rallyFlag(16)} 發起集結`, 'cpRally', {}, { cls: 'btn-primary', disabled: !rally.ok, title: rally.reason || '' }));
    }
    if (sm.status === 'mine') btns.push(btn('🛡️ 派人駐防', 'cpGuard', {}, { cls: 'btn-primary', disabled: !gd.ok, title: gd.reason || '' }));
    if (mine.length) btns.push(btn('↩️ 撤回駐防', 'cpRecall', {}, { cls: 'btn-ghost' }));
    return `<p><span class="zone-tag" style="--zc:${zone.color}">${zone.name}</span> <span class="tag" style="color:${tagCol};border:1px solid ${tagCol}">${sm.label}</span></p>
      <div class="kv-list">
        <div><b>佔領者</b> ${ownTxt}</div>
        ${npc ? `<div><b>守軍</b> ${sm.status === 'faction' ? 'NPC' : '感染者'} ${sm.garrison}/${cp.garrison.count} 人（Lv${cp.garrison.level}）・戰力約 ${Math.round(g.cp.defensePower(id)).toLocaleString()}</div>` : `<div><b>駐防</b> ${guardTxt}</div>`}
        <div><b>每日收益</b> 06:00 運輸隊送回：食物 ${inc.food}、木材 ${inc.wood}、燃料 ${inc.fuel}＋隨機零件 ${inc.parts[0]}～${inc.parts[1]} 種</div>
        ${sm.status === 'mine' ? `<div class="muted">下一次收益約 ${sm.nextIncome} 後出發・每名玩家最多駐防 2 人</div>` : ''}
        ${!atk.ok && !atk.locked && sm.status !== 'mine' ? `<div class="muted">${escapeHtml(atk.reason)}</div>` : ''}
      </div>
      ${atk.locked ? `<div class="cp-lock">🔒 ${escapeHtml(atk.reason)}</div>` : ''}
      <div class="btn-row">${btns.join('')}</div>`;
  }

  /** 運輸隊內容 */
  openConvoy(id) {
    const g = this.game;
    const c = g.cp.convoyView().find((x) => x.id === id);
    if (!c) return;
    const names = { food: '食物', wood: '木材', fuel: '燃料' };
    const goods = Object.entries(c.goods || {}).map(([k, v]) => `${names[k] || SUPPLIES[k]?.name || k} ${v}`).join('、');
    this.ui.toastEl.show(`📦 控制點 #${cpById(c.cp)?.no} 的收益：${goods}・剩 ${formatDuration(c.left)}`, 'info', 5000);
  }

  openCp(id) {
    const g = this.game;
    const cp = cpById(id);
    if (!cp) return;
    const sh = g.shelter.primary();
    const at = g.cp.markerSpot(id);
    this.ui.modal.open({
      title: `🚩 控制點 #${cp.no}`,
      body: this.cpBody(id),
      live: () => this.cpBody(id),
      onAction: (action, _d, m) => {
        if (action === 'cpRally') {
          this.openRallySetup({ kind: 'cp', id, name: `控制點 #${cp.no}`, lat: at.lat, lon: at.lon });
          return;
        }
        if (action === 'cpRecall') {
          g.state.expeditions.filter((e) => e.kind === 'cpGuard' && e.cpId === id && !e.recalled).forEach((e) => g.exploration.recall(e.id));
          this.ui.result({ ok: true, msg: '駐防隊撤回中' });
          this.renderMap(true);
          return;
        }
        const guard = action === 'cpGuard';
        if (!guard && action !== 'cpAttack') return;
        openTeamPicker(this.ui, {
          title: guard ? `🛡️ 駐防：控制點 #${cp.no}` : `⚔️ 攻打：控制點 #${cp.no}`,
          intro: guard ? `<p class="muted">駐防隊會留守到你撤回為止，抵擋 NPC 與敵對玩家的進攻；每名玩家最多 2 人。</p>`
            : `<p class="muted">守軍戰力約 ${Math.round(g.cp.defensePower(id)).toLocaleString()}。打下後這個區域的建築就能探索。</p>`,
          vehicles: true,
          maxPick: guard ? Math.max(1, 2 - g.cp.myGuards(id)) : undefined,
          distanceM: sh ? haversine(sh.lat, sh.lon, at.lat, at.lon) : 0,
          trip: { poi: g.cp.asPoi(`cp:${id}`), searchMin: guard ? 0 : 2, searchLabel: guard ? '駐防' : '攻打' },
          confirmLabel: guard ? '出發駐防' : '進攻！',
          onConfirm: (ids, _dur, _auto, vids, opts) => {
            const r = this.ui.result(guard ? g.cp.guard(id, ids, { vehicleIds: vids, ...opts }) : g.cp.attack(id, ids, { vehicleIds: vids, ...opts }));
            if (r.ok) { m.close(); this.renderMap(true); }
            return r;
          },
        });
      },
    });
  }

  openInfected(id) {
    const g = this.game;
    const s = g.infected.get(id);
    if (!s) return;
    this.ui.modal.open({
      title: `☣️ 重度感染據點：${s.name}`,
      body: this.infectedBody(s),
      live: () => { const x = g.infected.get(id); return x ? this.infectedBody(x) : '<p>這個據點已經被淨化了。</p>'; },
      onAction: (action, _d, m) => {
        if (action === 'rallyInf') {
          this.openRallySetup({ kind: 'inf', id: s.id, name: s.name, lat: s.lat, lon: s.lon });
          return;
        }
        if (action !== 'attackInf') return;
        const sh = g.shelter.primary();
        openTeamPicker(this.ui, {
          title: `☣️ 淨化：${s.name}`,
          intro: '<p class="muted">戰鬥會持續到全員倒下或淨化 100%，倒下的隊員會重傷。</p>',
          vehicles: true,
          distanceM: sh ? haversine(sh.lat, sh.lon, s.lat, s.lon) : 0,
          trip: { poi: g.infected.asPoi(s.id), searchMin: 2, searchLabel: '淨化' },
          confirmLabel: '出發淨化！',
          onConfirm: (ids, _dur, _auto, vids, opts) => {
            const r = this.ui.result(g.exploration.start(s.id, ids, 5, false, Date.now(), { vehicleIds: vids, kind: 'infect', ...opts }));
            if (r.ok) {
              m.close();
              this.renderMap(true);
            }
            return r;
          },
        });
      },
    });
  }

  /** NPC 據點資訊與攻打 */
  npcBody(n) {
    const g = this.game;
    const now = Date.now();
    const zone = zoneAt(n.lat, n.lon);
    const v = g.npcs.intelView(n, now);
    const sh = g.shelter.primary();
    const dist = sh ? Math.round(haversine(sh.lat, sh.lon, n.lat, n.lon)) : null;
    const trip = n.trip && n.trip.endAt > now ? n.trip : null;
    const unknown = '<span class="muted">？？？（需提升偵查）</span>';
    const garrison = v.garrison
      ? `${v.garrison.map((e) => `${e.icon}${e.name}`).join('、')}${v.wounded ? `<span class="neg">（${v.wounded} 名守軍傷亡中，約 ${formatDuration(Math.max(0, (n.healAt || now) - now))} 後補回 1 名）</span>` : ''}`
      : unknown;
    const loot = v.resources ? `💰${v.coins} ${v.resources.map(([k, x]) => `${metaOf(k).icon}${x}`).join(' ')}` : unknown;
    return `
      <p>🏴‍☠️ <b>${escapeHtml(n.name)}</b>・${v.level}・<span class="zone-tag" style="--zc:${zone.color}">${zone.name}</span>${dist != null ? `・距避難所 ${dist} 公尺` : ''}</p>
      <p class="muted">🔭 偵查 Lv${v.lv}：${v.lv >= 15 ? '情報完整，掠奪隊行軍較慢' : v.lv >= 13 ? '可得知勢力部隊人數與戰力' : v.lv >= 11 ? '可得知圍牆與防禦火力' : v.lv >= 9 ? '可得知下次掠奪時間' : v.lv >= 7 ? '可得知確切物資與戰力' : v.lv >= 5 ? '可得知大約物資' : v.lv >= 3 ? '可得知確切等級、守軍與傷亡' : v.lv >= 1 ? '只知道大約等級' : '只知道名稱'}（研究「偵查」取得更多情報）</p>
      <p>守軍：${garrison}</p>
      <p>物資：${loot}</p>
      ${v.power != null ? `<p class="muted">⚔️ 建議戰力 ${v.power} 以上</p>` : ''}
      ${v.defense ? `<p class="muted">🧱 圍牆耐久 ${v.defense.wall.toLocaleString()}・防禦火力 ${v.defense.dps.toLocaleString()}/秒（攻打時要先破牆，期間持續受到射擊）</p>` : ''}
      ${v.nextRaid != null ? `<p class="muted">🏴‍☠️ 下次掠奪約在 ${formatDuration(v.nextRaid)} 後（夜晚不出動）</p>` : ''}
      ${trip ? `<p class="${trip.kind === 'raid' ? 'neg' : 'muted'}">${trip.kind === 'raid' ? `⚔️ 掠奪隊正前往「${escapeHtml(trip.target)}」` : `🔍 正在搜刮「${escapeHtml(trip.target)}」`}・剩 ${formatDuration(trip.endAt - now)}</p>` : ''}
      <div class="sp-hint">✨ <b>特殊物品</b>：攻陷時 ${Math.round(LOCK_ITEM.npcChance * 100)}% 機率在保險箱找到 🔒「${LOCK_ITEM.name}」×1（集結時每支隊伍各抽一次）</div>
      <div class="btn-row">${btn('⚔️ 派隊攻打', 'attackNpc', {}, { cls: 'btn-danger', disabled: !g.shelter.hasShelter() })}${(() => {
    const c = g.rally.canStart({ kind: 'npc', id: n.id });
    return btn(`${rallyFlag(16)} 發起集結`, 'rallyNpc', {}, { cls: 'btn-primary', disabled: !c.ok || !n.sid, title: c.reason || (n.sid ? '' : '這個據點不能集結') });
  })()}</div>`;
  }

  /** 三大勢力大本營資訊（不能攻打） */
  openHq(f) {
    const g = this.game;
    const F = FACTIONS[f];
    if (!F) return;
    const body = () => {
      const cps = g.cp.factionCps(f);
      const bases = g.npcs.list.filter((n) => n.faction === f && !n.hq);
      const hq = g.npcs.list.find((n) => n.faction === f && n.hq);
      const slow = cps.length >= FACTION_SLOW_AT ? '（控制點較多，隔天進攻一次）' : '';
      return `<p><span class="tag" style="color:${F.color};border:1px solid ${F.color}">🏯 ${F.name}勢力大本營・不能攻打</span></p>
        <div class="kv-list">
          <div><b>控制點</b> ${cps.length} 個${cps.length ? `（${cps.map((id) => `#${cpById(id).no}`).join('、')}）` : ''}</div>
          <div><b>NPC 據點</b> ${bases.length} 座</div>
          <div><b>進攻控制點</b> 每天 ${String(F.hour).padStart(2, '0')}:00（遊戲時間）${slow}</div>
          <div><b>攻打玩家</b> ${bases.length || Math.floor(cps.length / FACTION_BASE.perCps) ? '由 NPC 據點出兵' : `沒有 NPC 據點，由大本營出兵${hq ? `（Lv${hq.level}）` : ''}`}</div>
        </div>`;
    };
    this.ui.modal.open({ title: `🏯 ${F.name}大本營`, body: body(), live: body });
  }

  openNpc(npcId) {
    const g = this.game;
    const n = g.npcs.get(npcId);
    if (!n) return;
    this.ui.modal.open({
      title: `🏴‍☠️ NPC 據點：${n.name}`,
      body: this.npcBody(n),
      live: () => (g.npcs.get(npcId) ? this.npcBody(n) : '<p>這個據點已經消失了。</p>'),
      onAction: (action, _d, m) => {
        if (action === 'rallyNpc') {
          this.openRallySetup({
            kind: 'npc', id: n.id, ident: n.ident, name: n.name, lat: n.lat, lon: n.lon,
          });
          return;
        }
        if (action !== 'attackNpc') return;
        const sh = g.shelter.primary();
        openTeamPicker(this.ui, {
          title: `⚔️ 攻打：${n.name}`,
          intro: `<p class="muted">守軍 ${g.npcs.intelView(n).level}${g.npcs.intel() >= 7 ? `・建議戰力 ${g.npcs.displayPower(n)} 以上` : ''}。帶載具可以搬走更多物資。</p>`,
          vehicles: true,
          distanceM: sh ? haversine(sh.lat, sh.lon, n.lat, n.lon) : 0,
          trip: { poi: g.npcs.asPoi(n.id), searchMin: 2, searchLabel: '攻打' },
          routeOption: true,
          confirmLabel: '進攻！',
          onConfirm: (ids, _dur, _auto, vids, opts) => {
            const r = this.ui.result(g.exploration.start(n.id, ids, 5, false, Date.now(), { vehicleIds: vids, kind: 'raid', ...opts }));
            if (r.ok) {
              m.close();
              this.renderMap(true);
            }
            return r;
          },
        });
      },
    });
  }

  renderOverlay() {
    if (Date.now() - this.lastRender > 5000) this.renderMap(true);
    this.service.renderCps(this.game);
    this.service.renderConvoys(this.game.cp.convoyView());
    this.ui.mapRoot.dataset.phase = this.game.time.phaseId(); // 地圖依日夜變暗
    const st = this.game.state;
    const has = this.game.shelter.hasShelter();
    const src = { overpass: 'OpenStreetMap', generated: '隨機地圖', none: '—' }[st.map.source] || st.map.source;
    const html = `
      ${has ? (st.freeRelocate ? '<div class="map-hint reloc">🏠 地圖已重新規劃：點<b>左側安全區</b>的建築可以<b>免費</b>重新選擇避難所（全部保留）</div>' : '') : '<div class="map-hint">👆 點選地圖<b>左側安全區</b>的建築，將它設為你的<b>避難所</b></div>'}
      <div class="map-tools">
        ${btn('🏰', 'gotoShelter', {}, { cls: 'btn-icon', disabled: !has, title: '回到避難所' })}
        ${btn(`🔔<small class="alert-lbl ${this.game.shelter.alert ? 'on' : ''}">${this.game.shelter.alert ? '警戒中' : '正常'}</small>`, 'mapAlert', {}, { cls: `btn-icon alert-btn ${this.game.shelter.alert ? 'on' : ''}`, disabled: !has, title: this.game.shelter.alert ? '警戒中：按一下解除警戒' : '按一下切換警戒（全部倖存者暫時防禦駐守）' })}
        ${btn(`📜<em class="ic-lbl">戰報</em>${unreadCount(this.game) ? `<small class="unread">${unreadCount(this.game)}</small>` : ''}`, 'messages', {}, { cls: 'btn-icon', title: '消息：探索報告與避難所紀錄' })}
        ${btn(`💬<em class="ic-lbl">聊天</em>${this.game.chat.unread() ? `<small class="unread">${Math.min(99, this.game.chat.unread())}</small>` : ''}`, 'chat', {}, { cls: `btn-icon ${this.ui.chatView?.isOpen ? 'on' : ''}`, title: '全服聊天：所有玩家都看得到' })}
        ${btn(`🏠<small class="home-lbl ${this.game.autoHome.on() ? 'on' : ''}">${this.game.autoHome.on() ? `${AUTO_HOME_LABEL} 回家` : '關閉'}</small>`, 'autoHome', {}, { cls: `btn-icon home-btn ${this.game.autoHome.on() ? 'on' : ''}`, title: this.game.autoHome.on() ? `自動回家：遊戲時間 ${AUTO_HOME_LABEL} 所有外派隊伍自動回家（按一下關閉）` : '自動回家已關閉（按一下打開）' })}
        ${btn('🧾', 'legend', {}, { cls: 'btn-icon', title: '圖例' })}
        ${btn('☣️', 'zoneMode', {}, { cls: `btn-icon ${this.service.zoneMode?.() === 'off' ? '' : 'on'}`, title: '圖層：危險度 ⇄ 勢力圖' })}
      </div>
      <div class="map-topleft">${hudHtml(this.game)}${this.siegeBanner()}${this.feedHtml()}</div>
      ${this.scanning ? `<div class="scan-progress">📡 掃描建築中 ${this.scanProgress || ''}</div>` : ''}
      ${this.worldChip()}
      <div class="map-info">建築 ${st.map.pois.length}・殭屍群 ${st.map.zombieGroups.length}・資料：${src}</div>`;
    // 警戒中：地圖外框變紅
    this.overlay.classList.toggle('alerting', has && this.game.shelter.alert);
    if (html !== this.lastOverlay) {
      this.lastOverlay = html;
      this.overlay.innerHTML = html;
    }
  }

  /** 連續探索：背著的物資、負重與開關（只有探索隊伍） */
  chainHtml(ex) {
    const g = this.game;
    if (ex.kind !== 'explore' || ex.recalled || ex.defeated) return '';
    const load = g.exploration.teamLoad(ex);
    const carried = Object.entries(ex.carried?.gained || {}).filter(([, v]) => v > 0);
    const on = ex.chain !== false;
    return `<div class="chain-box">
      ${carried.length ? `<small class="muted block">🎒 背著前幾站的物資（回到避難所才入庫）：${carried.map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name}×${v}`).join('、')}</small>` : ''}
      <small class="muted block">🎒 隊伍負重 ${Math.round(load.used)}/${load.cap}</small>${progressBar(load.used / Math.max(1, load.cap), load.used >= load.cap * 0.9 ? 'danger' : 'hp')}
      ${btn(`${on ? '✅' : '⬜'} 有空間就直接前往下一個地點`, 'toggleChain', {}, { cls: 'btn-sm btn-ghost', title: on ? '負重未達 90% 時，探索完直接前往佇列中的下一個地點' : '關閉：每個地點探索完都先回避難所' })}
    </div>`;
  }

  /** 多人互動狀態：附近玩家數與隊伍數 */
  worldChip() {
    const w = this.game.world;
    if (!w?.available) return '';
    const n = w.others.length;
    const trips = w.others.reduce((s, p) => s + p.trips.filter((t) => t.endAt > Date.now()).length, 0);
    const reqs = Object.keys(this.game.territory.rel.requestsIn).length;
    return `<button class="world-chip" data-action="worldSettings">👥 附近玩家 ${n}・隊伍 ${trips}${reqs ? `・🤝 ${reqs} 個友好請求` : ''}</button>`;
  }

  /** 其他玩家資訊 */
  playerBody(p) {
    const g = this.game;
    const t = g.territory;
    const now = Date.now();
    const rel = t.relation(p.id);
    const trips = p.trips.filter((x) => x.endAt > now);
    const relTag = { hostile: '<span class="tag tag-red">⚔️ 敵對</span>', friend: '<span class="tag tag-green">🤝 友好</span>', neutral: '<span class="tag">中立</span>' }[rel];
    const incoming = !!t.rel.requestsIn[p.id];
    const outgoing = !!t.rel.requestsOut[p.id];
    const diplo = rel === 'friend'
      ? btn('解除友好', 'unfriend', {}, { cls: 'btn-sm btn-ghost' })
      : incoming
        ? `${btn('🤝 接受友好', 'acceptFriend', {}, { cls: 'btn-sm btn-primary' })}${btn('拒絕', 'declineFriend', {}, { cls: 'btn-sm btn-ghost' })}`
        : btn(outgoing ? '已提出友好（等待回覆）' : '🤝 提出友好', 'requestFriend', {}, { cls: 'btn-sm', disabled: outgoing });
    const sieged = rel === 'friend' ? p.bases.filter((b) => b.siege) : [];
    const myAssist = g.assist.trips().find((e) => e.assistTarget?.playerId === p.id);
    const canAssist = g.assist.canAssist(p.id);
    const home = p.bases.find((b) => b.primary) || p.bases[0];
    const covered = rel === 'friend' && g.assist.covers(home);
    // 協防狀況：抵達與否、提供的火力、對方回報的戰果、對方是否開著遊戲
    const assistInfo = (() => {
      if (!myAssist) return '';
      const ap = tripProgress(myAssist, now);
      const pub = g.assist.published(now);
      // 只顯示這次協防出發之後的戰果：今晚的屍潮、或出發後抵達的 NPC／玩家攻打（不顯示上一場的舊結果）
      const r0 = g.assist.myResult(p);
      const r = r0 && String(r0.night) === String(g.time.nightKey(now)) && g.time.siegeTime(now) ? r0 : null;
      const ra = (p.bases || []).map((b) => b.raidAssist).find((x) => x && x.at >= myAssist.startAt && x.list?.[g.world?.myId]);
      const raMine = ra ? ra.list[g.world.myId] : null;
      const idle = p.updatedAt && now - p.updatedAt > 90000;
      return `<div class="card"><b>🛡️ 我的協防隊</b> <small class="muted">${ap.phase === 'searching' ? '已抵達，協防中' : ap.phase === 'returning' ? '回程中' : `前往中・約 ${formatDuration(ap.phaseRemainingMs)}後抵達`}</small>
        ${pub ? `<small class="block">每秒提供約 ${pub.dps} 傷害（${pub.count} 人）</small>` : ''}
        ${raMine ? `<small class="block">對方回報：抵禦${escapeHtml(ra.attacker)}，你的協防隊擊倒 ${raMine.kills} 人${ra.result === 'ok' ? '・✅ 守住了' : '・💥 被攻破'}</small>` : ''}
        ${r ? `<small class="block">今晚屍潮：你造成 ${r.dmg} 傷害、擊殺 ${r.kills} 隻${r.result === 'ok' ? '・✅ 守住了' : r.result === 'breached' ? '・💥 被突破' : ''}</small>` : ''}
        ${!raMine && !r ? '<small class="block muted">對方尚未回報戰果（敵人抵達、與協防隊交戰後才會有）</small>' : ''}
        ${idle ? `<small class="neg block">⚠️ 對方約 ${formatDuration(now - p.updatedAt)}沒有更新：屍潮只在對方開著遊戲時進行，協防也只在那時生效</small>` : ''}</div>`;
    })();
    const assistRow = rel !== 'friend' ? '' : `${assistInfo}<div class="btn-row">${myAssist
    ? `<span class="tag tag-green">🛡️ 你的協防隊${tripProgress(myAssist, now).phase === 'searching' ? '正在協防' : '在路上'}</span>${btn('召回協防隊', 'stopAssist', { id: myAssist.id }, { cls: 'btn-xs btn-ghost' })}`
    : btn('🛡️ 派隊協防', 'assist', {}, { cls: 'btn-xs btn-primary', disabled: !canAssist.ok, title: canAssist.reason || '' })}</div>
      ${!myAssist && !canAssist.ok && sieged.length ? `<small class="muted block">${escapeHtml(canAssist.reason)}</small>` : ''}
      ${covered ? '<small class="pos block">🛡️ 你的防禦範圍涵蓋對方的據點：屍潮、NPC 或玩家來攻打時，你的防禦設施會自動額外協助（約你防禦火力的一半，自己的火力不會減少）</small>' : ''}`;
    const siegeHtml = sieged.map((b) => `<div class="card siege-card"><b>🧟 「${escapeHtml(b.name)}」正遭到屍潮攻擊</b>
        <small class="block">第 ${b.siege.wave}/${b.siege.maxWaves} 波・剩 ${b.siege.left} 隻・🧱 圍牆 ${b.siege.wallPct}%${b.siege.helpers ? `・🛡️ ${b.siege.helpers} 位玩家協防中` : ''}</small></div>`).join('');
    const raidHtml = rel === 'friend' ? p.bases.map((b) => {
      const list = (b.raids || []).filter((r) => r.at > now);
      return list.length ? `<div class="card siege-card"><b>⚔️ 「${escapeHtml(b.name)}」正被攻打</b>
        ${list.map((r) => `<small class="block">${r.kind === 'npc' ? '🏴‍☠️' : '👤'} ${escapeHtml(r.by)}・約 ${formatDuration(r.at - now)}後抵達</small>`).join('')}</div>` : '';
    }).join('') : '';
    return `<p>${relTag} 🏛️ 文明度 <b>${p.civ}</b>・控制點 ${this.game.cp.countOf(p.id)} 個・外出隊伍 ${trips.length} 支</p>
      ${raidHtml}${siegeHtml}${assistRow}
      <div class="btn-row">${diplo}</div>
      <div class="pick-list">${p.bases.map((b, i) => `<div class="pick-row"><span>${b.primary ? '⭐' : '🏴'} ${escapeHtml(b.name)}</span><small class="muted">警戒 ${b.alert}m・駐守 ${b.guards} 人</small>
        <span>${btn('📍', 'fly', { i }, { cls: 'btn-xs btn-ghost' })}${rel === 'friend' ? '' : btn('⚔️ 攻擊', 'attackBase', { i }, { cls: 'btn-xs btn-danger' })}</span></div>`).join('')}</div>
      ${trips.length ? `<div class="label">探索中</div><ul class="event-list">${trips.map((x) => `<li>${EXP_PHASES[tripProgress(x, now).phase].icon} 前往「${escapeHtml(x.target || '某處')}」・${x.members} 人・剩 ${formatDuration(x.endAt - now)}</li>`).join('')}</ul>` : ''}
      <p class="muted">玩家之間預設中立：探索時會繞開對方的警戒範圍。攻擊後雙方變成敵對——敵對時經過對方有駐守人員的據點範圍會遭到攻擊。友好需要雙方同意，友好時不能互相攻擊。友好玩家的據點遭到屍潮攻擊時可以看到狀況；夜晚屍潮或有 NPC／玩家正前來攻打時，可以直接派隊前往協防（趕路較快，一起守城迎戰）；自己避難所的屍潮防禦範圍涵蓋到對方據點時，防禦設施也會自動協助。</p>`;
  }

  openPlayer(playerId) {
    const g = this.game;
    const p = g.world?.others.find((x) => x.id === playerId);
    if (!p) return;
    this.ui.modal.open({
      title: `👤 ${p.name}`,
      body: this.playerBody(p),
      live: () => this.playerBody(g.world?.others.find((x) => x.id === playerId) || p),
      onAction: async (action, data, m) => {
        const t = g.territory;
        if (action === 'fly') {
          const b = p.bases[+data.i];
          m.close();
          this.service.focus(b.lat, b.lon, 17);
        }
        if (action === 'requestFriend') this.ui.result(await t.requestFriend(p.id, p.name));
        if (action === 'acceptFriend') this.ui.result(await t.acceptFriend(p.id, p.name));
        if (action === 'declineFriend') this.ui.result(t.declineFriend(p.id));
        if (action === 'unfriend' && confirm(`確定解除與「${p.name}」的友好關係？`)) this.ui.result(await t.removeFriend(p.id));
        if (action === 'assist') {
          this.openAssist(p);
          return;
        }
        if (action === 'stopAssist') this.ui.result(g.exploration.recall(data.id));
        if (action === 'attackBase') {
          const b = p.bases[+data.i];
          if (t.relation(p.id) !== 'hostile' && !confirm(`攻擊「${p.name}」後雙方會變成敵對。確定？`)) return;
          this.openAttackPlayer(p, +data.i, b);
          return;
        }
        if (this.ui.modal.current === m) m.update(this.playerBody(p));
        this.onWorld(g.world?.others || []);
      },
    });
  }

  /** 派隊協防友好玩家的據點（趕路比一般快，抵達後留守到天亮） */
  openAssist(p) {
    const g = this.game;
    const sh = g.shelter.primary();
    const b = p.bases.find((x) => x.primary) || p.bases[0];
    openTeamPicker(this.ui, {
      title: `🛡️ 協防：${p.name}・${b.name}`,
      intro: '<p class="muted">隊伍趕往友好玩家的據點（移動速度是一般的 2 倍，自動繞開 NPC 與敵對玩家的警戒範圍），抵達後一起防守：夜晚抵禦屍潮到天亮；白天留守 1 小時，NPC 或玩家來攻打時一起守城、破牆後一起迎戰（會受傷，重傷需要治療）。可以隨時召回。屍潮只在對方開著遊戲時進行。</p>',
      vehicles: true,
      distanceM: sh ? haversine(sh.lat, sh.lon, b.lat, b.lon) : 0,
      trip: { poi: g.assist.asPoi(`assist:${p.id}`), searchMin: 0, searchLabel: '協防' },
      confirmLabel: '出發協防！',
      onConfirm: (ids, _dur, _auto, vids, opts) => {
        const r = this.ui.result(g.assist.start(p.id, ids, { vehicleIds: vids, ...opts }));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }

  /** 派隊突襲其他玩家的據點 */
  openAttackPlayer(p, index, b) {
    const g = this.game;
    const sh = g.shelter.primary();
    const poiId = `pvp:${p.id}#${index}`;
    openTeamPicker(this.ui, {
      title: `⚔️ 突襲：${p.name}・${b.name}`,
      intro: `<p class="muted">對方駐守 ${b.guards} 人（約 Lv${b.guardLevel}）。勝利可搶走物資（對方損失 10% 資源），帶載具可以搬更多。攻擊後雙方敵對。</p>`,
      vehicles: true,
      routeOption: true,
      distanceM: sh ? haversine(sh.lat, sh.lon, b.lat, b.lon) : 0,
      trip: { poi: g.territory.asPoi(poiId), searchMin: 2, searchLabel: '突襲' },
      confirmLabel: '出發突襲！',
      onConfirm: (ids, _dur, _auto, vids, opts) => {
        const r = this.ui.result(g.exploration.start(poiId, ids, 5, false, Date.now(), { vehicleIds: vids, kind: 'pvp', ...opts }));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }

  /**
   * 地點狀態與可能出現的物資（v10 所有玩家共用）：
   * 有人探索中、搜過一部分（剩幾個檢核點）、已搜空（幾點恢復），或可能出現的物資種類。
   */
  stockHtml(poi) {
    const now = Date.now();
    const v = this.game.poiShare.view(poi, now);
    const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const rows = [];
    const busy = v.occ.filter((x) => x.a <= now && x.l > now).sort((a, b) => a.a - b.a)[0];
    const coming = v.occ.filter((x) => x.a > now).sort((a, b) => a.a - b.a)[0];
    if (v.empty) rows.push(`<div class="poi-st empty">🕸️ 已被搜空${v.by ? `（${escapeHtml(v.by)}）` : ''}・<b>${hm(v.until)}</b> 恢復（約 ${formatDuration(Math.max(0, v.until - now))}）</div>`);
    else {
      if (busy) rows.push(`<div class="poi-st busy ${busy.npc ? 'npc' : busy.rel === 'friend' ? 'friend' : ''}">🔍 ${busy.npc ? escapeHtml(busy.n) : `玩家「${escapeHtml(busy.n)}」`}正在探索，預計 <b>${hm(busy.l)}</b> 離開（約 ${formatDuration(Math.max(0, busy.l - now))}）</div>`);
      if (coming) rows.push(`<div class="poi-st busy ${coming.npc ? 'npc' : coming.rel === 'friend' ? 'friend' : ''}">🚶 ${coming.npc ? escapeHtml(coming.n) : `玩家「${escapeHtml(coming.n)}」`}的隊伍預計 <b>${hm(coming.a)}</b> 抵達，比他晚到的隊伍要等他搜完</div>`);
      if (v.left) {
        const left = Math.max(0, (v.left.total || 1) - (v.left.done || 0));
        rows.push(left ? `<div class="poi-st part">⏳ 已被搜過一部分：剩 <b>${left} / ${v.left.total}</b> 個檢核點（從剩下的檢核點繼續，只找得到剩下的物資）</div>`
          : `<div class="poi-st part">📦 已搜完，裡面還有帶不走留下的物資：${Object.entries(v.left.res || {}).map(([k, n]) => `${metaOf(k).icon}${metaOf(k).name} ${n}`).join('、')}</div>`);
      } else {
        const list = Object.keys(POI_TYPES[poi.type].loot).map((k) => `${LOOT_CATS[k].icon}${LOOT_CATS[k].name}`).join('、')
          + (PLASTIC_SPOTS[poi.type] ? '、📦塑膠外殼（少量）' : '') + (poi.type === 'recycling' ? '（電子零件較多）' : '');
        rows.push(`<div class="muted">📦 可能出現：${list}（實際所得於探索時隨機）</div>`);
      }
    }
    rows.push(`<small class="muted block">同一時間只有一支隊伍能探索（依抵達時間先後）；搜空後 ${formatDuration(POI_SHARE.recoverMs)}恢復</small>`);
    return rows.join('');
  }

  /**
   * 地圖左上角資訊欄：威脅接近（誰、多久後抵達）、好友遭攻打求援（點擊增援）、探索佇列（點擊查看／召回）。
   */
  feedHtml(hud = '') {
    const g = this.game;
    const now = Date.now();
    const rows = hud ? [hud] : [];
    g.threatDetails(now).filter((t) => t.kind !== 'siege').forEach((t) => {
      rows.push(`<button class="feed-chip danger" data-action="gotoShelter">⚠️ ${escapeHtml(t.text)}${t.at ? `・約 ${formatDuration(t.at - now)}後抵達` : ''}</button>`);
    });
    // v15.7：勢力部隊前往自己的控制點、大本營部隊前往自己的探索隊（點擊移到目標）
    (g.cp?.incoming?.(now) || []).forEach((t) => {
      // v15.10：偵查 Lv13 看到的其他控制點行軍：一般樣式（不是自己的控制點，不用紅色警示）
      const other = t.mine === false;
      rows.push(`<button class="feed-chip ${other ? '' : 'danger'}" data-action="feedFocus" data-lat="${t.lat}" data-lon="${t.lon}">${other ? '🔭' : '⚠️'} ${escapeHtml(t.text)}・${other ? `${Math.max(1, Math.ceil((t.at - now) / 60000))}分` : `約 ${formatDuration(t.at - now)}後抵達`}</button>`);
    });
    // 好友遭受玩家／NPC 攻打：點擊直接進入增援指派（好友的屍潮不顯示在這裡）
    const seen = new Set();
    g.assist.friendRaids(now).map((x) => ({ p: x.player, text: `遭 ${x.raid.by} 攻打・約 ${formatDuration(x.raid.at - now)}後抵達` })).forEach(({ p, text }) => {
      const key = `${p.id}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sent = g.assist.trips().some((e) => e.assistTarget?.playerId === p.id);
      rows.push(`<button class="feed-chip friend" data-action="feedAssist" data-id="${p.id}">🆘 好友「${escapeHtml(p.name)}」${text}${sent ? '・🛡️ 已派隊' : '・點擊增援'}</button>`);
    });
    // 集結：發起中／參加中（倒數），以及好友發起的集結（點擊參加）
    const rallyText = { gathering: '集結中・出發倒數', departed: '行軍中・約', resolving: '交戰中', done: '已結束' };
    g.rally.feed(now).forEach((r) => {
      rows.push(`<button class="feed-chip rally" data-action="feedRally" data-id="${r.id}">${rallyFlag(16)} ${r.mine ? '發起' : '參加'}集結「${escapeHtml(r.target.name)}」・${r.teams}/${r.maxTeams} 隊・${r.status === 'gathering' && r.early ? '提前出發・等隊伍到齊・約' : rallyText[r.status] || ''}${r.left ? ` ${formatDuration(r.left)}` : ''}</button>`);
    });
    g.rally.invites(now).forEach((d) => {
      rows.push(`<button class="feed-chip rally" data-action="feedRally" data-id="${d.id}">${rallyFlag(16)} 好友「${escapeHtml(d.ownerName)}」集結「${escapeHtml(d.target.name)}」・${(d.teams || []).length}/${d.maxTeams} 隊・${formatDuration(d.departAt - now)}後出發・點擊參加</button>`);
    });
    // 探索佇列：類型、距離、剩餘時間
    const sh = g.shelter.primary();
    g.state.expeditions.filter((ex) => ex.kind !== 'rally').forEach((ex) => {
      // 隊伍標籤：狀態圖示＋隊員＋總剩餘時間（含佇列與回程）＋佇列數
      const it = g.exploration.itinerary(ex, now);
      const icon = ex.defeated ? '🏳️' : ex.recalled ? '↩️' : phaseIcon(ex, it.phase);
      const names = ex.memberIds.map((id) => g.survivors.get(id)?.name).filter(Boolean);
      const who = names.length <= 2 ? names.join('、') : `${names[0]}等 ${names.length} 人`;
      const guarding = ex.kind === 'cpGuard' && it.phase === 'searching' && !ex.recalled && !ex.defeated;
      const time = guarding ? `駐防控制點 #${cpById(ex.cpId)?.no || ''}` : `⏱ 總計 ${formatDuration(it.totalMs)}`; // v15.8.1：返程也一律顯示總計（含之後的佇列）
      // v15.10：返程中（背包滿了先回家）也顯示佇列數；召回或撤退的隊伍回家後不再前往佇列，不顯示
      const queued = ex.kind === 'explore' && (it.phase !== 'returning' || it.queueOnHold) ? `・佇列 ${(ex.queue || []).length}` : '';
      // 左側圖示：快速定位隊伍；文字：打開隊伍詳細
      rows.push(`<div class="feed-chip team split"><button class="feed-loc" data-action="feedLocate" data-id="${ex.id}" title="地圖移到隊伍位置">${icon}</button><button class="feed-txt" data-action="feedTeam" data-id="${ex.id}">${escapeHtml(who || '隊伍')}・${time}${queued}</button></div>`);
    });
    return rows.length ? `<div class="map-feed">${rows.join('')}</div>` : '';
  }

  /** 各據點即時屍潮摘要（夜間整晚顯示波數與剩餘波數）；點擊可飛到該據點 */
  siegeBanner() {
    const g = this.game;
    const helpers = g.assist.incoming();
    const rows = g.state.bases.map((b) => {
      const s = g.siege.of(b.id);
      const ratio = g.shelter.wallHp(b) / g.shelter.wallMax(b);
      return { b, n: s.zombies.length, ratio, st: s.nightState() };
    }).filter((r) => r.st || r.n > 0 || r.ratio < 0.999);
    if (!rows.length) return '';
    const dawn = '☀️ 天亮 06:00';
    return `<div class="siege-banner">${rows.map(({ b, n, ratio, st }) => {
      const wall = `🧱${Math.round(ratio * 100)}%`;
      const help = g.shelter.isPrimary(b) && helpers.length ? `・🛡️協防 ${helpers.length}` : '';
      let cls = ratio < 0.3 ? 'danger' : '';
      // 白天（沒有屍潮）：只是提醒圍牆受損
      let text = `🧱 圍牆受損・${Math.round(ratio * 100)}%・需修繕${n ? `・🧟${n}` : ''}`;
      if (!st) cls = 'wall';
      if (st?.state === 'wait') { cls = 'wait'; text = `🌙 屍潮將至・第 1 波 <b>${formatDuration(st.nextIn * 1000)}</b>後來襲・今晚共 <b>${st.maxWaves}</b> 波`; }
      if (st?.state === 'attack') text = `🧟 第 <b>${st.wave}/${st.maxWaves}</b> 波・剩 <b>${st.leftWaves}</b> 波・🧟${n}・${wall}`;
      if (st?.state === 'lull') { cls = ratio < 0.3 ? 'danger' : 'lull'; text = `第 <b>${st.wave}/${st.maxWaves}</b> 波已擊退・剩 <b>${st.leftWaves}</b> 波・下一波 <b>${formatDuration(st.nextIn * 1000)}</b>後・${wall}`; }
      if (st?.state === 'done') { cls = 'done'; text = `✅ 今夜屍潮已結束・${wall}・${dawn}`; }
      if (st?.state === 'broke') { cls = 'broke'; text = `💥 今夜屍潮已結束${st.wave ? `（第 ${st.wave} 波被突破）` : '（防線被突破）'}・${dawn}`; }
      return `
      <button class="siege-chip ${cls}" data-action="flyTo" data-id="${b.id}">
        ${st ? '屍潮來襲・' : ''}${text}${help}
      </button>`;
    }).join('')}</div>`;
  }

  async onAction(action, data = {}) {
    const sh = this.game.shelter.primary();
    if (action === 'dgStatus') { openStatus(this.ui, data.dg); return; }
    if (action === 'dgOpen') { openDungeon(this.ui, data.dg); return; }
    if (action === 'dgFold') {
      const st = this.game.state;
      st.settings = st.settings || {};
      st.settings.dgHudOpen = !hudOpen(this.game);
      this.game.requestSave?.();
      this.lastOverlay = '';
      this.renderOverlay();
      return;
    }
    if (action === 'gotoShelter' && sh) this.service.focus(sh.lat, sh.lon);
    if (action === 'messages') openMessages(this.ui);
    if (action === 'chat') this.ui.chatView.toggle();
    if (action === 'legend') this.showLegend();
    if (action === 'autoHome') {
      const r = this.game.autoHome.toggle();
      this.ui.toastEl.show(r.msg, 'info');
      this.lastOverlay = '';
      this.renderOverlay();
      this.game.requestSave?.();
      return;
    }
    if (action === 'mapAlert' && sh) {
      const on = !this.game.shelter.alert;
      const r = this.game.shelter.setAlert(on);
      if (r.ok) this.ui.toastEl.show(on ? '🔔 已切換警戒：全部在家的倖存者暫時改為防禦駐守' : '🟢 已解除警戒：倖存者恢復原本的工作', on ? 'danger' : 'success');
      else this.ui.result(r);
      this.game.changed?.();
      this.renderOverlay();
    }
    if (action === 'zoneMode') {
      this.ui.toastEl.show(`☣️ 圖層：${this.service.cycleZoneMode()}`, 'info');
      this.renderOverlay();
    }
    if (action === 'worldSettings') this.ui.switchTab('settings');
    if (action === 'feedTeam') this.openOwnTeam(data.id);
    if (action === 'feedLocate') {
      const ex = this.game.state.expeditions.find((e) => e.id === data.id);
      if (!ex) {
        this.ui.toastEl.show('這支隊伍已經回到避難所了', 'info');
        return;
      }
      const pos = this.game.exploration.progress(ex)?.pos || ex.pvpTarget || ex.from;
      if (pos && Number.isFinite(pos.lat)) this.service.focus(pos.lat, pos.lon, 17);
      return;
    }
    if (action === 'feedRally') this.openRally(data.id);
    if (action === 'feedAssist') {
      const p = this.game.world?.others.find((x) => x.id === data.id);
      if (p) {
        if (this.game.assist.trips().some((e) => e.assistTarget?.playerId === p.id)) this.openPlayer(p.id);
        else this.openAssist(p);
      }
    }
    if (action === 'feedFocus') {
      const lat = Number(data.lat); const lon = Number(data.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.service.focus(lat, lon, 16);
      return;
    }
    if (action === 'flyTo') {
      const b = this.game.shelter.base(data.id);
      if (b) this.service.focus(b.lat, b.lon, 17);
    }
  }

  /** 野外隊伍（其他玩家或 NPC）：顯示資訊並可派隊攔截 */
  /** 點擊地圖上自己的探索隊：顯示行程並可直接召回 */
  openOwnTeam(expId) {
    const g = this.game;
    if (!g.state.expeditions.some((e) => e.id === expId)) {
      this.ui.toastEl.show('這支隊伍已經回到避難所了', 'info');
      return;
    }
    const body = () => {
      const ex = g.state.expeditions.find((e) => e.id === expId);
      if (!ex) return '<p class="muted">這支隊伍已經回到避難所了，請到「📜 戰報」查看探索報告。</p>';
      const now = Date.now();
      const p = g.exploration.progress(ex, now);
      const poi = g.exploration.poi(ex.poiId);
      const names = ex.memberIds.map((id) => g.survivors.get(id)?.name).filter(Boolean).map(escapeHtml).join('、');
      const status = ex.defeated ? '🏳️ 撤回中' : ex.recalled ? '↩️ 召回中' : '';
      const canRecall = g.exploration.canRecall(ex, now);
      const it = g.exploration.itinerary(ex, now);
      const end = new Date(it.endAt);
      const hm = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
      const qn = (ex.queue || []).length;
      const ph = it.phase === 'returning' ? '🏃 返程中' : it.phase === 'outbound' ? '🚶 前往中' : '🔍 搜索中';
      const cpDone = ex.cp ? `（檢核點 ${Math.min(ex.cp.total || 1, (ex.cp.done || 0) + (it.phase === 'searching' ? 1 : 0))}/${ex.cp.total || 1}）` : '';
      // 駐防中：沒有期限（直到撤回或被打下）
      const guarding = ex.kind === 'cpGuard' && it.phase === 'searching' && !ex.recalled && !ex.defeated;
      const curRow = guarding
        ? `<div class="it-step now"><span class="no">▶</span><span><b>${escapeHtml(poi?.name || '控制點')}</b><small>🛡️ 駐防中・直到撤回或被打下</small></span><span class="t"></span></div>`
        : `<div class="it-step now"><span class="no">▶</span><span><b>${escapeHtml(poi?.name || '未知地點')}</b><small>${status || ph}${it.phase === 'returning' ? '' : cpDone}</small></span><span class="t">剩 <b>${formatDuration(it.currentMs)}</b></span></div>`;
      const stopRows = it.stops.map((x, i) => `<div class="it-step"><span class="no">${i + 1}</span><span><b>${escapeHtml(x.poi.name)}</b><small>🚶 移動 ${formatDuration(x.travelMs)}・🔍 搜索 ${formatDuration(x.searchMs)}</small></span><span class="t"><b>${formatDuration(x.totalMs)}</b>${btn('移除', 'dequeue', { i }, { cls: 'btn-xs btn-ghost' })}</span></div>`).join('');
      // v15.8.1：背包滿了先回家：之後的每一站從避難所出發，時間一起算進總計
      const holdRows = it.queueOnHold ? (it.holdStops || []).map((x, i) => `<div class="it-step"><span class="no">${i + 1}</span><span><b>${escapeHtml(x.poi.name)}</b><small>回到避難所後接著前往・🚶 移動 ${formatDuration(x.travelMs)}・🔍 搜索 ${formatDuration(x.searchMs)}</small></span><span class="t"><b>${formatDuration(x.totalMs)}</b>${btn('移除', 'dequeue', { i }, { cls: 'btn-xs btn-ghost' })}</span></div>`).join('') : '';
      const homeRow = it.stops.length || it.holdStops?.length ? `<div class="it-step home"><span class="no">🏠</span><span><b>回到避難所</b><small>🏃 從最後一站回家</small></span><span class="t"><b>${formatDuration(it.backMs)}</b></span></div>` : '';
      return `
      <p class="muted">👥 ${names || `${ex.memberIds.length} 人`}</p>
      <div class="it-sum">${guarding ? '<span>🛡️ 駐防中，撤回後才回到避難所</span>' : `<span>⏱ 總計 <b>${formatDuration(it.totalMs)}</b></span><span>🏠 預計 <b>${hm}</b> 回到避難所</span>`}${ex.kind === 'explore' ? `<span>🧭 佇列 <b>${qn}/${g.exploration.queueLimit()}</b></span>` : ''}</div>
      ${curRow}${stopRows}${holdRows}${homeRow}
      ${it.stops.length || it.holdStops?.length ? '<small class="muted block">預估時間依隊員速度、載具與日夜計算；途中遇到戰鬥或背包裝滿提早回家時會有變動。</small>' : ''}
      ${this.ui.panels.explore.checkpointHtml(ex)}
      ${this.chainHtml(ex)}
      ${canRecall ? `<p class="muted">${'召回後隊伍會從目前位置走回避難所（需要移動時間），只會帶回已經到過的檢核點找到的物資。'}</p>` : ''}
      <div class="btn-row">${canRecall ? btn('↩️ 召回', 'recall', {}, { cls: 'btn-danger' }) : ''}</div>`;
    };
    this.ui.modal.open({
      title: '🚶 我的探索隊',
      body: body(),
      live: body,
      onAction: (action, data, m) => {
        if (action === 'dequeue') {
          this.ui.result(g.exploration.dequeue(expId, +data.i));
          m.update(body());
          return;
        }
        if (action === 'toggleChain') {
          this.ui.result(g.exploration.toggleChain(expId));
          m.update(body());
          return;
        }
        m.close();
        if (action === 'recall') {
          const r = this.ui.result(g.exploration.recall(expId));
          if (r.ok) this.renderMap(true);
        }
      },
    });
  }

  openTeam(team) {
    const g = this.game;
    if (team.kind === 'own') {
      this.openOwnTeam(team.expId);
      return;
    }
    if (team.kind === 'rally') {
      this.openRally(team.rallyId);
      return;
    }
    const t = g.intercept.target(team);
    if (!t) {
      this.ui.toastEl.show('這支隊伍已經離開了', 'info');
      return;
    }
    const check = g.intercept.canIntercept(team);
    const sh = g.shelter.primary();
    const dist = sh ? Math.round(haversine(sh.lat, sh.lon, t.lat, t.lon)) : 0;
    const rel = t.kind === 'player' ? g.territory.relation(t.playerId) : 'hostile';
    const body = `
      <p>${t.kind === 'npc' ? '🏴‍☠️' : '👤'} <b>${escapeHtml(t.name)}</b>・${t.kind === 'npc' && g.npcs.intel() < 3 ? '人數不明' : `${t.members} 人`}・${t.kind === 'npc' ? g.npcs.intelView(g.npcs.get(t.npcId)).level : `約 Lv${t.level}`}${dist ? `・距避難所 ${dist} 公尺` : ''}</p>
      <p>${t.phase === 'searching' ? `🔍 正在搜索，約 ${formatDuration(Math.max(0, t.searchEnd - Date.now()))} 後離開` : '🚶 移動中（追不上，等對方停下搜索時才能攔截）'}</p>
      <p class="muted">派隊攔截：前往對方正在搜索的地點，抵達時交戰；抵達前對方已經離開就會撲空。被擊敗的一方會空手走回自己的據點（返程不公開），身上背包的物資全部被搶走，每件裝備有 ${Math.round(5)}% 機率被搶走。${t.kind === 'player' ? '攻擊後雙方進入敵對。' : ''}</p>
      ${rel === 'friend' ? '<p class="tag tag-green">🤝 友好玩家，無法攻擊</p>' : ''}
      <div class="btn-row">${btn('⚔️ 派隊攔截', 'intercept', {}, { cls: 'btn-danger', disabled: !check.ok, title: check.reason || '' })}</div>
      ${check.ok ? '' : `<small class="muted">${escapeHtml(check.reason)}</small>`}`;
    this.ui.modal.open({
      title: t.kind === 'npc' ? '🏴‍☠️ NPC 隊伍' : '👤 其他玩家的隊伍',
      body,
      onAction: (action, _data, m) => {
        if (action !== 'intercept') return;
        m.close();
        openTeamPicker(this.ui, {
          title: `⚔️ 攔截：${t.name}`,
          intro: `<p class="muted">${t.kind === 'npc' ? `對方 ${g.npcs.intel() >= 3 ? `${t.members} 人、` : ''}${g.npcs.intelView(g.npcs.get(t.npcId)).level}` : `對方 ${t.members} 人、約 Lv${t.level}`}。要在對方離開搜索地點前抵達，帶載具可以更快趕到。</p>`,
          vehicles: true,
          distanceM: dist,
          trip: { poi: { id: t.id, lat: t.lat, lon: t.lon, type: 'military', intercept: true }, searchMin: 0 },
          confirmLabel: '出發攔截！',
          onConfirm: (ids, _dur, _auto, vids) => {
            const r = this.ui.result(g.intercept.start(team, ids, { vehicleIds: vids }));
            if (r.ok) this.renderMap(true);
            return r;
          },
        });
      },
    });
  }

  showLegend() {
    const rows = Object.values(POI_TYPES).map((p) => `<div class="legend-row"><span class="poi-pin" style="--c:${p.color}">${p.icon}</span> ${p.name} <span class="danger">${stars(p.danger)}</span><small>${Object.keys(p.loot).map((k) => LOOT_CATS[k].icon).join('')}</small></div>`).join('');
    // v15.18：避難所沒有大小之分、只能建在安全區，圖例不再列據點規模與各區屍潮倍率
    this.ui.modal.open({ title: '🧾 圖例', body: `${rows}<h4>區域危險度</h4>${ZONES.map((z) => `<div class="legend-row"><span class="zone-tag" style="--zc:${z.color}">${z.name}</span><small>物資 ×${z.lootMul}</small></div>`).join('')}<div class="legend-row"><span class="npc-pin" style="width:28px;height:28px;font-size:14px">🏴‍☠️</span> NPC 據點：會升級、探索與掠奪，可攻打搶奪資源</div><p class="muted">金框是你的據點（⭐ 為主要據點），青框是其他玩家的據點。</p><p class="muted">☠ 越多越危險；距離避難所越遠危險度越高。紅框為探索範圍。</p><p class="muted">地圖底色代表區域危險度，區域交界有細邊界線；建築圓點與圖示的顏色代表建築類型。右側 ☣️ 按鈕可開關危險度圖層。</p>` });
  }

  poiBody(poi) {
    const g = this.game;
    const pt = POI_TYPES[poi.type];
    const sh = g.shelter.primary();
    const base = g.shelter.baseAtPoi(poi.id);
    const dist = sh && !g.shelter.isPrimary(base) ? Math.round(haversine(sh.lat, sh.lon, poi.lat, poi.lon)) : null;
    const danger = g.zombies.areaDanger(poi);
    const zone = zoneAt(poi.lat, poi.lon);
    const groups = g.state.map.zombieGroups.filter((z) => z.poiId === poi.id);
    const exploring = g.state.expeditions.filter((e) => e.poiId === poi.id).length;
    const actions = [];
    let establish = '';
    const z = g.shelter.sizeInfo(poi);
    void z;
    // v15.18：避難所沒有大小之分（一律 11 格防禦）；只有建築危險度會影響屍潮
    const sizeLine = `<small class="muted block">🏠 建立後一律為避難所：防禦欄位 ${BASE_SIZES.huge.slots} 格・警戒範圍 ${BASE_SIZES.huge.alert} 公尺・據點危險度 ${pt.danger} 起（隨文明度增加；越高屍潮殭屍等級與頻率越高）</small>`;
    if (base) {
      actions.push(btn('🏠 進入據點', 'enterShelter', {}, { cls: 'btn-primary' }));
      actions.push(btn(base.kind === 'outpost' ? '🏚️ 放棄' : '🚚 搬遷', 'abandon', {}, { cls: 'btn-ghost' }));
    } else if (!g.shelter.hasShelter()) {
      actions.push(btn('🏠 設為避難所', 'setShelter', {}, { cls: 'btn-primary' }));
      // 搬遷中：這個地點較小時，超過上限的設施會降級
      establish = `${sizeLine}${g.state.relocation ? '<small class="block pos">✅ 搬遷保留的設施等級全部不變</small>' : ''}`;
    } else {
      {
        const ve = g.poiShare.view(poi);
        // v14：控制點區域要自己或好友佔領才能探索
        const ce = g.state.map.source === 'generated' ? g.cp.canExplore(poi) : { ok: true };
        actions.push(btn(ve.empty ? '🕸️ 已搜空' : ve.left ? '🧭 繼續探索' : '🧭 派遣探索', 'explore', {}, { cls: 'btn-primary', disabled: ve.empty || !ce.ok, title: ce.reason || '' }));
        if (!ce.ok) {
          const c = cpAt(poi.lat, poi.lon);
          establish += `<small class="block neg">🚩 ${escapeHtml(ce.reason)}</small>${c ? btn(`🚩 查看控制點 #${c.no}`, 'openCpOf', { id: c.id }, { cls: 'btn-sm btn-ghost' }) : ''}`;
        }
      }
      // v14：改版後一次免費重新選擇避難所（只能選左側安全區）
      if (g.state.freeRelocate) {
        const fm = g.shelter.canFreeMove(poi);
        actions.push(btn('🏠 免費搬到這裡', 'freeMove', {}, { cls: 'btn-primary', disabled: !fm.ok, title: fm.reason || '' }));
        if (!fm.ok) establish = `<small class="block muted">🏠 免費重選避難所：${escapeHtml(fm.reason)}</small>`;
        else establish = '<small class="block pos">🏠 整座搬過來：設施、防禦建築、資源全部保留（只能使用一次）</small>';
      }
    }
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:${pt.color}">${pt.icon}</div>
        <div>
          <b>${pt.name}</b>
          ${base ? `<div><span class="tag tag-amber">${g.shelter.isPrimary(base) ? '⭐ 避難所' : '🏴 前哨站'}</span> 據點危險度 <b>${g.shelter.dangerLevel(base)}</b></div>` : `<div>危險度 <span class="danger">${stars(danger)}</span> ${pt.special ? '<span class="tag tag-red">高級怪物</span>' : ''}</div>`}
          <div><span class="zone-tag" style="--zc:${zone.color}">${zone.name}</span> <small class="muted">物資 ×${zone.lootMul}・殭屍 +${Math.max(0, zone.danger)} 危險度</small></div>
          ${dist != null ? `<div class="muted">距避難所 ${dist} 公尺</div>` : ''}
          ${this.stockHtml(poi)}
          ${exploring ? `<div class="tag tag-blue">${exploring} 支隊伍探索中</div>` : ''}
        </div>
      </div>
      ${groups.length ? `<div class="label">附近殭屍</div>${groups.map((z) => `<div class="row-between"><span>${ALL_ENEMIES[z.enemyId].icon} ${g.zombies.groupLabel(z)}</span>${btn('⚔️ 攻擊', 'attack', { id: z.id }, { cls: 'btn-danger btn-sm', disabled: !g.shelter.hasShelter() })}</div>`).join('')}` : ''}
      <div class="btn-row">${actions.join('')}</div>${establish}`;
  }

  openPoi(poiId) {
    const poi = this.game.state.map.pois.find((p) => p.id === poiId);
    if (!poi) return;
    this.ui.modal.open({
      title: `${POI_TYPES[poi.type].icon} ${poi.name}`,
      body: this.poiBody(poi),
      live: () => this.poiBody(poi),
      onAction: (action, data, m) => {
        if (action === 'openCpOf') { this.openCp(data.id); return; }
        if (action === 'freeMove') {
          const r = this.ui.result(this.game.shelter.freeMove(poi));
          if (r.ok) {
            m.close();
            this.renderMap(true);
            this.game.zombies.refresh();
          }
          return;
        }
        if (action === 'setShelter') {
          const r = this.ui.result(this.game.shelter.establish(poi));
          if (r.ok) {
            m.close();
            this.renderMap(true);
            this.game.zombies.refresh();
            this.ui.setViewBase(r.base.id);
            this.ui.switchTab('shelter');
          }
        } else if (action === 'abandon') {
          const base = this.game.shelter.baseAtPoi(poi.id);
          if (base) openAbandonDialog(this.ui, base, () => { m.close(); this.renderMap(true); });
        } else if (action === 'enterShelter') {
          m.close();
          this.ui.setViewBase(this.game.shelter.baseAtPoi(poi.id)?.id);
          this.ui.switchTab('shelter');
        } else if (action === 'explore') {
          this.openExplore(poi);
        } else if (action === 'attack') {
          this.attackGroup(data.id);
        }
      },
    });
  }

  openExplore(poi) {
    const g = this.game;
    openTeamPicker(this.ui, {
      title: `🧭 探索：${poi.name}`,
      intro: `<p class="muted pk-intro" title="搜索時間依地點大小與危險度；偵察兵、裝備、研究與隊員人數可縮短。移動時間依距離、隊員速度與載具另外計算。">${POI_TYPES[poi.type].name}・危險度 ${stars(g.zombies.areaDanger(poi))}・敵人約 Lv${g.zombies.buildingLevel(poi, g.time.phase())}・🔍 基本搜索 ${formatDuration(g.exploration.searchMinutes(poi) * 60000)}${g.poiShare.view(poi).left ? '（只剩部分）' : ''}</p>`,
      withDuration: true,
      fixedDuration: true,
      vehicles: true,
      distanceM: g.shelter.primary() ? haversine(g.shelter.primary().lat, g.shelter.primary().lon, poi.lat, poi.lon) : 0,
      trip: { poi, searchMin: g.exploration.searchMinutes(poi) },
      routeOption: true,
      squads: true,
      quickQueue: true,
      confirmLabel: '出發！',
      onConfirm: (ids, dur, auto, vids, opts) => {
        // 選了臨時小隊：加入它的探索佇列
        if (opts.squadId) {
          // 指定載具：先檢查（可以時才加入佇列），加入佇列成功後再套用
          const check = g.exploration.assignVehicles(opts.squadId, vids, { dry: true });
          if (!check.ok) return this.ui.result(check);
          const q = this.ui.result(g.exploration.enqueue(opts.squadId, poi.id));
          if (q.ok) {
            if (vids.length) this.ui.result(g.exploration.assignVehicles(opts.squadId, vids));
            if (g.exploration.quickQueueOn()) this.ui.result(g.exploration.quickFill(opts.squadId));
            this.renderMap(true);
          }
          return q;
        }
        const r = this.ui.result(g.exploration.start(poi.id, ids, dur, auto, Date.now(), { vehicleIds: vids, ...opts }));
        if (r.ok && g.exploration.quickQueueOn()) this.ui.result(g.exploration.quickFill(r.exp.id));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }

  zombieBody(gr) {
    const e = ALL_ENEMIES[gr.enemyId];
    const sample = this.game.combat.createEnemy(gr.enemyId, gr.level, gr.elite);
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:#b71c1c">${e.icon}</div>
        <div>
          <b>${this.game.zombies.groupLabel(gr)}</b> ${gr.boss ? '<span class="tag tag-red">BOSS</span>' : ''}
          <div class="muted">單體：生命 ${sample.maxHp}・攻擊 ${sample.atk}・防禦 ${sample.def}</div>
          <div class="muted">擊殺可得經驗、金錢、材料，並有機率掉落裝備</div>
        </div>
      </div>
      <div class="btn-row">${btn('⚔️ 派隊攻擊', 'attack', { id: gr.id }, { cls: 'btn-danger', disabled: !this.game.shelter.hasShelter() })}</div>`;
  }

  openZombie(groupId) {
    const gr = this.game.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    this.ui.modal.open({
      title: `${ALL_ENEMIES[gr.enemyId].icon} 殭屍群`,
      body: this.zombieBody(gr),
      onAction: (action, data) => { if (action === 'attack') this.attackGroup(data.id); },
    });
  }

  attackGroup(groupId) {
    const g = this.game;
    const gr = g.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    const sh = g.shelter.primary();
    const label = g.zombies.groupLabel(gr);
    openTeamPicker(this.ui, {
      title: `⚔️ 攻擊 ${label}`,
      intro: '<p class="muted">隊伍會先移動到殭屍群的位置，抵達時自動交戰，再返回避難所。倒下的隊員會受傷，需要休養或使用藥品治療。天亮前沒趕到的話殭屍會躲回建築內。</p>',
      vehicles: true,
      distanceM: sh ? haversine(sh.lat, sh.lon, gr.lat, gr.lon) : 0,
      trip: {
        poi: {
          id: `hunt:${gr.id}`, lat: gr.lat, lon: gr.lon, type: 'military', hunt: true,
        },
        searchMin: 0,
      },
      routeOption: true,
      confirmLabel: '出發攻擊！',
      onConfirm: (ids, _dur, _auto, vids, opts) => {
        const r = this.ui.result(g.exploration.startHunt(groupId, ids, { vehicleIds: vids, ...opts }));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }
}
