import { CLASSES } from '../config/survivors.js';
import { GAME_TITLE } from '../config/constants.js';
import { COPYRIGHT } from '../config/legal.js';
import { APP_VERSION, CHANGELOG } from '../config/version.js';
import { versionHtml } from './ChangelogView.js';
import { randomInWorld } from '../config/world.js';


/**
 * 建立角色：輸入名字、選擇領袖職業。v13 起所有玩家在同一張固定地圖，起點在地圖範圍內隨機決定。帳號註冊後或重置進度後顯示。
 */
export class SetupScreen {
  /**
   * @param {HTMLElement} root
   * @param {string} [account] 目前登入的帳號（顯示用）
   */
  constructor(root, account = '') {
    this.root = root;
    this.account = account;
  }

  /** @returns {Promise<{type:'new', playerName, classId, lat, lon}>} */
  show() {
    return new Promise((resolve) => {
      this.root.innerHTML = this.template();
      this.root.classList.add('show');
      const $ = (s) => this.root.querySelector(s);
      let classId = 'warrior';

      this.root.querySelectorAll('.class-opt').forEach((el) => {
        el.addEventListener('click', () => {
          this.root.querySelectorAll('.class-opt').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          classId = el.dataset.class;
        });
      });

      $('#setup-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = $('#in-name').value.trim() || '倖存者';
        // 起點：固定地圖範圍內的隨機位置（之後在地圖上選一棟建築作為避難所）
        const { lat, lon } = randomInWorld();
        this.hide();
        resolve({ type: 'new', playerName: name.slice(0, 16), classId, lat, lon });
      });
    });
  }

  hide() {
    this.root.classList.remove('show');
    this.root.innerHTML = '';
  }

  template() {
    const classes = Object.entries(CLASSES)
      .map(([id, c], i) => `
        <button type="button" class="class-opt ${i === 0 ? 'active' : ''}" data-class="${id}" style="--cc:${c.color}">
          <span>${c.icon}</span><b>${c.name}</b><small>${c.skills[0].name}：${c.skills[0].desc}</small>
        </button>`)
      .join('');
    return `
    <div class="setup-card">
      <h1 class="logo">${GAME_TITLE}<small>ZOMBIE OUTBREAK · IDLE SURVIVAL</small></h1>
      <div class="home-version"><span class="ver-tag">v${APP_VERSION}</span></div>
      <p class="lore">病毒在一夜之間席捲全球。城市淪陷、通訊中斷……<br>你是少數的倖存者之一。在真實世界的街道上建立避難所，活下去。</p>
      <div class="home-news">${CHANGELOG[0] ? versionHtml(CHANGELOG[0], { open: false, label: '🆕 最新更新' }) : ''}</div>
      ${this.account ? `<p class="muted">帳號 <b>${this.account}</b>：建立你的角色</p>` : ''}
      <form id="setup-form">
        <label>倖存者名稱<input id="in-name" maxlength="16" placeholder="輸入你的名字" autocomplete="off"></label>
        <div class="label">選擇你的職業</div>
        <div class="class-grid">${classes}</div>
        <p class="setup-world">📍 所有倖存者都在同一座城市求生，開始後地圖會從範圍內的隨機位置開始，點選一棟建築作為你的避難所。</p>
        <p id="setup-status" class="status"></p>
        <button type="submit" class="btn btn-danger wide big">☣️ 開始求生</button>
      </form>
      <p class="copyright">${COPYRIGHT}・v${APP_VERSION}</p>
    </div>`;
  }
}
