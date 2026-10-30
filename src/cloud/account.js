import { sha256 } from '../utils/sha256.js';

/**
 * 帳號憑證（帳號 + 密碼，不需 Email）。
 *
 *  - id     由帳號雜湊而來，作為雲端存檔主鍵
 *  - token  由「帳號 + 密碼」反覆雜湊 10,000 次而來，伺服器只拿到 token，看不到密碼；
 *           反覆雜湊讓資料外洩時難以暴力破解密碼
 *
 * 一律使用純 JS 的 SHA-256（crypto.subtle 只在 HTTPS/localhost 可用），
 * 確保任何裝置算出的 token 都相同。
 */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 6;
const ROUNDS = 10000;

export const normalizeUsername = (s) => String(s || '').trim().toLowerCase();

/** @returns {string} 錯誤訊息；合法時回傳空字串 */
export function validateCredentials(username, password) {
  if (!USERNAME_RE.test(username)) return '帳號需為 3～20 個英文小寫、數字或底線';
  if (String(password || '').length < PASSWORD_MIN) return `密碼至少 ${PASSWORD_MIN} 個字元`;
  return '';
}

export const accountId = (username) => sha256(`jdqs-acct:${username}`).slice(0, 32);

export function deriveToken(username, password) {
  let h = sha256(`jdqs-pw:${username}:${password}`);
  for (let i = 0; i < ROUNDS; i += 1) h = sha256(`${h}${password}`);
  return h;
}

/** @returns {{username:string, id:string, token:string}} */
export function credentials(username, password) {
  return { username, id: accountId(username), token: deriveToken(username, password) };
}
