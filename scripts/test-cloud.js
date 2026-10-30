/**
 * 雲端存檔伺服器 + 客戶端整合測試（不需瀏覽器）：
 *   npm run test:cloud
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfHostProvider } from '../src/cloud/providers/SelfHostProvider.js';
import { generateCode, saveIdFromCode, tokenFromCode, normalizeCode, formatCode } from '../src/cloud/syncCode.js';

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

  const code = generateCode();
  assert(normalizeCode(formatCode(code).toLowerCase()) === code, '同步碼格式化 / 正規化');
  const id = saveIdFromCode(code);
  const token = tokenFromCode(code);
  const save = { version: 1, player: { name: 'A' }, shelter: {} };

  const m1 = await api.push(id, token, { baseRev: 0, deviceId: 'devA', deviceName: 'A', data: save });
  assert(m1.rev === 1, '建立雲端存檔 rev=1');
  const m2 = await api.push(id, token, { baseRev: 1, deviceId: 'devA', deviceName: 'A', data: { ...save, player: { name: 'A2' } } });
  assert(m2.rev === 2, '更新 rev=2');
  const pulled = await api.pull(id, token);
  assert(pulled.data.player.name === 'A2' && pulled.meta.deviceId === 'devA', '另一台裝置讀取最新存檔');

  await expectError(api.push(id, token, { baseRev: 1, deviceId: 'devB', deviceName: 'B', data: save }), 'conflict', '舊版本寫入被拒（樂觀鎖）');
  await expectError(api.meta(id, tokenFromCode(generateCode())), 'forbidden', '錯誤同步碼被拒');
  await expectError(api.meta(saveIdFromCode(generateCode()), token), 'notfound', '不存在的存檔');

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
