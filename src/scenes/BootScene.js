import Phaser from 'phaser';
import fortress from '../assets/bases/fortress.webp';

/**
 * 啟動場景：載入避難所底圖，並以程式繪製其他貼圖，完成後進入避難所場景。
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    this.load.image('fortress', fortress);
  }

  create() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });

    // 殭屍（白色，執行時以 tint 上色）
    g.fillStyle(0xffffff, 1).fillCircle(16, 16, 14);
    g.fillStyle(0x000000, 0.35).fillCircle(11, 12, 3).fillCircle(21, 12, 3);
    g.generateTexture('zombie', 32, 32);
    g.clear();

    // 粒子
    g.fillStyle(0xffffff, 1).fillCircle(4, 4, 4);
    g.generateTexture('particle', 8, 8);
    g.clear();

    // 地面磚
    g.fillStyle(0x2b2f26, 1).fillRect(0, 0, 64, 64);
    g.fillStyle(0x323729, 1).fillRect(0, 0, 32, 32).fillRect(32, 32, 32, 32);
    for (let i = 0; i < 18; i += 1) {
      g.fillStyle(0x3d4433, Phaser.Math.FloatBetween(0.3, 0.8));
      g.fillCircle(Phaser.Math.Between(0, 64), Phaser.Math.Between(0, 64), Phaser.Math.Between(1, 3));
    }
    g.generateTexture('ground', 64, 64);
    g.destroy();

    this.scene.start('Shelter');
  }
}
