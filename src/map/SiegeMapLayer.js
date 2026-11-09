import { FACTIONS } from '../config/controlPoints.js';
import L from 'leaflet';
import { WORLD } from '../systems/SiegeSystem.js';
import { bus } from '../core/EventBus.js';
import { EXP_PHASES, phaseIcon, phaseName, AMBUSH_RADIUS_M, tripProgress } from '../systems/ExplorationSystem.js';
import { RallySystem } from '../systems/RallySystem.js';
import { rallyTripView } from '../multiplayer/WorldSync.js';
import { formatDuration } from '../utils/math.js';
import { IDLE_LOW_FPS } from '../config/constants.js';

/** 停在目的地時的狀態名稱（不是探索） */
const STAY_NAMES = { assist: '🛡️ 協防中', cpGuard: '🛡️ 駐防中' };

/** 屍潮世界座標 1 單位 = 1.5 公尺（出生圈半徑 150 → 約 225 公尺） */
export const METERS_PER_UNIT = 1.5;
const M_PER_LAT = 111320;
const MAX_FX = 600;
/** 沒有屍潮時的重繪間隔（毫秒） */
const IDLE_FRAME_MS = 250;

const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const FX_COLORS = {
  mg: '#ffee58', em: '#4fc3f7', sniper: '#ffffff', guard: '#ffcc80', melee: '#ef9a9a',
};

/**
 * 地圖上的即時屍潮圖層：在每個據點周圍繪製來襲殭屍、圍牆、防禦塔與射擊特效。
 * 使用單一 canvas 每幀重繪（比上百個 Leaflet 標記更省效能），不攔截滑鼠事件。
 */
