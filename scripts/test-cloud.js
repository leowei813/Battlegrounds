/**
 * 雲端存檔伺服器 + 客戶端整合測試（不需瀏覽器）：
 *   npm run test:cloud
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfHostProvider } from '../src/cloud/providers/SelfHostProvider.js';
import { credentials, validateCredentials, normalizeUsername } from '../src/cloud/account.js';

const rand = () => `t${Math.random().toString(36).slice(2, 12)}`;

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdqs-cloud-'));
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: path.join(dataDir, 'none') },
  stdio: 'inherit',
});

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
};
const expectError = async (p, kind, msg) => {
  try {
    await p;
    assert(false, msg);
  } catch (err) {
    assert(err.kind === kind, `${msg}（${err.kind}）`);
  }
};

async function run() {
  const api = new SelfHostProvider(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 50 && !(await api.health().catch(() => false)); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(await api.health(), '伺服器啟動');

  // ---- 帳號 ----
  assert(normalizeUsername('  Leo_01 ') === 'leo_01', '帳號正規化（小寫、去空白）');
  assert(validateCredentials('ab', 'secret1') && validateCredentials('leo', '123') && !validateCredentials('leo_01', 'secret1'), '帳號密碼格式檢查');
  const user = rand();
  const { id, token } = credentials(user, 'secret1');
  assert(credentials(user, 'secret1').token === token && credentials(user, 'secret2').token !== token, '同帳號密碼產生相同憑證，不同密碼不同');
  const save = { version: 1, player: { name: 'A' }, shelter: {} };

  const m1 = await api.push(id, token, { baseRev: 0, deviceId: 'devA', deviceName: 'A', data: save });
  assert(m1.rev === 1, '建立雲端存檔 rev=1');
  const m2 = await api.push(id, token, { baseRev: 1, deviceId: 'devA', deviceName: 'A', data: { ...save, player: { name: 'A2' } } });
  assert(m2.rev === 2, '更新 rev=2');
  const pulled = await api.pull(id, token);
  assert(pulled.data.player.name === 'A2' && pulled.meta.deviceId === 'devA', '另一台裝置讀取最新存檔');

  await expectError(api.push(id, token, { baseRev: 1, deviceId: 'devB', deviceName: 'B', data: save }), 'conflict', '舊版本寫入被拒（樂觀鎖）');
  await expectError(api.meta(id, credentials(user, 'wrong-pw').token), 'forbidden', '密碼錯誤被拒');
  await expectError(api.meta(credentials(rand(), 'secret1').id, token), 'notfound', '不存在的帳號');
  await expectError(api.push(id, credentials(user, 'wrong-pw').token, { baseRev: 0, deviceId: 'x', deviceName: 'x', data: save }), 'forbidden', '帳號已被使用時無法以其他密碼建立');

  // SSE 即時通知
  const events = [];
  const ctrl = new AbortController();
  const sse = fetch(`http://127.0.0.1:${PORT}/api/saves/${id}/events?token=${token}`, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      dec.decode(value).split('\n').filter((l) => l.startsWith('data:')).forEach((l) => events.push(JSON.parse(l.slice(5))));
    }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const m3 = await api.push(id, token, { baseRev: 0, deviceId: 'devB', deviceName: 'B', data: save, force: true });
  await new Promise((r) => setTimeout(r, 200));
  assert(m3.rev === 3, '接管（force）寫入 rev=3');
  assert(events.some((e) => e.rev === 3 && e.deviceId === 'devB'), 'SSE 即時收到其他裝置的更新');
  ctrl.abort();
  await sse;

  // ---- 多人世界 ----
  const pA = credentials(rand(), 'pw-aaaa');
  const pB = credentials(rand(), 'pw-bbbb');
  const now = Date.now();
  await api.worldPut(pA.id, pA.token, {
    name: '玩家A<script>', civ: 120,
    bases: [{ lat: 25.04, lon: 121.56, name: '基地', primary: true, size: 'large' }],
    trips: [{ from: { lat: 25.04, lon: 121.56 }, to: { lat: 25.05, lon: 121.57 }, startAt: now, endAt: now + 600000, travelMs: 120000, searchMs: 360000, members: 2, target: '醫院' }],
  });
  const seenByB = await api.worldNearby(25.041, 121.561, 5, pB.id);
  assert(seenByB.length === 1 && seenByB[0].name === '玩家A<script>'.slice(0, 16) && seenByB[0].trips.length === 1, '其他玩家看得到公開的據點與探索隊伍');
  assert(!('tokenHash' in seenByB[0]), '不會洩漏身分憑證');
  assert((await api.worldNearby(25.04, 121.56, 5, pA.id)).length === 0, '自己不會出現在自己的列表');
  assert((await api.worldNearby(35.0, 139.0, 5, pB.id)).length === 0, '遠方玩家不會出現');
  await expectError(api.worldPut(pA.id, pB.token, { name: 'x', bases: [{ lat: 0, lon: 0 }] }), 'forbidden', '無法冒用他人身分更新');
  await expectError(api.worldPut(pB.id, pB.token, { name: 'x', bases: [{ lat: 999, lon: 0 }] }), 'server', '無效座標被拒');
  assert(seenByB[0].bases[0].alert > 0 && 'guards' in seenByB[0].bases[0], '公開資料包含警戒範圍與駐守人數');
  // 事件信箱（攻擊、友好請求）
  await api.worldPut(pB.id, pB.token, { name: '玩家B', bases: [{ lat: 25.041, lon: 121.561, name: 'B家', primary: true, size: 'small', alert: 70, guards: 1 }] });
  await api.worldSend(pB.id, pB.token, pA.id, 'friendRequest');
  await expectError(api.worldSend(pB.id, pA.token, pA.id, 'attack'), 'forbidden', '無法冒用他人身分送出事件');
  await expectError(api.worldSend(pB.id, pB.token, pA.id, 'hack'), 'server', '不允許的事件類型被拒');
  const inbox = await api.worldInbox(pA.id, pA.token);
  assert(inbox.length === 1 && inbox[0].type === 'friendRequest' && inbox[0].from === pB.id && inbox[0].fromName === '玩家B', '收到其他玩家的事件');
  assert((await api.worldInbox(pA.id, pA.token)).length === 0, '讀取後清空信箱');
  await expectError(api.worldInbox(pA.id, pB.token), 'forbidden', '無法讀取他人信箱');
  await api.worldDelete(pA.id, pA.token);
  assert((await api.worldNearby(25.04, 121.56, 5, pB.id)).length === 0, '停止公開後立即從世界移除');
}

run()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(() => {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
    process.exit(failures ? 1 : 0);
  });
