/**
 * 管理員重設玩家密碼。
 *
 * 伺服器只存密碼經反覆雜湊後的 token，看不到原本的密碼，所以「找回」密碼的方式是：
 * 玩家向管理員證明帳號是自己的之後，由管理員設定一組新密碼，再告訴玩家。
 *
 * 用法：npm run reset-password -- <帳號> <新密碼>
 * 會輸出一段 SQL，貼到 Supabase → SQL Editor 執行即可（存檔、建築清單、公開據點一併更新）。
 */
import { sha256 } from '../src/utils/sha256.js';
import { credentials, normalizeUsername, validateCredentials } from '../src/cloud/account.js';

const [rawUser, password] = process.argv.slice(2);
const username = normalizeUsername(rawUser);
const err = validateCredentials(username, password);
if (!rawUser || !password || err) {
  console.error(err ? `❌ ${err}` : '用法：npm run reset-password -- <帳號> <新密碼>');
  process.exit(1);
}

const { id, token } = credentials(username, password);
const mapId = sha256(`jdqs-map:${id}`).slice(0, 32);
const worldId = sha256(`jdqs-world:${id}`).slice(0, 32);
const worldToken = sha256(`jdqs-world-token:${token}`);

console.log(`-- 重設帳號「${username}」的密碼（帳號 ID ${id}）
-- 最後的查詢結果應為 1～2（存檔、建築清單）；若為 0 代表帳號不存在或帳號打錯
update public.jdqs_saves set token_hash = '${token}' where id in ('${id}', '${mapId}');
update public.jdqs_world set token_hash = '${worldToken}' where id = '${worldId}';
select count(*) as updated_saves from public.jdqs_saves where id in ('${id}', '${mapId}') and token_hash = '${token}';`);
console.error(`\n✅ 已產生 SQL。執行後請通知玩家用新密碼登入，並建議玩家登入後自行記好密碼。`);
