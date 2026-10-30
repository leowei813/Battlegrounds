/**
 * 計算通行碼雜湊（建置時注入為 VITE_ACCESS_HASH）。
 * 通行碼由環境變數 ACCESS_CODE 提供，避免出現在指令列或日誌中：
 *
 *   ACCESS_CODE='你的通行碼' node scripts/hash-access-code.js
 */
import { hashAccessCode } from '../src/security/accessHash.js';

const code = process.env.ACCESS_CODE || '';
if (!code.trim()) {
  console.error('請以環境變數 ACCESS_CODE 提供通行碼');
  process.exit(1);
}
process.stdout.write(hashAccessCode(code));
