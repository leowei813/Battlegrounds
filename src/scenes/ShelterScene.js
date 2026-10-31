import Phaser from 'phaser';
import { DEFENSES } from '../config/defenses.js';
import { FACILITIES } from '../config/facilities.js';
import { BASE_SIZES } from '../config/civilization.js';
import { BASE_IMAGE_SIZE, FACILITY_CELLS, defenseCells } from '../config/baseLayouts.js';
import { bus, EVT } from '../core/EventBus.js';

/** 最大據點的防禦欄位數（場景預先建立的槽位物件數） */
const MAX_SLOTS = Math.max(...Object.values(BASE_SIZES).map((s) => s.slots));
/** 圍牆就是底圖上的城牆，不佔格子 */
const FACILITY_IDS = Object.keys(FACILITIES).filter((id) => id !== 'wall');
/** 共用圖片：監視塔（設施）使用瞭望台的圖 */
const IMAGE_ALIAS = { watchtower: 'watchPost' };
const imageKey = (id) => `bld-${IMAGE_ALIAS[id] || id}`;

/**
 * 避難所場景：要塞底圖上畫出格子——一般設施放在圍牆內側的綠色格（12 格），
 * 防禦設施放在靠近大門的藍色格（依據點規模 3／5／8／11 格）。
 * 屍潮的邏輯仍在 SiegeSystem 運作，這個畫面暫時不繪製來襲的殭屍。
 */
export class ShelterScene extends Phaser.Scene {
  constructor() {
    super('Shelter');
  }

  /** @returns {import('../core/Game.js').Game} */
  get core() {
    return this.registry.get('core');
  }

  /** 目前檢視的據點（由 UI 設定，預設主要據點） */
  get base() {
    const core = this.core;
    return core?.shelter.base(this.registry.get('viewBaseId')) || core?.shelter.primary() || core?.state.bases[0] || null;
  }

  create() {
    this.ground = this.add.tileSprite(0, 0, this.scale.width, this.scale.height, 'ground').setOrigin(0);
    this.bg = this.add.image(0, 0, 'fortress').setOrigin(0.5).setVisible(false);
    this.gridG = this.add.graphics().setDepth(5);
    this.night = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x050818, 0).setOrigin(0).setDepth(50);

