import L from 'leaflet';
import { WORLD } from '../systems/SiegeSystem.js';
import { DEFENSES } from '../config/defenses.js';
import { bus } from '../core/EventBus.js';
import { EXP_PHASES, AMBUSH_RADIUS_M, tripProgress } from '../systems/ExplorationSystem.js';
import { formatDuration } from '../utils/math.js';

/** 屍潮世界座標 1 單位 = 1.5 公尺（出生圈半徑 150 → 約 225 公尺） */
export const METERS_PER_UNIT = 1.5;
const M_PER_LAT = 111320;
const MAX_FX = 600;

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
    if (!this.running) this.draw(0);
  },

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      this.draw(Math.min(0.1, (t - this.lastT) / 1000));
      this.lastT = t;
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
    const k = ((c.y - n.y) / 100) * METERS_PER_UNIT;
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

      // 防禦建築
      base.defenses.forEach((d, i) => {
        if (!d.type || d.level < 1) return;
        const p = s.slotPos(i, base.defenses.length);
        ctx.beginPath();
        ctx.arc(c.x + p.x * k, c.y + p.y * k, Math.max(3, 6 * Math.min(k, 1.6)), 0, Math.PI * 2);
        ctx.fillStyle = css(DEFENSES[d.type].color);
        ctx.fill();
        ctx.strokeStyle = '#000a';
        ctx.lineWidth = 1;
        ctx.stroke();
      });

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
  },

  /** 其他玩家的探索隊伍（青色）與 NPC 的探索／掠奪隊（紅色），依行程時間即時推算位置 */
  drawOtherTrips(ctx, size) {
    const now = Date.now();
    this.teams = [];
    (this.game.world?.others || []).forEach((player) => player.trips.forEach((trip) => {
      if (now > trip.endAt) return;
      const p = tripProgress(trip, now);
      // 其他玩家的隊伍只看得到移動，看不到剩餘時間；被攔截撤回中的隊伍不能再攔截
      this.drawTrip(ctx, size, p, `👤 ${player.name}${trip.defeated ? '・🏳️撤回' : ''}`, ['rgba(38,198,218,0.55)', '#00838f', '#e0f7fa', 'rgba(0,77,64,0.85)'], !!trip.defeated);
      if (trip.id && !trip.defeated) this.teams.push({ kind: 'player', playerId: player.id, tripId: trip.id, pos: p.pos });
    }));
    this.game.npcs.trips(now).forEach(({ npc, trip, p }) => {
      const raid = trip.kind === 'raid';
      const beaten = !!trip.hidden;
      this.drawTrip(ctx, size, p, `${raid ? '⚔️' : '🏴‍☠️'} ${npc.name}${beaten ? '・🏳️撤回' : raid ? '・掠奪' : ''}`, raid
        ? ['rgba(229,57,53,0.75)', '#b71c1c', '#ffebee', 'rgba(127,0,0,0.9)']
        : ['rgba(141,110,99,0.6)', '#4e342e', '#efebe9', 'rgba(62,39,35,0.85)'], beaten);
      if (!beaten) this.teams.push({ kind: 'npc', npcId: npc.id, pos: p.pos });
    });
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

  drawTrip(ctx, size, p, name, [line, fill, stroke, labelBg], retreat = false) {
    const m = this.map.latLngToContainerPoint([p.pos.lat, p.pos.lon]);
    this.tracePath(ctx, p);
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.x < -60 || m.y < -60 || m.x > size.x + 60 || m.y > size.y + 60) return;
    const ph = EXP_PHASES[p.phase];
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
    const label = retreat ? name : `${name}・${ph.name}`;
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
      const p = exploration.progress(exp, now);
      if (!p) return;
      this.ownTeams.push({ kind: 'own', expId: exp.id, pos: p.pos });
      const m = this.map.latLngToContainerPoint([p.pos.lat, p.pos.lon]);
      // 路線（繞開警戒範圍時為折線）
      this.tracePath(ctx, p);
      ctx.strokeStyle = 'rgba(255,213,79,0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash(p.phase === 'returning' ? [6, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
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
      const ph = EXP_PHASES[p.phase];
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
      const phName = exp.defeated ? '🏳️ 撤回中' : exp.recalled ? '↩️ 召回中' : `${ph.icon} ${ph.name}`;
      const line1 = exp.defeated || exp.recalled ? `${phName}・剩 ${km(Math.max(0, p.totalM - p.movedM))}` : p.totalM ? `${phName}・${km(p.movedM)} / ${km(p.totalM)}` : phName;
      const line2 = `⏱ 剩 ${formatDuration(p.remainingMs)}`;
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
