import { sha256 } from '../utils/sha256.js';

/**
 * 同步碼：玩家在不同裝置間連結同一份雲端存檔的唯一憑證（免註冊帳號）。
 *
 *  - code    24 字元（120 bits 隨機），顯示為 XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
 *  - id      由 code 雜湊而來，作為雲端存檔主鍵；伺服器拿到 id 也推不回 code
 *  - token   伺服器端保存的雜湊值，僅用於訂閱「存檔已更新」通知
 *
 * 排除易混淆字元 0/O、1/I。
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN = 24;

export function generateCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

/** 正規化玩家輸入（去除分隔符號、轉大寫）；不合法回傳 null */
export function normalizeCode(input) {
  const code = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== CODE_LEN) return null;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export const formatCode = (code) => code.match(/.{1,4}/g).join('-');

export const saveIdFromCode = (code) => sha256(`jdqs-id:${code}`).slice(0, 32);

export const tokenFromCode = (code) => sha256(`jdqs-secret:${code}`);