export const SiegeMapLayer = L.Layer.extend({
  initialize(game) {
    this.game = game;
    this.fx = [];
    this.pulses = [];
    this.running = false;
    this.lastT = 0;
  },

  onAdd(map) {
    this.map = map;
    if (!map.getPane('siegePane')) {
      const pane = map.createPane('siegePane');
      pane.style.zIndex = 450; // 在建築標記（600）之下、圖磚之上
      pane.style.pointerEvents = 'none';
    }
    this.canvas = L.DomUtil.create('canvas', 'siege-canvas leaflet-zoom-hide');
    map.getPane('siegePane').appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    map.on('resize move zoomend viewreset', this.reset, this);
    this.unsubs = [
      bus.on('siege:fx', (events) => this.onFx(events)),
      bus.on('siege:breach', ({ baseId }) => this.pulses.push({ baseId, t: 0, ttl: 1.6 })),
    ];
    this.reset();
  },

  onRemove(map) {
    this.stop();
    map.off('resize move zoomend viewreset', this.reset, this);
    this.unsubs.forEach((u) => u());
    this.canvas.remove();
  },

  reset() {
    const size = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
    // 改變大小會清空畫布：一律立刻重畫（拖曳地圖時不會出現空白或錯位）
    this.draw(0);
  },

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      // v15.7 省電：沒有屍潮、射擊特效時每秒畫 4 次（隊伍移動很慢，看起來一樣），有屍潮時才每幀繪製
      if (!(IDLE_LOW_FPS || window.__lowFps) || window.__fullFps || this.fx.length || this.pulses.length || this.game.siege?.live?.() || t - this.lastT >= (window.__idleMs || IDLE_FRAME_MS)) {
        this.draw(Math.min(0.1, (t - this.lastT) / 1000));
        this.lastT = t;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.fx = [];
  },

  onFx(events) {
    if (!this.running) return;
    events.forEach((e) => {
      if (this.fx.length >= MAX_FX) return;
      const ttl = e.type === 'dmg' ? 0.7 : e.type === 'death' ? 0.5 : e.type === 'trap' ? 0.25 : 0.1;
      this.fx.push({ ...e, t: 0, ttl });
    });
  },

  /** 據點中心（容器像素）與每世界單位的像素數 */
  frame(base) {
    const c = this.map.latLngToContainerPoint([base.lat, base.lon]);
    const n = this.map.latLngToContainerPoint([base.lat + 100 / M_PER_LAT, base.lon]);
    // 範圍大小隨探照燈與「精準射擊」科技成長，全部升滿才是完整大小
    const k = ((c.y - n.y) / 100) * METERS_PER_UNIT * this.game.shelter.siegeRangeScale(base);
    return { c, k };
  },

  draw(dt) {
    const ctx = this.ctx;
    const size = this.map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    const { state, shelter, siege } = this.game;
    const frames = new Map();

    state.bases.forEach((base) => {
      const f = this.frame(base);
      frames.set(base.id, f);
      const { c, k } = f;
      const reach = WORLD.SPAWN_R * k;
      if (c.x < -reach || c.y < -reach || c.x > size.x + reach || c.y > size.y + reach) return;
      const s = siege.of(base.id);
      const primary = shelter.isPrimary(base);

      // 屍潮範圍
      ctx.beginPath();
      ctx.arc(c.x, c.y, WORLD.SPAWN_R * k, 0, Math.PI * 2);
      ctx.fillStyle = s.zombies.length ? 'rgba(183,28,28,0.07)' : 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(255,82,82,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      // 圍牆（顏色依耐久）與耐久弧
      const ratio = Math.max(0, Math.min(1, shelter.wallHp(base) / shelter.wallMax(base)));
      const r = Math.round(229 + (141 - 229) * ratio);
      const g = Math.round(57 + (110 - 57) * ratio);
      const b = Math.round(53 + (99 - 53) * ratio);
      ctx.beginPath();
      ctx.arc(c.x, c.y, WORLD.WALL_R * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = Math.max(2, (2 + base.facilities.wall.level * 0.4) * Math.min(k, 2));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, (WORLD.WALL_R + 6) * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.strokeStyle = ratio < 0.3 ? '#ef5350' : '#66bb6a';
      ctx.lineWidth = 3;
      ctx.stroke();

      // 防禦設施不畫在地圖上（攻打據點時不論方向都會開火）

      // 殭屍
      const zr = Math.max(3.5, Math.min(10, 5 * k));
      const showGlyph = k > 0.9;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      s.zombies.forEach((z) => {
        const x = c.x + z.x * k;
        const y = c.y + z.y * k + Math.sin(z.t * 8) * 0.6;
        const rad = z.boss ? zr * 2 : zr;
        const atWall = Math.hypot(z.x, z.y) <= WORLD.WALL_R + 3;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = css(z.color);
        ctx.fill();
        ctx.strokeStyle = z.boss ? '#e040fb' : atWall ? '#ff1744' : 'rgba(0,0,0,0.7)';
        ctx.lineWidth = z.boss || atWall ? 2 : 1.2;
        ctx.stroke();
        if (showGlyph) {
          ctx.font = `${Math.round(rad * 1.5)}px sans-serif`;
          ctx.fillText(z.boss ? '👹' : '🧟', x, y + 0.5);
        }
        if (k > 1.1 && z.hp < z.maxHp) {
          const w = (z.boss ? 26 : 12) * Math.min(k, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(x - w / 2, y - zr - 6, w, 3);
          ctx.fillStyle = '#ef5350';
          ctx.fillRect(x - w / 2, y - zr - 6, w * Math.max(0, z.hp / z.maxHp), 3);
        }
      });

      // 狀態標籤
      if (s.zombies.length) {
        const label = `${primary ? '⭐ ' : ''}🧟 ${s.zombies.length} 來襲`;
        ctx.font = 'bold 12px sans-serif';
        const w = ctx.measureText(label).width + 12;
        const y = c.y - WORLD.WALL_R * k - 34;
        ctx.fillStyle = 'rgba(127,0,0,0.85)';
        ctx.fillRect(c.x - w / 2, y - 9, w, 18);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, c.x, y);
      }
    });

    this.drawFx(ctx, frames, dt);
    this.drawPulses(ctx, frames, dt);
    this.drawExpeditions(ctx, size);
    this.drawOtherTrips(ctx, size);
    this.drawRallies(ctx, size);
  },

  /** 其他玩家的探索隊伍（青色）與 NPC 的探索／掠奪隊（紅色），依行程時間即時推算位置 */
  drawOtherTrips(ctx, size) {
    const now = Date.now();
    this.teams = [];
    (this.game.world?.others || []).forEach((player) => player.trips.forEach((raw) => {
      // v12.2：集結隊伍每一幀依共用的集結資料決定（交戰前不顯示、打完立刻顯示返程）
      const trip = raw.rally ? rallyTripView(raw, this.game.rally?.get?.(raw.rally), now) : raw;
      if (!trip || now > trip.endAt) return;
      // v15.5：出發後目標控制點被佔領的探索隊（對方離線還沒撤回）：不顯示
      if (this.game.cp?.hideOtherTrip?.(trip, now)) return;
      const p = tripProgress(trip, now);
      // 其他玩家的隊伍只看得到移動，看不到剩餘時間；被攔截撤回中的隊伍不能再攔截
      if (trip.kind === 'assist') {
        this.drawTrip(ctx, size, p, `🛡️ ${player.name}・協防`, ['rgba(102,187,106,0.6)', '#2e7d32', '#e8f5e9', 'rgba(27,94,32,0.88)'], false, '協防中');
      } else if (trip.kind === 'cpGuard') {
        // v15.6：其他玩家的控制點駐防隊：顯示「駐防中」（不是搜索中）
        this.drawTrip(ctx, size, p, `🛡️ ${player.name}・駐防`, ['rgba(102,187,106,0.6)', '#2e7d32', '#e8f5e9', 'rgba(27,94,32,0.88)'], false, '駐防中');
      } else if (trip.kind === 'cp') {
        this.drawTrip(ctx, size, p, `⚔️ ${player.name}・攻打控制點`, ['rgba(38,198,218,0.55)', '#00838f', '#e0f7fa', 'rgba(0,77,64,0.85)'], false, '戰鬥中');
      } else this.drawTrip(ctx, size, p, `👤 ${player.name}${trip.defeated ? '・🏳️撤回' : ''}`, ['rgba(38,198,218,0.55)', '#00838f', '#e0f7fa', 'rgba(0,77,64,0.85)'], !!trip.defeated);
      if (trip.id && !trip.defeated) this.teams.push({ kind: 'player', playerId: player.id, tripId: trip.id, pos: p.pos });
    }));
    // 友好玩家的據點正被 NPC 掠奪隊攻打：同樣畫出行軍路線與部隊（只到抵達為止）
    (this.game.world?.others || []).forEach((player) => {
      if (this.game.territory.relation(player.id) !== 'friend') return;
      player.bases.forEach((b) => (b.raids || []).forEach((r) => {
        if (!r.from || now >= r.at) return;
        const trip = {
          from: r.from, to: { lat: b.lat, lon: b.lon }, ...(r.path ? { path: r.path } : {}),
          startAt: r.startAt, travelMs: r.at - r.startAt, searchMs: 0, endAt: r.at,
        };
        const p = tripProgress(trip, now);
        this.drawTrip(ctx, size, p, `⚔️ ${r.npc || 'NPC'}・攻打${player.name}`, ['rgba(229,57,53,0.75)', '#b71c1c', '#ffebee', 'rgba(127,0,0,0.9)'], false);
      }));
    });
    // v15.4：勢力部隊前往控制點、大本營部隊前往探索點：和 NPC 掠奪隊攻打據點一樣畫出行軍路線與部隊
    (this.game.cp?.marchView?.(now) || []).forEach((m) => {
      const trip = { from: m.from, to: m.to, startAt: m.startAt, travelMs: m.arriveAt - m.startAt, searchMs: 0, endAt: m.arriveAt };
      const p = tripProgress(trip, now);
      const fname = FACTIONS[m.f]?.name || 'NPC';
      this.drawTrip(ctx, size, p, `⚔️ ${fname}・攻打${m.label}`, ['rgba(229,57,53,0.75)', '#b71c1c', '#ffebee', 'rgba(127,0,0,0.9)'], false);
    });
    this.game.npcs.trips(now).forEach(({ npc, trip, p }) => {
      const raid = trip.kind === 'raid';
      const beaten = !!trip.hidden;
      this.drawTrip(ctx, size, p, `${raid ? '⚔️' : '🏴‍☠️'} ${npc.name}${beaten ? '・🏳️撤回' : raid ? '・掠奪' : ''}`, raid
        ? ['rgba(229,57,53,0.75)', '#b71c1c', '#ffebee', 'rgba(127,0,0,0.9)']
        : ['rgba(141,110,99,0.6)', '#4e342e', '#efebe9', 'rgba(62,39,35,0.85)'], beaten);
      if (!beaten) this.teams.push({ kind: 'npc', npcId: npc.id, pos: p.pos });
    });
  },

  /**
   * v12.1 集結：前往集結點的各隊（小戰旗）、在集結點等待與行軍中的部隊（一個大戰旗＋總人數）。
   * 所有看得到這個集結的玩家都畫成一樣的圖示。
   */
  drawRallies(ctx, size) {
    const g = this.game;
    if (!g.shared?.all || !g.rally) return;
    const now = Date.now();
    const me = g.rally.myId?.();
    this.rallyTeams = [];
    g.shared.all('rally').map((o) => ({ id: o.id, ...o.data })).forEach((d) => {
      if (!d.home || !['gathering', 'departed', 'resolving', 'done'].includes(d.status)) return;
      if (d.status === 'done' && (!d.fightAt || now >= d.fightAt)) return;
      // 參加者都離線、一直沒有結算的集結：交戰時間過了 10 分鐘就不再顯示戰旗
      if (d.fightAt && now > d.fightAt + 10 * 60000) return;
      const teams = d.teams || [];
      const label = (pos, l1, l2, big, n) => {
        const m = this.map.latLngToContainerPoint([pos.lat, pos.lon]);
        if (m.x < -60 || m.y < -60 || m.x > size.x + 60 || m.y > size.y + 60) return;
        this.drawFlagPin(ctx, m.x, m.y, big ? 14 : 10, n);
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = Math.max(ctx.measureText(l1).width, l2 ? ctx.measureText(l2).width : 0) + 12;
        const y = m.y + (big ? 19 : 15);
        const h = l2 ? 30 : 16;
        ctx.fillStyle = 'rgba(36,18,74,0.92)';
        ctx.fillRect(m.x - w / 2, y, w, h);
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 1;
        ctx.strokeRect(m.x - w / 2, y, w, h);
        ctx.fillStyle = '#fff';
        ctx.fillText(l1, m.x, y + 9);
        if (l2) {
          ctx.fillStyle = '#ffe082';
          ctx.fillText(l2, m.x, y + 22);
        }
      };
      const line = (pts, color) => {
        const q = pts.map((x) => this.map.latLngToContainerPoint([x.lat, x.lon]));
        ctx.beginPath();
        q.forEach((x, i) => (i ? ctx.lineTo(x.x, x.y) : ctx.moveTo(x.x, x.y)));
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      // 前往集結點的隊伍
      let arrived = 0;
      let people = 0;
      teams.forEach((t) => {
        const p = RallySystem.phaseOf(d, now, t);
        if (p?.phase === 'gather') {
          line([p.pos, d.home], 'rgba(255,213,79,0.8)');
          const mine = t.player === me;
          label(p.pos, `${mine ? '' : `${String(t.name).slice(0, 8)}・`}前往集結點`, mine ? `⏱ 剩 ${formatDuration(p.left)} 抵達` : '', false, (t.units || []).length);
          this.rallyTeams.push({ kind: 'rally', rallyId: d.id, pos: p.pos });
        } else {
          arrived += 1;
          people += (t.units || []).length;
        }
      });
      const p = RallySystem.phaseOf(d, now);
      if (!p) return;
      if (p.phase === 'wait' && !arrived) return;
      let l1;
      let l2;
      if (p.phase === 'wait') {
        l1 = `集結 ${arrived}/${d.maxTeams} 隊・${people} 人`;
        l2 = now >= p.s.trigger && p.s.waitFor ? `⏳ 等${String(p.s.waitFor.name).slice(0, 8)}抵達・${formatDuration(p.left)}` : `⏱ ${formatDuration(p.left)} 後出發`;
      } else if (p.phase === 'march') {
        line([p.pos, ...(p.path || [d.target]).slice(-1)], 'rgba(255,112,67,0.85)');
        l1 = `集結部隊・${teams.length} 隊`;
        l2 = `⏱ 剩 ${formatDuration(p.left)} 抵達`;
      } else {
        l1 = '⚔️ 集結交戰中';
        l2 = '⏱ 等待結果';
      }
      label(p.pos, l1, l2, true, p.phase === 'wait' ? people : teams.reduce((a, t) => a + (t.units || []).length, 0));
      this.rallyTeams.push({ kind: 'rally', rallyId: d.id, pos: p.pos });
    });
  },

  /** 集結戰旗：紫底金框＋金色旗子（不用表情符號，各種手機顯示一致） */
  drawFlagPin(ctx, x, y, r, count) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#311b92';
    ctx.fill();
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    const k = r / 12;
    ctx.beginPath();
    ctx.moveTo(x - 4 * k, y - 7 * k);
    ctx.lineTo(x - 4 * k, y + 7 * k);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1.5, 2.2 * k);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x - 3 * k, y - 7 * k);
    ctx.lineTo(x + 6 * k, y - 7 * k);
    ctx.lineTo(x + 3.5 * k, y - 3.5 * k);
    ctx.lineTo(x + 6 * k, y);
    ctx.lineTo(x - 3 * k, y);
    ctx.closePath();
    ctx.fillStyle = '#ffd54f';
    ctx.fill();
    if (count) {
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const t = String(count);
      const w = ctx.measureText(t).width + 7;
      ctx.fillStyle = '#000';
      ctx.fillRect(x + r * 0.55, y - r - 5, w, 13);
      ctx.fillStyle = '#fff';
      ctx.fillText(t, x + r * 0.55 + w / 2, y - r + 1.5);
    }
  },

  /** 點擊位置附近的隊伍（優先自己的探索隊，其次其他玩家、NPC） */
  teamAt(pt) {
    if (!this.map) return null;
    let best = null;
    let bestD = 18;
    const near = (list) => (list || []).forEach((t) => {
      const m = this.map.latLngToContainerPoint([t.pos.lat, t.pos.lon]);
      const d = Math.hypot(m.x - pt.x, m.y - pt.y);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    });
    near(this.ownTeams);
    if (best) return best;
    near(this.rallyTeams);
    if (best) return best;
    near(this.teams);
    return best;
  },

  /** @param {[string,string,string,string]} colors 路線、標記底色、外框與文字、標籤底色 */
  /** 路線（繞路時為折線） */
  tracePath(ctx, p) {
    const pts = (p.path || [p.from, p.to]).map((q) => this.map.latLngToContainerPoint([q.lat, q.lon]));
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  },

  drawTrip(ctx, size, p, name, [line, fill, stroke, labelBg], retreat = false, stayName = '') {
    const m = this.map.latLngToContainerPoint([p.pos.lat, p.pos.lon]);
    const staying = p.phase === 'searching' && stayName;
    // 駐防、協防抵達後不畫路線
    if (!(staying && /駐防|協防/.test(stayName))) {
      this.tracePath(ctx, p);
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m.x < -60 || m.y < -60 || m.x > size.x + 60 || m.y > size.y + 60) return;
    const ph0 = EXP_PHASES[p.phase];
    const ph = staying ? { ...ph0, icon: /戰鬥/.test(stayName) ? '⚔️' : '🛡️' } : ph0;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ph.icon, m.x, m.y + 1);
    const label = retreat ? name : `${name}・${(p.phase === 'searching' && stayName) || ph.name}`;
    ctx.font = 'bold 10px sans-serif';
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = labelBg;
    ctx.fillRect(m.x - w / 2, m.y + 14, w, 15);
    ctx.fillStyle = stroke;
    ctx.fillText(label, m.x, m.y + 22);
  },

  /** 探索隊：沿路線移動的隊伍標記、已走路線、距離與剩餘時間 */
  drawExpeditions(ctx, size) {
    const now = Date.now();
    const { exploration } = this.game;
    this.ownTeams = [];
    this.game.state.expeditions.forEach((exp) => {
      // v12.1：集結隊伍在交戰前由集結圖示統一顯示（drawRallies）
      if (exp.kind === 'rally' && !exp.rallyResult && !exp.recalled && this.game.rally?.get(exp.rallyId)?.home) return;
      const p = exploration.progress(exp, now);
      if (!p) return;
      this.ownTeams.push({ kind: 'own', expId: exp.id, pos: p.pos });
      const m = this.map.latLngToContainerPoint([p.pos.lat, p.pos.lon]);
      // 路線（繞開警戒範圍時為折線）；駐防隊抵達後不畫。透明度和地圖上的前往路線一致（30%）
      const guarding = exp.kind === 'cpGuard' && p.phase === 'searching' && !exp.recalled && !exp.defeated;
      if (!guarding) {
        this.tracePath(ctx, p);
        ctx.strokeStyle = 'rgba(255,213,79,0.3)';
        ctx.lineWidth = 3;
        ctx.setLineDash(p.phase === 'returning' ? [6, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (m.x < -60 || m.y < -60 || m.x > size.x + 60 || m.y > size.y + 60) return;

      // 移動中的遇襲範圍（夜間有殭屍群時才顯示）
      if (p.phase !== 'searching' && this.game.state.map.zombieGroups.length) {
        const n = this.map.latLngToContainerPoint([p.pos.lat + AMBUSH_RADIUS_M / M_PER_LAT, p.pos.lon]);
        ctx.beginPath();
        ctx.arc(m.x, m.y, Math.abs(m.y - n.y), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,82,82,0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,82,82,0.4)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 隊伍標記
      const ph = { icon: phaseIcon(exp, p.phase), name: phaseName(exp, p.phase) };
      const bob = p.phase === 'searching' ? 0 : Math.sin(now / 150) * 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y + bob, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#1565c0';
      ctx.fill();
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ph.icon, m.x, m.y + bob + 1);
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(exp.memberIds.length), m.x + 11, m.y + bob - 10);

      // 資訊標籤：階段・已移動/總路程・剩餘時間
      const km = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}km` : `${v}m`);
      const stay = p.phase === 'searching' && STAY_NAMES[exp.kind];
      const phName = exp.defeated ? '🏳️ 撤回中' : exp.recalled ? '↩️ 召回中' : stay || `${ph.icon} ${ph.name}`;
      let line1 = exp.defeated || exp.recalled ? `${phName}・剩 ${km(Math.max(0, p.totalM - p.movedM))}` : p.totalM && !(exp.kind === 'cpGuard' && stay) ? `${phName}・${km(p.movedM)} / ${km(p.totalM)}` : phName;
      // 駐防中：沒有期限（直到撤回或被打下），不顯示剩餘時間
      let line2 = stay && exp.kind === 'cpGuard' ? '直到撤回或被打下' : `⏱ 剩 ${formatDuration(p.remainingMs)}`;
      // 集結：出發前在避難所等待；交戰結果出來前顯示抵達時間（不顯示預留的回家時間）
      if (exp.kind === 'rally' && (exp.rallyResult || exp.recalled)) {
        const rs = this.game.rally.statusOf(exp, now);
        if (rs) { line1 = rs.line1; line2 = rs.line2; }
      } else if (exp.kind === 'rally') {
        if (now < exp.startAt) {
          line1 = '集結中・等待出發';
          line2 = `⏱ ${formatDuration(exp.startAt - now)} 後出發`;
        } else if (p.phase === 'outbound') line2 = `⏱ 剩 ${formatDuration(p.phaseRemainingMs)} 抵達`;
        else if (exp.rallyFightAt && now < exp.rallyFightAt) { line1 = '已抵達・等待其他隊伍'; line2 = `⏱ ${formatDuration(exp.rallyFightAt - now)} 後開打`; }
        else { line1 = '⚔️ 集結交戰中'; line2 = '⏱ 等待結果'; }
      }
      ctx.font = 'bold 11px sans-serif';
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 12;
      const x = m.x - w / 2;
      const y = m.y + 18;
      ctx.fillStyle = 'rgba(13,27,42,0.88)';
      ctx.fillRect(x, y, w, 30);
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, 30);
      ctx.fillStyle = '#fff';
      ctx.fillText(line1, m.x, y + 9);
      ctx.fillStyle = '#ffe082';
      ctx.fillText(line2, m.x, y + 22);
    });
  },

  drawFx(ctx, frames, dt) {
    this.fx = this.fx.filter((e) => (e.t += dt) < e.ttl);
    this.fx.forEach((e) => {
      const f = frames.get(e.baseId);
      if (!f) return;
      const { c, k } = f;
      const a = 1 - e.t / e.ttl;
      ctx.globalAlpha = a;
      if (e.type === 'shot' || e.type === 'flame') {
        ctx.beginPath();
        ctx.moveTo(c.x + e.x1 * k, c.y + e.y1 * k);
        ctx.lineTo(c.x + e.x2 * k, c.y + e.y2 * k);
        ctx.strokeStyle = e.type === 'flame' ? '#ff7043' : FX_COLORS[e.kind] || '#fff';
        ctx.lineWidth = e.kind === 'em' || e.type === 'flame' ? 2.5 : 1.5;
        ctx.stroke();
        if (e.type === 'flame') {
          ctx.beginPath();
          ctx.arc(c.x + e.x2 * k, c.y + e.y2 * k, e.r * k, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,112,67,0.35)';
          ctx.fill();
        }
      } else if (e.type === 'trap') {
        ctx.beginPath();
        ctx.arc(c.x + e.x * k, c.y + e.y * k, e.r * k, 0, Math.PI * 2);
        ctx.strokeStyle = '#a1887f';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (e.type === 'death') {
        ctx.beginPath();
        ctx.arc(c.x + e.x * k, c.y + e.y * k, (4 + (1 - a) * (e.boss ? 30 : 12)) * Math.min(k, 2), 0, Math.PI * 2);
        ctx.strokeStyle = css(e.color || 0xffffff);
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (e.type === 'dmg' && k > 1.4) {
        ctx.font = e.crit ? 'bold 13px sans-serif' : '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = e.crit ? '#ffeb3b' : '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const x = c.x + e.x * k;
        const y = c.y + e.y * k - 10 - (1 - a) * 18;
        ctx.strokeText(String(e.dmg), x, y);
        ctx.fillText(String(e.dmg), x, y);
      } else if (e.type === 'wallHit') {
        ctx.beginPath();
        ctx.arc(c.x + e.x * 0.95 * k, c.y + e.y * 0.95 * k, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffab91';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
  },

  /** 防線失守時的紅色衝擊波 */
  drawPulses(ctx, frames, dt) {
    this.pulses = this.pulses.filter((p) => (p.t += dt) < p.ttl);
    this.pulses.forEach((p) => {
      const f = frames.get(p.baseId);
      if (!f) return;
      const prog = p.t / p.ttl;
      ctx.beginPath();
      ctx.arc(f.c.x, f.c.y, WORLD.WALL_R * f.k * (1 + prog * 3), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(229,57,53,${1 - prog})`;
      ctx.lineWidth = 6;
      ctx.stroke();
    });
  },
});
