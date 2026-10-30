import { sha256 } from '../utils/sha256.js';

/**
 * 通行碼雜湊：反覆 SHA-256 多次以提高暴力破解成本。
 * 瀏覽器（AccessGate）與建置腳本（scripts/hash-access-code.js）共用同一演算法，
 * 因此原始通行碼不會出現在前端程式碼中。
 */
export const ACCESS_ITERATIONS = 50000;

export function hashAccessCode(code) {
  let h = `jdqs-gate:${String(code).trim()}`;
  for (let i = 0; i < ACCESS_ITERATIONS; i += 1) h = sha256(h);
  return h;
}