    this.nameText = this.add.text(0, 0, '', {
      fontSize: '14px', color: '#ffe082', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(20);
    this.wallText = this.add.text(0, 0, '', {
      fontSize: '12px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20);
    this.wallBar = this.add.graphics().setDepth(20);
    this.hintText = this.add.text(0, 0, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'sans-serif', align: 'center', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(60);

    // 一般設施（綠色格）
    this.facObjs = FACILITY_IDS.map((id) => {
      const hasImg = this.textures.exists(imageKey(id));
      const icon = hasImg
        ? this.add.image(0, 0, imageKey(id)).setOrigin(0.5, 0.82).setDepth(10)
        : this.add.text(0, 0, FACILITIES[id].icon, { fontSize: '22px' }).setOrigin(0.5, 0.75).setDepth(10);
      const lv = this.add.text(0, 0, '', {
        fontSize: '11px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(11);
      return {
        id, icon, lv, hasImg,
      };
    });

    // 防禦設施（藍色格）
    this.slotObjs = [];
    for (let i = 0; i < MAX_SLOTS; i += 1) {
      const zone = this.add.ellipse(0, 0, 36, 20, 0x000000, 0.01).setDepth(9);
      const icon = this.add.text(0, 0, '+', { fontSize: '18px', color: '#fff' }).setOrigin(0.5, 0.75).setDepth(10);
      const img = this.add.image(0, 0, '__DEFAULT').setOrigin(0.5, 0.82).setDepth(10).setVisible(false);
      const lv = this.add.text(0, 0, '', {
        fontSize: '11px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(11);
      this.slotObjs.push({
        zone, icon, img, lv,
      });
    }

    // 點擊判定：整個格子（菱形）範圍都可以點，點到建築圖片也算
    this.hoverG = this.add.graphics().setDepth(12);
    this.hitCells = [];
    this.input.on('pointerdown', (pointer) => {
      // 只接受直接點在畫布上的點擊（避免點到上層的面板、彈窗時誤開選單）
      if (pointer.event && pointer.event.target !== this.game.canvas) return;
      const hit = this.hitTest(pointer.x, pointer.y);
      if (!hit) return;
      if (hit.kind === 'slot') bus.emit(EVT.OPEN_SLOT, { slot: hit.slot });
      else bus.emit('ui:shelterTab', { tab: 'facilities' });
    });
    this.input.on('pointermove', (pointer) => this.drawHover(this.hitTest(pointer.x, pointer.y)));
    this.input.on('gameout', () => this.drawHover(null));

    this.scale.on('resize', () => this.layout());
    this.registry.events.on('changedata-viewInset', () => this.layout());
    this.registry.events.on('changedata-viewBaseId', () => this.refreshStatic(true));
    this.unsubs = [
      bus.on('shelter:changed', () => this.refreshStatic()),
      bus.on(EVT.STATE_CHANGED, () => this.refreshStatic()),
    ];
    this.events.once('shutdown', () => this.unsubs.forEach((u) => u()));
    this.layout();
  }

  /** 計算可視區域（扣除 UI 抽屜遮擋）與底圖縮放 */
  layout() {
    const { width, height } = this.scale;
    const inset = this.registry.get('viewInset') || { right: 0, bottom: 0, top: 0 };
    const w = width - inset.right;
    const h = height - inset.bottom - inset.top;
    this.cx = w / 2;
    this.cy = inset.top + h / 2;
    // 底圖完整放進可視區域
    this.k = Math.min(w / BASE_IMAGE_SIZE.w, h / BASE_IMAGE_SIZE.h);
    this.ground.setSize(width, height);
    this.night.setSize(width, height);
    this.refreshStatic(true);
  }

  /** 底圖像素 → 螢幕座標 */
  toScreen([px, py]) {
    return { x: this.cx + (px - BASE_IMAGE_SIZE.w / 2) * this.k, y: this.cy + (py - BASE_IMAGE_SIZE.h / 2) * this.k };
  }

  refreshStatic(force = false) {
    const core = this.core;
    if (!core || !this.bg) return;
    const sh = this.base;
    const key = JSON.stringify([sh?.id, sh?.size, core.state.primaryBaseId, sh?.defenses, sh && Object.values(sh.facilities).map((f) => f.level),
      sh?.buildQueue.map((q) => q.id || q.slot), this.cx, this.cy, this.k]);
    if (!force && key === this.lastStaticKey) return;
    this.lastStaticKey = key;

    const has = !!sh;
    this.hintText.setPosition(this.cx, this.cy).setText(has ? '' : '尚未建立避難所\n請到「地圖」選擇一棟建築');
    this.bg.setVisible(has);
    this.nameText.setVisible(has);
    this.wallText.setVisible(has);
    this.wallBar.setVisible(has);
    this.gridG.clear();
    if (!has) {
      this.facObjs.forEach((o) => { o.icon.setVisible(false); o.lv.setVisible(false); });
      this.slotObjs.forEach((o) => { o.zone.setVisible(false); o.icon.setVisible(false); o.img.setVisible(false); o.lv.setVisible(false); });
      this.hitCells = [];
      this.drawHover(null);
      return;
    }

    const size = BASE_SIZES[sh.size] ? sh.size : 'medium';
    const cells = { facility: FACILITY_CELLS.map((c) => c.center), defense: defenseCells(sh.defenses.length).map((c) => c.center) };
    // 格子在螢幕上的寬度（建築圖片依此縮放）
    const cellW = (cell) => {
      const xs = cell.corners.map((c) => this.toScreen(c).x);
      return Math.max(...xs) - Math.min(...xs);
    };
    const fw = cellW(FACILITY_CELLS[0]);
    this.bg.setPosition(this.cx, this.cy).setScale(this.k);
    // 格子：綠色（一般設施）、藍色（防禦設施）
    const poly = (cell, fill, fillA, line) => {
      const pts = cell.corners.map((c) => this.toScreen(c));
      this.gridG.fillStyle(fill, fillA).beginPath();
      this.gridG.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((q) => this.gridG.lineTo(q.x, q.y));
      this.gridG.closePath().fillPath();
      this.gridG.lineStyle(Math.max(1.5, 3 * this.k), line, 0.9).strokePath();
    };
    FACILITY_CELLS.forEach((c) => poly(c, 0x66bb6a, 0.28, 0xfff59d));
    defenseCells(sh.defenses.length).forEach((c) => poly(c, 0x42a5f5, 0.32, 0x90caf9));
    this.hitCells = [
      ...defenseCells(sh.defenses.length).map((c, i) => ({ kind: 'slot', slot: i, pts: c.corners.map((q) => this.toScreen(q)) })),
      ...FACILITY_CELLS.map((c, i) => ({ kind: 'facility', index: i, pts: c.corners.map((q) => this.toScreen(q)) })),
    ];
    this.drawHover(null);
    const top = this.toScreen([BASE_IMAGE_SIZE.w / 2, 0]);
    this.nameText.setPosition(this.cx, top.y + 14).setText(`${core.shelter.isPrimary(sh) ? '⭐ ' : '🏴 '}${sh.name}（${BASE_SIZES[size].name}）`);

    // 一般設施：已建造的正常顯示，尚未建造的半透明；前哨站只有圍牆與監視塔
    const cellSize = Math.max(14, Math.round(52 * this.k));
    FACILITY_IDS.forEach((id, i) => {
      const o = this.facObjs[i];
      const f = sh.facilities[id];
      const p = cells.facility[i] && this.toScreen(cells.facility[i]);
      if (!f || !p) {
        o.icon.setVisible(false);
        o.lv.setVisible(false);
        return;
      }
      const busy = sh.buildQueue.some((q) => q.kind === 'facility' && q.id === id);
      o.icon.setVisible(true).setPosition(p.x, p.y).setAlpha(f.level > 0 ? 1 : 0.35).setDepth(10 + p.y / 10000);
      if (o.hasImg) o.icon.setScale((fw * 0.74) / o.icon.width);
      else o.icon.setFontSize(cellSize);
      o.lv.setVisible(true).setPosition(p.x, p.y + Math.max(cellSize * 0.35, fw * 0.22)).setText(busy ? '🔨' : f.level > 0 ? `Lv${f.level}` : '未建').setDepth(11 + p.y / 10000);
    });

    // 防禦設施：依據點規模的藍色格
    this.slotObjs.forEach((o, i) => {
      const d = sh.defenses[i];
      const p = d && cells.defense[i] && this.toScreen(cells.defense[i]);
      if (!p) {
        o.zone.setVisible(false);
        o.icon.setVisible(false);
        o.img.setVisible(false);
        o.lv.setVisible(false);
        return;
      }
      const busy = core.shelter.isSlotBusy(sh, i);
      const dw = cellW(defenseCells(sh.defenses.length)[i]);
      const rx = Math.max(14, 42 * this.k);
      o.zone.setVisible(true).setPosition(p.x, p.y).setSize(rx * 2, rx * 1.1);
      o.zone.geom.setSize(rx * 2, rx * 1.1);
      o.zone.updateDisplayOrigin();
      o.icon.setVisible(true).setPosition(p.x, p.y);
      o.lv.setVisible(true).setPosition(p.x, p.y + rx * 0.45);
      const key = d.type && imageKey(d.type);
      const hasImg = key && this.textures.exists(key);
      o.img.setVisible(!!hasImg);
      if (d.type) {
        const def = DEFENSES[d.type];
        o.zone.setFillStyle(def.color, hasImg ? 0.01 : 0.35);
        if (hasImg) {
          o.img.setTexture(key).setPosition(p.x, p.y).setDepth(10 + p.y / 10000);
          o.img.setScale((dw * 0.72) / o.img.width).setAlpha(d.level > 0 ? 1 : 0.5);
          o.icon.setText('');
        } else o.icon.setText(def.icon).setFontSize(Math.max(14, Math.round(44 * this.k)));
        o.lv.setText(busy ? '🔨' : `Lv${d.level}`).setPosition(p.x, p.y + Math.max(rx * 0.45, dw * 0.22)).setDepth(11 + p.y / 10000);
      } else {
        o.zone.setFillStyle(0x000000, 0.01);
        o.icon.setText('+').setFontSize(Math.max(14, Math.round(36 * this.k)));
        o.lv.setText('');
      }
    });
  }

  /** 點擊位置對應的格子：先看格子本身（菱形），再看站在格子上的建築圖片 */
  hitTest(x, y) {
    const inside = (pts) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
        const a = pts[i];
        const b = pts[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    const cell = this.hitCells.find((h) => inside(h.pts));
    if (cell) return cell;
    // 建築圖片高出格子的部分（前排的建築擋在後排前面，所以由前往後找）
    const sprites = [
      ...this.slotObjs.map((o, i) => ({ obj: o.img, hit: this.hitCells.find((h) => h.kind === 'slot' && h.slot === i) })),
      ...this.facObjs.map((o, i) => ({ obj: o.icon, hit: this.hitCells.find((h) => h.kind === 'facility' && h.index === i) })),
    ].filter((s) => s.hit && s.obj.visible).sort((a, b) => b.obj.y - a.obj.y);
    return sprites.find((s) => s.obj.getBounds().contains(x, y))?.hit || null;
  }

  /** 滑鼠移到格子上時加亮外框 */
  drawHover(hit) {
    if (!this.hoverG) return;
    this.hoverG.clear();
    this.game.canvas.style.cursor = hit ? 'pointer' : 'default';
    if (!hit) return;
    this.hoverG.lineStyle(3, 0xffd54f, 1).beginPath();
    this.hoverG.moveTo(hit.pts[0].x, hit.pts[0].y);
    hit.pts.slice(1).forEach((q) => this.hoverG.lineTo(q.x, q.y));
    this.hoverG.closePath().strokePath();
  }

  /** 圍牆耐久條（畫在名稱下方） */
  drawWall() {
    const core = this.core;
    const base = this.base;
    this.wallBar.clear();
    if (!base) return;
    const hp = core.shelter.wallHp(base);
    const max = core.shelter.wallMax(base);
    const ratio = Phaser.Math.Clamp(hp / max, 0, 1);
    const top = this.toScreen([BASE_IMAGE_SIZE.w / 2, 0]);
    const w = Math.min(220, BASE_IMAGE_SIZE.w * this.k * 0.4);
    const x = this.cx - w / 2;
    const y = top.y + 28;
    this.wallBar.fillStyle(0x000000, 0.6).fillRoundedRect(x, y, w, 12, 5);
    this.wallBar.fillStyle(ratio < 0.3 ? 0xe53935 : 0x66bb6a, 1).fillRoundedRect(x, y, Math.max(4, w * ratio), 12, 5);
    this.wallText.setPosition(this.cx, y + 6).setText(`🧱 ${Math.floor(hp)}/${max}`);
  }

  update() {
    const core = this.core;
    if (!core) return;
    this.drawWall();
    // 夜晚畫面變暗（底圖較亮，夜色減半）
    const target = core.time.phase().overlay * 0.6;
    this.night.fillAlpha = Phaser.Math.Linear(this.night.fillAlpha, target, 0.02);
  }
}
