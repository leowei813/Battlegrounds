import { GAME_TITLE } from '../config/constants.js';
import { COPYRIGHT } from '../config/legal.js';
import { APP_VERSION, CHANGELOG } from '../config/version.js';
import { PASSWORD_MIN } from '../cloud/account.js';
import { escapeHtml } from '../utils/dom.js';
import { versionHtml } from './ChangelogView.js';

const nextFrame = () => new Promise((r) => setTimeout(r, 30));

/**
 * 首頁：帳號登入 / 註冊。登入後直接讀取雲端進度。
 */
export class AuthScreen {
  /**
   * @param {HTMLElement} root
   * @param {import('../cloud/CloudSync.js').CloudSync} cloud
   */
  constructor(root, cloud) {
    this.root = root;
    this.cloud = cloud;
    this.mode = 'login';
  }

  /**
   * @param {{message?:string}} [opts] 顯示在表單上方的訊息（例如連線失敗）
   * @returns {Promise<{type:'login', state:object|null, meta?:object}|{type:'register'}>}
   */
  show({ message = '' } = {}) {
    return new Promise((resolve) => {
      const render = () => {
        this.root.innerHTML = this.template(message);
        this.root.classList.add('show');
        bind();
      };
      const bind = () => {
        const $ = (s) => this.root.querySelector(s);
        const status = $('#auth-status');
        this.root.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', () => {
          this.mode = el.dataset.mode;
          message = '';
          render();
        }));
        $('#auth-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const user = $('#in-user').value;
          const pw = $('#in-pw').value;
          const submit = $('#auth-submit');
          if (this.mode === 'register' && pw !== $('#in-pw2').value) {
            status.textContent = '❌ 兩次輸入的密碼不一致';
            return;
          }
          submit.disabled = true;
          status.textContent = this.mode === 'login' ? '🔐 登入中，讀取雲端進度…' : '🔐 建立帳號中…';
          await nextFrame(); // 先讓訊息顯示，再計算密碼雜湊
          try {
            if (this.mode === 'login') {
              const r = await this.cloud.login(user, pw);
              this.hide();
              resolve({ type: 'login', ...r });
            } else {
              await this.cloud.register(user, pw);
              this.hide();
              resolve({ type: 'register' });
            }
          } catch (err) {
            status.textContent = `❌ ${err.message}`;
            submit.disabled = false;
          }
        });
      };
      render();
    });
  }

  hide() {
    this.root.classList.remove('show');
    this.root.innerHTML = '';
  }

  template(message) {
    const reg = this.mode === 'register';
    const off = !this.cloud.available;
    return `
    <div class="setup-card">
      <h1 class="logo">${GAME_TITLE}<small>ZOMBIE OUTBREAK · IDLE SURVIVAL</small></h1>
      <div class="home-version"><span class="ver-tag">v${APP_VERSION}</span></div>
      <p class="lore">病毒在一夜之間席捲全球。城市淪陷、通訊中斷……<br>你是少數的倖存者之一。在真實世界的街道上建立避難所，活下去。</p>
      <div class="home-news">${CHANGELOG[0] ? versionHtml(CHANGELOG[0], { open: false, label: '🆕 最新更新' }) : ''}</div>
      <div class="auth-tabs">
        <button type="button" class="chip ${reg ? '' : 'active'}" data-mode="login">🔑 登入</button>
        <button type="button" class="chip ${reg ? 'active' : ''}" data-mode="register">✨ 註冊新帳號</button>
      </div>
      ${message ? `<p class="status warn">${escapeHtml(message)}</p>` : ''}
      ${off ? '<p class="status warn">此版本沒有設定雲端伺服器，無法登入。</p>' : ''}
      <form id="auth-form" autocomplete="on">
        <label>帳號<input id="in-user" name="username" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="3～20 個英文小寫、數字或底線"></label>
        <label>密碼<input id="in-pw" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="至少 ${PASSWORD_MIN} 個字元"></label>
        ${reg ? '<label>確認密碼<input id="in-pw2" type="password" autocomplete="new-password"></label>' : ''}
        <p id="auth-status" class="status"></p>
        <button type="submit" id="auth-submit" class="btn ${reg ? 'btn-primary' : 'btn-danger'} wide big" ${off ? 'disabled' : ''}>${reg ? '✨ 建立帳號' : '☣️ 登入並開始求生'}</button>
      </form>
      <p class="muted small">進度只儲存在雲端帳號，換裝置登入同一個帳號即可接續。${reg ? '<b>請牢記密碼，忘記密碼無法找回。</b>' : ''}</p>
      <p class="copyright">${COPYRIGHT}・v${APP_VERSION}</p>
    </div>`;
  }
}
