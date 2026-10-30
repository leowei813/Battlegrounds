import Phaser from 'phaser';
import { DEFENSES } from '../config/defenses.js';
import { DEFENSE_SLOTS } from '../config/constants.js';
import { WORLD } from '../systems/SiegeSystem.js';
import { bus, EVT } from '../core/EventBus.js';

const FX_COLORS = { mg: 0xffee58, em: 0x4fc3f7, sniper: 0xffffff, guard: 0xffcc80 };

/**
 * 避難所場景：俯視角呈現避難所、圍牆、防禦塔與來襲殭屍。
 * 邏輯全部在 SiegeSystem，本場景只負責「讀取 → 繪製」。
 */
export class ShelterScene extends Phaser.Scene {
  constructor() {
    super('Shelter');
    this.zombieSprites = new Map();
    this.lines = [];
  }

  /** @returns {import('../core/Game.js').Game} */
  get core() {
    return this.registry.get('core');
  }

  create() {
    this.ground = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, 'ground').setOrigin(0);
    this.staticG = this.add.graphics();
    this.wallG = this.add.graphics();
    this.zombieLayer = this.add.layer();
    this.hpG = this.add.graphics();
    this.fxG = this.add.graphics();
    this.uiLayer = this.add.layer();
    this.night = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x050818, 0).setOrigin(0);
    this.night.setDepth(50);

    this.centerIcon = this.add.text(0, 0, '🏚️', { fontSize: '40px' }).setOrigin(0.5).setDepth(10);
    this.nameText = this.add.text(0, 0, '', {
      fontSize: '13px', color: '#ffe082', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(10);
    this.hintText = this.add.text(0, 0, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'sans-serif', align: 'center', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(60);

    this.slotObjs = [];
    for (let i = 0; i < DEFENSE_SLOTS; i += 1) {
      const zone = this.add.circle(0, 0, 18, 0x000000, 0.35).setStrokeStyle(2, 0xffffff, 0.4).setDepth(5);
      zone.setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => bus.emit(EVT.OPEN_SLOT, { slot: i }));
      zone.on('pointerover', () => zone.setStrokeStyle(3, 0xffd54f, 1));
      zone.on('pointerout', () => zone.setStrokeStyle(2, 0xffffff, 0.4));
      const icon = this.add.text(0, 0, '+', { fontSize: '20px', color: '#fff' }).setOrigin(0.5).setDepth(6);
      const lv = this.add.text(0, 0, '', {
        fontSize: '11px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(6);
      this.slotObjs.push({ zone, icon, lv });
    }

    this.scale.on('resize', () => this.layout());
    this.registry.events.on('changedata-viewInset', () => this.layout());
    this.unsubs = [
      bus.on('shelter:changed', () => this.refreshStatic()),
      bus.on(EVT.STATE_CHANGED, () => this.refreshStatic()),
    ];
    this.events.once('shutdown', () => this.unsubs.forEach((u) => u()));
    this.layout();
  }

  /** 計算畫面中心與世界→螢幕縮放（扣除 UI 抽屜遮擋區域） */
  layout() {
    const { width, height } = this.scale;
    const inset = this.registry.get('viewInset') || { right: 0, bottom: 0, top: 0 };
    const w = width - inset.right;
    const h = height - inset.bottom - inset.top;
    this.cx = w / 2;
    this.cy = inset.top + h / 2;
    this.k = Math.max(0.6, Math.min(w, h) / (WORLD.SPAWN_R * 2.1));
    this.ground.setSize(width, height);
    this.night.setSize(width, height);
    this.refreshStatic(true);
  }

  toScreen(x, y) {
    return { x: this.cx + x * this.k, y: this.cy + y * this.k };
  }

  refreshStatic(force = false) {
    const core = this.core;
    if (!core || !this.staticG) return;
    const sh = core.state.shelter;
    const key = JSON.stringify([sh.poiId, sh.defenses, sh.buildQueue.length, this.cx, this.cy, this.k]);
    if (!force && key === this.lastStaticKey) return;
    this.lastStaticKey = key;

    const has = core.shelter.hasShelter();
    const c = this.toScreen(0, 0);
    this.centerIcon.setPosition(c.x, c.y).setFontSize(Math.round(30 * this.k));
    this.centerIcon.setText(has ? '🏠' : '🏚️');
    this.nameText.setPosition(c.x, c.y + 26 * this.k).setText(has ? sh.name : '');
    this.hintText.setPosition(c.x, c.y - 70 * this.k).setText(has ? '' : '尚未建立避難所\n請到「地圖」選擇一棟建築');

    this.staticG.clear();
    // 偵查範圍
    this.staticG.lineStyle(1, 0xffffff, 0.08).strokeCircle(c.x, c.y, WORLD.SPAWN_R * this.k);
    this.staticG.lineStyle(1, 0xffffff, 0.06).strokeCircle(c.x, c.y, WORLD.SLOT_R * this.k);

    sh.defenses.forEach((d, i) => {
      const p = core.siege.slotPos(i, DEFENSE_SLOTS);
      const s = this.toScreen(p.x, p.y);
      const o = this.slotObjs[i];
      const busy = core.shelter.isSlotBusy(i);
      o.zone.setPosition(s.x, s.y).setRadius(Math.max(16, 13 * this.k));
      o.zone.setVisible(has);
      o.icon.setVisible(has).setPosition(s.x, s.y);
      o.lv.setVisible(has).setPosition(s.x, s.y + 16 * this.k);
      if (d.type) {
        const def = DEFENSES[d.type];
        o.zone.setFillStyle(def.color, 0.55);
        o.icon.setText(def.icon).setFontSize(Math.round(14 * this.k));
        o.lv.setText(busy ? '🔨' : `Lv${d.level}`);
        if (d.level > 0 && def.stats(d.level).range && d.type !== 'barricade') {
          const r = def.stats(d.level).range * (d.type === 'trap' ? 1 : core.shelter.rangeMul());
          this.staticG.lineStyle(1, def.color, 0.18).strokeCircle(s.x, s.y, r * this.k);
        }
      } else {
        o.zone.setFillStyle(0x000000, 0.35);
        o.icon.setText('+').setFontSize(18);
        o.lv.setText('');
      }
    });
  }

  drawWall() {
    const core = this.core;
    const c = this.toScreen(0, 0);
    this.wallG.clear();
    if (!core.shelter.hasShelter()) return;
    const ratio = Phaser.Math.Clamp(core.shelter.wallHp() / core.shelter.wallMax(), 0, 1);
    const color = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(0xe53935), Phaser.Display.Color.ValueToColor(0x8d6e63), 100, ratio * 100,
    );
    const col = Phaser.Display.Color.GetColor(color.r, color.g, color.b);
    const lv = core.state.shelter.facilities.wall.level;
    this.wallG.lineStyle(Math.max(3, (3 + lv * 0.6) * this.k), col, 1);
    this.wallG.strokeCircle(c.x, c.y, WORLD.WALL_R * this.k);
    // 耐久弧
    this.wallG.lineStyle(3, 0x66bb6a, 0.9);
    this.wallG.beginPath();
    this.wallG.arc(c.x, c.y, (WORLD.WALL_R + 6) * this.k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    this.wallG.strokePath();
  }

  syncZombies() {
    const core = this.core;
    const alive = new Set();
    this.hpG.clear();
    core.siege.zombies.forEach((z) => {
      alive.add(z.id);
      let spr = this.zombieSprites.get(z.id);
      if (!spr) {
        spr = this.add.image(0, 0, 'zombie').setTint(z.color);
        this.zombieLayer.add(spr);
        this.zombieSprites.set(z.id, spr);
      }
      const s = this.toScreen(z.x, z.y);
      const size = (z.boss ? 1.6 : 0.6) * this.k;
      spr.setPosition(s.x, s.y + Math.sin(z.t * 8) * 0.8).setScale(size);
      spr.setAlpha(performance.now() / 1000 < z.stunUntil ? 0.6 : 1);
      if (z.hp < z.maxHp) {
        const w = (z.boss ? 30 : 14) * this.k;
        this.hpG.fillStyle(0x000000, 0.6).fillRect(s.x - w / 2, s.y - 12 * size - 4, w, 3);
        this.hpG.fillStyle(0xef5350, 1).fillRect(s.x - w / 2, s.y - 12 * size - 4, w * (z.hp / z.maxHp), 3);
      }
    });
    this.zombieSprites.forEach((spr, id) => {
      if (!alive.has(id)) {
        spr.destroy();
        this.zombieSprites.delete(id);
      }
    });
  }

  spawnFx() {
    const fx = this.core.siege.drainFx();
    fx.forEach((e) => {
      if (e.type === 'shot' || e.type === 'flame') {
        const a = this.toScreen(e.x1, e.y1);
        const b = this.toScreen(e.x2, e.y2);
        this.lines.push({ a, b, color: e.type === 'flame' ? 0xff7043 : FX_COLORS[e.kind] || 0xffffff, ttl: 0.09, w: e.kind === 'em' ? 3 : 2 });
        if (e.type === 'flame') this.burst(b.x, b.y, 0xff7043, 6, e.r * this.k);
      } else if (e.type === 'trap') {
        const p = this.toScreen(e.x, e.y);
        this.lines.push({ circle: true, a: p, r: e.r * this.k, color: 0xa1887f, ttl: 0.25, w: 2 });
      } else if (e.type === 'dmg') {
        if (this.children.length > 600) return;
        const p = this.toScreen(e.x, e.y);
        const t = this.add.text(p.x, p.y - 10, String(e.dmg), {
          fontSize: e.crit ? '15px' : '11px', color: e.crit ? '#ffeb3b' : '#ffffff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5).setDepth(40);
        this.tweens.add({ targets: t, y: p.y - 34, alpha: 0, duration: 650, onComplete: () => t.destroy() });
      } else if (e.type === 'death') {
        const p = this.toScreen(e.x, e.y);
        this.burst(p.x, p.y, e.color, e.boss ? 24 : 8, 18 * this.k);
      } else if (e.type === 'wallHit') {
        if (Math.random() < 0.3) {
          const p = this.toScreen(e.x * 0.95, e.y * 0.95);
          this.burst(p.x, p.y, 0xbcaaa4, 3, 8 * this.k);
        }
      }
    });
  }

  burst(x, y, color, n, spread) {
    for (let i = 0; i < n; i += 1) {
      const p = this.add.image(x, y, 'particle').setTint(color).setScale(Phaser.Math.FloatBetween(0.4, 1)).setDepth(30);
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * spread;
      this.tweens.add({
        targets: p, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, alpha: 0, scale: 0.1,
        duration: Phaser.Math.Between(250, 500), onComplete: () => p.destroy(),
      });
    }
  }

  drawLines(dt) {
    this.fxG.clear();
    this.lines = this.lines.filter((l) => (l.ttl -= dt) > 0);
    this.lines.forEach((l) => {
      this.fxG.lineStyle(l.w, l.color, Math.min(1, l.ttl * 10));
      if (l.circle) this.fxG.strokeCircle(l.a.x, l.a.y, l.r);
      else this.fxG.lineBetween(l.a.x, l.a.y, l.b.x, l.b.y);
    });
  }

  update(_time, delta) {
    const core = this.core;
    if (!core) return;
    const dt = delta / 1000;
    core.siege.update(dt);
    this.drawWall();
    this.syncZombies();
    this.spawnFx();
    this.drawLines(dt);
    const target = core.time.phase().overlay;
    this.night.fillAlpha = Phaser.Math.Linear(this.night.fillAlpha, target, 0.02);
  }
}
