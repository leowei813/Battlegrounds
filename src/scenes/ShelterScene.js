import Phaser from 'phaser';
import { DEFENSES } from '../config/defenses.js';
import { FACILITIES } from '../config/facilities.js';
import { BASE_SIZES } from '../config/civilization.js';
import { BASE_CELLS, BASE_IMAGE_SIZE } from '../config/baseLayouts.js';
import { bus, EVT } from '../core/EventBus.js';

/** 最大據點的防禦欄位數（場景預先建立的槽位物件數） */
const MAX_SLOTS = Math.max(...Object.values(BASE_SIZES).map((s) => s.slots));
const FACILITY_IDS = Object.keys(FACILITIES);

/**
 * 避難所場景：依據點規模顯示對應的底圖（小／中／大／巨型），
 * 一般設施放在圍牆內的綠色格，防禦設施放在靠近大門的藍色格。
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
    this.bg = this.add.image(0, 0, 'base-medium').setOrigin(0.5).setVisible(false);
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
      const icon = this.add.text(0, 0, FACILITIES[id].icon, { fontSize: '22px' }).setOrigin(0.5, 0.75).setDepth(10);
      const lv = this.add.text(0, 0, '', {
        fontSize: '11px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(11);
      icon.setInteractive({ useHandCursor: true });
      icon.on('pointerdown', (pointer) => {
        if (pointer.event && pointer.event.target !== this.game.canvas) return;
        bus.emit('ui:shelterTab', { tab: 'facilities' });
      });
      return { id, icon, lv };
    });

    // 防禦設施（藍色格）
    this.slotObjs = [];
    for (let i = 0; i < MAX_SLOTS; i += 1) {
      const zone = this.add.ellipse(0, 0, 36, 20, 0x000000, 0.35).setStrokeStyle(2, 0x90caf9, 0.7).setDepth(9);
      zone.setInteractive({ useHandCursor: true });
      // 只接受直接點在畫布上的點擊（避免點到上層的面板、彈窗時誤開槽位選單）
      zone.on('pointerdown', (pointer) => {
        if (pointer.event && pointer.event.target !== this.game.canvas) return;
        bus.emit(EVT.OPEN_SLOT, { slot: i });
      });
      zone.on('pointerover', () => zone.setStrokeStyle(3, 0xffd54f, 1));
      zone.on('pointerout', () => zone.setStrokeStyle(2, 0x90caf9, 0.7));
      const icon = this.add.text(0, 0, '+', { fontSize: '18px', color: '#fff' }).setOrigin(0.5, 0.75).setDepth(10);
      const lv = this.add.text(0, 0, '', {
        fontSize: '11px', color: '#fff', fontFamily: 'sans-serif', stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(11);
      this.slotObjs.push({ zone, icon, lv });
    }

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
    if (!has) {
      this.facObjs.forEach((o) => { o.icon.setVisible(false); o.lv.setVisible(false); });
      this.slotObjs.forEach((o) => { o.zone.setVisible(false); o.icon.setVisible(false); o.lv.setVisible(false); });
      return;
    }

    const size = BASE_CELLS[sh.size] ? sh.size : 'medium';
    const cells = BASE_CELLS[size];
    this.bg.setTexture(`base-${size}`).setPosition(this.cx, this.cy).setScale(this.k);
    const top = this.toScreen([BASE_IMAGE_SIZE.w / 2, 0]);
    this.nameText.setPosition(this.cx, top.y + 14).setText(`${core.shelter.isPrimary(sh) ? '⭐ ' : '🏴 '}${sh.name}（${BASE_SIZES[size].name}）`);

    // 一般設施：已建造的正常顯示，尚未建造的半透明；前哨站只有圍牆與監視塔
    const cellSize = Math.max(14, Math.round(30 * this.k));
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
      o.icon.setVisible(true).setPosition(p.x, p.y).setFontSize(cellSize).setAlpha(f.level > 0 ? 1 : 0.35);
      o.lv.setVisible(true).setPosition(p.x, p.y + cellSize * 0.35).setText(busy ? '🔨' : f.level > 0 ? `Lv${f.level}` : '未建');
    });

    // 防禦設施：依據點規模的藍色格
    this.slotObjs.forEach((o, i) => {
      const d = sh.defenses[i];
      const p = d && cells.defense[i] && this.toScreen(cells.defense[i]);
      if (!p) {
        o.zone.setVisible(false);
        o.icon.setVisible(false);
        o.lv.setVisible(false);
        return;
      }
      const busy = core.shelter.isSlotBusy(sh, i);
      const rx = Math.max(16, 26 * this.k);
      o.zone.setVisible(true).setPosition(p.x, p.y).setSize(rx * 2, rx * 1.1);
      o.zone.geom.setSize(rx * 2, rx * 1.1);
      o.zone.updateDisplayOrigin();
      o.icon.setVisible(true).setPosition(p.x, p.y);
      o.lv.setVisible(true).setPosition(p.x, p.y + rx * 0.45);
      if (d.type) {
        const def = DEFENSES[d.type];
        o.zone.setFillStyle(def.color, 0.45);
        o.icon.setText(def.icon).setFontSize(Math.max(14, Math.round(24 * this.k)));
        o.lv.setText(busy ? '🔨' : `Lv${d.level}`);
      } else {
        o.zone.setFillStyle(0x000000, 0.3);
        o.icon.setText('+').setFontSize(Math.max(14, Math.round(20 * this.k)));
        o.lv.setText('');
      }
    });
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
