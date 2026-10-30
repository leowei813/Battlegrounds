import { hashAccessCode } from './accessHash.js';
import { GAME_TITLE } from '../config/constants.js';
import { COPYRIGHT } from '../config/legal.js';
import { APP_VERSION } from '../config/version.js';

const STORE_KEY = 'jdqs_access_v1';
/** 建置時注入的通行碼雜湊；未設定時不啟用通行碼 */
const EXPECTED = (import.meta.env?.VITE_ACCESS_HASH || '').toLowerCase();

const remembered = () => {
  try {
    return localStorage.getItem(STORE_KEY) === EXPECTED;
  } catch {
    return false;
  }
};

export const accessGateEnabled = () => /^[0-9a-f]{64}$/.test(EXPECTED);

/** 清除本裝置的通行憑證（下次開啟需重新輸入） */
export function lockDevice() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 通行碼畫面：通過前不載入遊戲。
 *
 * 注意：這是前端驗證，只能阻擋一般訪客；懂技術的人仍可下載公開的程式碼自行執行。
 * 需要真正的存取控制時，請改用伺服器端驗證（例如 Cloudflare Access）。
 * @param {HTMLElement} root
 */
export function requireAccess(root) {
  if (!accessGateEnabled() || remembered()) return Promise.resolve();
  return new Promise((resolve) => {
    root.innerHTML = `
      <form class="gate-card" autocomplete="off">
        <h1 class="logo">${GAME_TITLE}<small>ACCESS RESTRICTED</small></h1>
        <p class="lore">🔒 此遊戲目前僅限受邀玩家遊玩。<br>請輸入通行碼。</p>
        <input type="password" name="code" placeholder="通行碼" autocomplete="current-password" required>
        <label class="toggle"><input type="checkbox" name="remember" checked> 記住這台裝置</label>
        <p class="status" aria-live="polite"></p>
        <button type="submit" class="btn btn-danger wide big">進入</button>
        <p class="copyright">${COPYRIGHT}・v${APP_VERSION}</p>
      </form>`;
    root.classList.add('show');
    const form = root.querySelector('form');
    const input = form.querySelector('input[name=code]');
    const status = form.querySelector('.status');
    const submit = form.querySelector('button[type=submit]');
    let failures = 0;
    input.focus();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      status.textContent = '驗證中…';
      // 讓「驗證中」先畫出來，再進行耗時的雜湊運算
      setTimeout(() => {
        const ok = hashAccessCode(input.value) === EXPECTED;
        if (ok) {
          if (form.remember.checked) {
            try {
              localStorage.setItem(STORE_KEY, EXPECTED);
            } catch {
              /* ignore */
            }
          }
          root.classList.remove('show');
          root.innerHTML = '';
          resolve();
          return;
        }
        failures += 1;
        // 連續錯誤時逐漸拉長等待時間
        const wait = Math.min(30, 2 ** Math.max(0, failures - 3));
        status.textContent = failures > 3 ? `❌ 通行碼錯誤，請 ${wait} 秒後再試` : '❌ 通行碼錯誤';
        input.select();
        setTimeout(() => { submit.disabled = false; }, failures > 3 ? wait * 1000 : 300);
      }, 30);
    });
  });
}
