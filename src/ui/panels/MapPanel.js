import { MapService } from '../../map/MapService.js';
import { POI_TYPES, LOOT_CATS } from '../../config/poiTypes.js';
import { ALL_ENEMIES } from '../../config/enemies.js';
import { BASE_SIZES, FACILITY_COUNT } from '../../config/civilization.js';
import { delegateActions, escapeHtml } from '../../utils/dom.js';
import { haversine, formatDuration } from '../../utils/math.js';
import { isLooted, msToReset, stockOf } from '../../systems/LootStock.js';
import { EXP_PHASES, tripProgress } from '../../systems/ExplorationSystem.js';
import {
  btn, costHtml, metaOf, itemCard,
} from '../components.js';
import { SUPPLIES, SUPPLY_CATS } from '../../config/supplies.js';
import { remainOf } from '../../systems/LootStock.js';
import { MAX_MARKERS } from '../../systems/MarkerSystem.js';
import { openTeamPicker } from '../TeamPicker.js';
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
    this.service.renderTrader(this.game.state.trader, this.game.trader.isHere());
  }

  /** 流浪商人：用金錢購買物品（越稀有越貴） */
  openTrader() {
    const g = this.game;
    const body = () => {
      if (!g.trader.isHere()) return '<p class="muted">流浪商人已經離開了。他會在遊戲時間早上 11 點有機率再出現。</p>';
      const t = g.state.trader;
      const rows = t.stock.map((x) => {
        const afford = g.state.player.coins >= x.price;
        if (x.kind === 'gear') {
          return itemCard(x.item, { actions: btn(`💰${x.price} 購買`, 'buy', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !afford }) });
        }
        const sp = SUPPLIES[x.key];
        return `<div class="card row-between"><div><b>${sp.icon} ${sp.name} ×${x.qty}</b>
          <small class="muted block">${SUPPLY_CATS[sp.cat].name}・${'★'.repeat(sp.tier)}${sp.heal ? `・回復 ${Math.round(sp.heal * 100)}%` : ''}・倉庫有 ${g.state.supplies?.[x.key] || 0}</small></div>
          ${btn(`💰${x.price} 購買`, 'buy', { id: x.id }, { cls: 'btn-xs btn-primary', disabled: !afford })}</div>`;
      }).join('');
      return `<p class="muted">🧳 帶著稀奇物品四處流浪的商人，越稀有的東西越貴。距避難所 ${g.trader.distance()} 公尺・⏱ ${formatDuration(g.trader.remainingMs())}後離開（遊戲時間 15:00）。</p>
        <p>💰 你的金錢：<b>${g.state.player.coins}</b></p>
        <div class="grid">${rows || '<p class="muted">商品都賣完了。</p>'}</div>`;
    };
    this.ui.modal.open({
      title: '🧳 流浪商人',
      wide: true,
      body: body(),
      live: body,
      onAction: (action, data, m) => {
        if (action === 'buy') this.ui.result(g.trader.buy(data.id));
        m.update(body());
      },
    });
  }

  /** NPC 據點資訊與攻打 */
  npcBody(n) {
    const g = this.game;
    const now = Date.now();
    const zone = zoneAt(n.lat, n.lon);
    const enemies = g.npcs.garrison(n);
    const loot = Object.entries(n.resources).filter(([, v]) => v > 0).map(([k, v]) => `${metaOf(k).icon}${Math.floor(v)}`).join(' ');
    const sh = g.shelter.primary();
    const dist = sh ? Math.round(haversine(sh.lat, sh.lon, n.lat, n.lon)) : null;
    const trip = n.trip && n.trip.endAt > now ? n.trip : null;
    const aggr = g.npcs.aggression();
    return `
      <p>🏴‍☠️ <b>${escapeHtml(n.name)}</b>・Lv${n.level}・<span class="zone-tag" style="--zc:${zone.color}">${zone.name}</span>${dist != null ? `・距避難所 ${dist} 公尺` : ''}</p>
      <p class="muted">守軍：${enemies.map((e) => `${e.icon}${e.name}`).join('、')}（等級 ${n.level}）</p>
      <p>💰${n.coins} ${loot}</p>
      <p class="muted">積極度 ${Math.round(aggr * 100)}%（你的文明度越高，NPC 越常來掠奪）。夜晚屍潮期間 NPC 不會出動。</p>
      ${trip ? `<p class="${trip.kind === 'raid' ? 'neg' : 'muted'}">${trip.kind === 'raid' ? `⚔️ 掠奪隊正前往「${escapeHtml(trip.target)}」` : `🔍 正在搜刮「${escapeHtml(trip.target)}」`}・剩 ${formatDuration(trip.endAt - now)}</p>` : ''}
      <p class="muted">攻陷後可搶走據點的物資與金錢（受隊伍運載量限制），據點會被摧毀，一段時間後別處會出現新的勢力。</p>
      <div class="btn-row">${btn('⚔️ 派隊攻打', 'attackNpc', {}, { cls: 'btn-danger', disabled: !g.shelter.hasShelter() })}</div>`;
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
        if (action !== 'attackNpc') return;
        const sh = g.shelter.primary();
        openTeamPicker(this.ui, {
          title: `⚔️ 攻打：${n.name}`,
          intro: `<p class="muted">守軍 Lv${n.level}・建議戰力 ${Math.round(g.npcs.power(n))} 以上。帶載具可以搬走更多物資。</p>`,
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
    this.ui.mapRoot.dataset.phase = this.game.time.phaseId(); // 地圖依日夜變暗
    const st = this.game.state;
    const has = this.game.shelter.hasShelter();
    const src = { overpass: 'OpenStreetMap', generated: '程序生成（OSM 無法連線）', none: '—' }[st.map.source] || st.map.source;
    const html = `
      ${has ? '' : '<div class="map-hint">👆 點選地圖上任一建築，將它設為你的<b>避難所</b></div>'}
      <div class="map-tools">
        ${btn('🏰', 'gotoShelter', {}, { cls: 'btn-icon', disabled: !has, title: '回到避難所' })}
        ${btn(this.scanning ? '⏳' : '🔄', 'rescan', {}, { cls: 'btn-icon', disabled: this.scanning, title: '重新掃描附近建築' })}
        ${btn('🧾', 'legend', {}, { cls: 'btn-icon', title: '圖例' })}
        ${btn('📍', 'gps', {}, { cls: `btn-icon ${this.game.gps.enabled ? 'on' : ''}`, title: 'GPS 偵測附近 50 公尺的建築' })}
        ${btn(`📌${this.game.markers.list.length ? `<small>${this.game.markers.list.length}</small>` : ''}`, 'markers', {}, { cls: 'btn-icon', title: `標記的地點（最多 ${MAX_MARKERS} 個）` })}
      </div>
      ${this.siegeBanner()}
      ${this.scanning ? `<div class="scan-progress">📡 掃描建築中 ${this.scanProgress || ''}</div>` : ''}
      ${this.worldChip()}
      ${this.gpsChip()}
      <div class="map-info">建築 ${st.map.pois.length}・殭屍群 ${st.map.zombieGroups.length}・資料：${src}</div>`;
    if (html !== this.lastOverlay) {
      this.lastOverlay = html;
      this.overlay.innerHTML = html;
    }
  }

  /** GPS 偵測狀態 */
  gpsChip() {
    const gps = this.game.gps;
    if (!gps.enabled) return '';
    const text = {
      locating: '📡 GPS 定位中…',
      active: `📡 GPS 偵測：50m 內 ${gps.nearby.length} 棟建築（可看今日物資）`,
      inBase: '🏠 在據點範圍內，不偵測',
      denied: '📡 未允許定位，請在瀏覽器設定開啟位置權限',
      unsupported: '📡 此裝置不支援定位',
      error: `📡 定位失敗：${gps.error || ''}`,
    }[gps.status] || '📡 GPS';
    return `<button class="world-chip gps-chip" data-action="gpsFocus">${text}</button>`;
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
    return `<p>${relTag} 🏛️ 文明度 <b>${p.civ}</b>・據點 ${p.bases.length} 個・外出隊伍 ${trips.length} 支</p>
      <div class="btn-row">${diplo}</div>
      <div class="pick-list">${p.bases.map((b, i) => `<div class="pick-row"><span>${b.primary ? '⭐' : '🏴'} ${escapeHtml(b.name)}</span><small class="muted">警戒 ${b.alert}m・駐守 ${b.guards} 人</small>
        <span>${btn('📍', 'fly', { i }, { cls: 'btn-xs btn-ghost' })}${rel === 'friend' ? '' : btn('⚔️ 攻擊', 'attackBase', { i }, { cls: 'btn-xs btn-danger' })}</span></div>`).join('')}</div>
      ${trips.length ? `<div class="label">探索中</div><ul class="event-list">${trips.map((x) => `<li>${EXP_PHASES[tripProgress(x, now).phase].icon} 前往「${escapeHtml(x.target || '某處')}」・${x.members} 人・剩 ${formatDuration(x.endAt - now)}</li>`).join('')}</ul>` : ''}
      <p class="muted">玩家之間預設中立：探索時會繞開對方的警戒範圍。攻擊後雙方變成敵對——敵對時經過對方有駐守人員的據點範圍會遭到攻擊。友好需要雙方同意，友好時不能互相攻擊。</p>`;
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

  /** 可能出現的物資（實際種類與數量要探索時才知道；探索後清空，每天 00:00 重置） */
  stockHtml(poi) {
    const reset = `每天 00:00 重置（${formatDuration(msToReset())}後）`;
    const fmt = (res) => Object.entries(res).map(([k, v]) => `${metaOf(k).icon}${metaOf(k).name} ${v}`).join('、');
    // 上次探索帶不走而殘留的物資：直接顯示剩餘數量
    const left = remainOf(poi, this.game.state.map.remain);
    if (left) return `<div class="pos">📦 殘留物資（上次帶不走留下的）：${fmt(left)}・${reset}</div>`;
    if (isLooted(poi)) return `<div class="muted">🕸️ 今日已被搜刮一空・${reset}</div>`;
    if (this.game.gps.isDetected(poi)) {
      const st = stockOf(poi);
      return `<div class="pos">📡 GPS 偵測到今日物資：${fmt(st.resources)}・${reset}</div>`;
    }
    const list = Object.keys(POI_TYPES[poi.type].loot).map((k) => `${LOOT_CATS[k].icon}${LOOT_CATS[k].name}`).join('、');
    return `<div class="muted">📦 可能出現：${list}（實際所得於探索時隨機）・${reset}</div>`;
  }

  /** 各據點即時屍潮摘要；點擊可飛到該據點 */
  siegeBanner() {
    const g = this.game;
    const rows = g.state.bases.map((b) => {
      const s = g.siege.of(b.id);
      const ratio = g.shelter.wallHp(b) / g.shelter.wallMax(b);
      return { b, n: s.zombies.length, ratio };
    }).filter((r) => r.n > 0 || r.ratio < 0.999);
    if (!rows.length) return '';
    return `<div class="siege-banner">${rows.map(({ b, n, ratio }) => `
      <button class="siege-chip ${ratio < 0.3 ? 'danger' : ''}" data-action="flyTo" data-id="${b.id}">
        ${g.shelter.isPrimary(b) ? '⭐' : '🏠'} ${escapeHtml(b.name)}・🧟${n}・🧱${Math.round(ratio * 100)}%
      </button>`).join('')}</div>`;
  }

  async onAction(action, data = {}) {
    const sh = this.game.shelter.primary();
    if (action === 'gotoShelter' && sh) this.service.focus(sh.lat, sh.lon);
    if (action === 'markers') this.openMarkers();
    if (action === 'legend') this.showLegend();
    if (action === 'gps') {
      const on = !this.game.gps.enabled;
      this.game.gps.setEnabled(on);
      this.ui.toastEl.show(on ? '📡 已開啟 GPS 偵測：靠近建築 50 公尺內即可看到今日物資' : '已關閉 GPS 偵測', 'info');
    }
    if (action === 'gpsFocus' && this.game.gps.pos) this.service.focus(this.game.gps.pos.lat, this.game.gps.pos.lon, 18);
    if (action === 'worldSettings') this.ui.switchTab('settings');
    if (action === 'flyTo') {
      const b = this.game.shelter.base(data.id);
      if (b) this.service.focus(b.lat, b.lon, 17);
    }
    if (action === 'rescan') {
      if (this.scanning) return;
      this.scanning = true;
      this.scanProgress = '';
      this.renderOverlay();
      const c = sh || this.game.state.map.center;
      this.ui.toastEl.show(`📡 掃描避難所${this.game.shelter.outposts().length ? `與 ${this.game.shelter.outposts().length} 座前哨站` : ''}附近的建築中，市區可能需要 30 秒～1 分鐘…`, 'info', 6000);
      const r = await this.game.scanMap(c.lat, c.lon, (done, total) => {
        this.scanProgress = `${done}/${total}`;
        this.lastOverlay = '';
        this.renderOverlay();
      });
      this.scanning = false;
      this.scanProgress = '';
      this.ui.toastEl.show(`發現 ${r.count} 個地點（${r.source === 'overpass' ? 'OSM' : '程序生成'}）`, 'success');
      this.renderMap(true);
    }
  }

  /** 野外隊伍（其他玩家或 NPC）：顯示資訊並可派隊攔截 */
  openTeam(team) {
    const g = this.game;
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
      <p>${t.kind === 'npc' ? '🏴‍☠️' : '👤'} <b>${escapeHtml(t.name)}</b>・${t.members} 人・約 Lv${t.level}${dist ? `・距避難所 ${dist} 公尺` : ''}</p>
      <p class="muted">派隊攔截：前往對方目前的位置，抵達時交戰。被擊敗的一方會空手走回自己的據點（返程不公開），身上背包的物資全部被搶走，每件裝備有 ${Math.round(5)}% 機率被搶走。${t.kind === 'player' ? '攻擊後雙方進入敵對。' : ''}</p>
      <p class="muted">⏱ 對方行程剩 ${formatDuration(Math.max(0, t.endAt - Date.now()))}，太遠的話可能在你抵達前就回到據點。</p>
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
          intro: `<p class="muted">對方 ${t.members} 人、約 Lv${t.level}。帶載具可以更快追上。</p>`,
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

  /** 標記地點清單：飛到該地點、查看建築（可在那裡建立避難所）、移除標記 */
  openMarkers() {
    const g = this.game;
    const body = () => {
      const list = g.markers.list;
      const sh = g.shelter.primary();
      const rows = list.map((m) => {
        const pt = POI_TYPES[m.type];
        const dist = sh ? `・距避難所 ${Math.round(haversine(sh.lat, sh.lon, m.lat, m.lon))} 公尺` : '';
        const z = g.shelter.sizeInfo(m);
        return `<div class="card row-between"><div><b>${pt?.icon || '📍'} ${escapeHtml(m.name)}</b>
          <small class="muted block">${pt?.name || ''}・${BASE_SIZES[z.id].icon} ${z.name}據點（可建 ${z.total} 棟）${dist}</small></div>
          <span>${btn('前往', 'go', { id: m.id }, { cls: 'btn-xs btn-primary' })}${btn('移除', 'remove', { id: m.id }, { cls: 'btn-xs btn-ghost' })}</span></div>`;
      }).join('');
      return `<p class="muted">GPS 只能偵測身邊 50 公尺的建築。把建築標記起來（最多 ${MAX_MARKERS} 個），走遠或重新掃描後仍會保留在地圖上，方便日後在那裡建立避難所。在建築資訊中按「📌 標記地點」即可加入。</p>
        ${rows || '<p class="muted">還沒有標記任何地點。</p>'}`;
    };
    this.ui.modal.open({
      title: `📌 標記的地點（${g.markers.list.length}/${MAX_MARKERS}）`,
      body: body(),
      onAction: (action, data, m) => {
        if (action === 'go') {
          const mk = g.markers.list.find((x) => x.id === data.id);
          m.close();
          if (mk) {
            this.service.focus(mk.lat, mk.lon, 18);
            this.openPoi(mk.id);
          }
          return;
        }
        if (action === 'remove') {
          this.ui.result(g.markers.unmark(data.id));
          this.renderMap(true);
        }
        m.update(body());
      },
    });
  }

  showLegend() {
    const rows = Object.values(POI_TYPES).map((p) => `<div class="legend-row"><span class="poi-pin" style="--c:${p.color}">${p.icon}</span> ${p.name} <span class="danger">${stars(p.danger)}</span><small>${Object.keys(p.loot).map((k) => LOOT_CATS[k].icon).join('')}</small></div>`).join('');
    const sizes = Object.entries(BASE_SIZES).map(([k, z]) => `<div class="legend-row"><span class="shelter-pin size-${k}" style="--d:${z.pin}px">${z.icon}<i class="size-tag">${z.name[0]}</i></span> ${z.name}據點 <small>可建 ${FACILITY_COUNT + z.slots} 棟</small></div>`).join('');
    this.ui.modal.open({ title: '🧾 圖例', body: `${rows}<h4>據點規模</h4>${sizes}<h4>區域危險度</h4>${ZONES.map((z) => `<div class="legend-row"><span class="zone-tag" style="--zc:${z.color}">${z.name}</span><small>物資 ×${z.lootMul}・屍潮 ×${z.siegeMul}・殭屍 +${z.siegeLevel} 級</small></div>`).join('')}<div class="legend-row"><span class="npc-pin" style="width:28px;height:28px;font-size:14px">🏴‍☠️</span> NPC 據點：會升級、探索與掠奪，可攻打搶奪資源</div><p class="muted">金框是你的據點（⭐ 為主要據點），青框是其他玩家的據點。</p><p class="muted">☠ 越多越危險；距離避難所越遠危險度越高。紅框為探索範圍。</p>` });
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
    const sizeLine = `<small class="muted block"><span class="size-chip" style="--sc:${BASE_SIZES[z.id].color}">${BASE_SIZES[z.id].icon} ${z.name}</span>據點：可建造 ${z.total} 棟建築（防禦欄位 ${z.slots}）・屍潮 ×${BASE_SIZES[z.id].siegeMul}</small>`;
    if (base) {
      actions.push(btn('🏠 進入據點', 'enterShelter', {}, { cls: 'btn-primary' }));
      actions.push(btn('🏚️ 放棄', 'abandon', {}, { cls: 'btn-ghost' }));
    } else if (!g.shelter.hasShelter()) {
      actions.push(btn('🏠 設為避難所', 'setShelter', {}, { cls: 'btn-primary' }));
      establish = sizeLine;
    } else {
      const check = g.shelter.canEstablish(poi);
      actions.push(btn('🧭 派遣探索', 'explore', {}, { cls: 'btn-primary' }));
      actions.push(btn(`🏴 建立前哨站（${g.shelter.outposts().length}/${g.shelter.outpostLimit()}）`, 'setShelter', {}, { cls: 'btn-ghost', disabled: !check.ok, title: check.reason || '' }));
      establish = `${sizeLine}<small class="muted block">前哨站只有防禦功能。建立費用：<span class="costs inline">${costHtml(g.state, g.shelter.establishCost())}</span>${check.ok ? '' : `（${check.reason}）`}</small>`;
    }
    const marked = g.markers.isMarked(poi.id);
    if (!base) actions.push(btn(marked ? '📌 取消標記' : `📌 標記地點（${g.markers.list.length}/${MAX_MARKERS}）`, marked ? 'unmark' : 'mark', {}, { cls: 'btn-ghost' }));
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:${pt.color}">${pt.icon}</div>
        <div>
          <b>${pt.name}</b>${poi.osm ? ' <small class="tag">OSM</small>' : pt.generated ? ' <small class="tag">資源點</small>' : ' <small class="tag">傳聞</small>'}${marked ? ' <small class="tag tag-amber">📌 已標記</small>' : ''}
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
        } else if (action === 'mark' || action === 'unmark') {
          this.ui.result(action === 'mark' ? this.game.markers.mark(poi) : this.game.markers.unmark(poi.id));
          this.renderMap(true);
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
      intro: `<p class="muted">${POI_TYPES[poi.type].name}・危險度 ${stars(g.zombies.areaDanger(poi))}・敵人等級約 Lv${g.zombies.areaLevel(poi)}</p>
        <p class="muted">🔍 基本搜索時間 ${g.exploration.searchMinutes(poi)} 分鐘（依地點大小與危險度；偵察兵、裝備、研究與隊員人數可縮短）。移動時間依距離、隊員速度與載具另外計算。</p>`,
      withDuration: true,
      fixedDuration: true,
      vehicles: true,
      distanceM: g.shelter.primary() ? haversine(g.shelter.primary().lat, g.shelter.primary().lon, poi.lat, poi.lon) : 0,
      trip: { poi, searchMin: g.exploration.searchMinutes(poi) },
      routeOption: true,
      confirmLabel: '出發！',
      onConfirm: (ids, dur, auto, vids, opts) => {
        const r = this.ui.result(g.exploration.start(poi.id, ids, dur, auto, Date.now(), { vehicleIds: vids, ...opts }));
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
