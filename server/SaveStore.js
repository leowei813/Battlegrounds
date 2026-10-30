import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 雲端存檔儲存（檔案型）：每份存檔一個 JSON，寫入採「暫存檔 + rename」確保原子性。
 * 同步 I/O 讓 Node 單執行緒天然序列化同一存檔的併發寫入，不會出現 race condition。
 */
export class SaveStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  read(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  write(record) {
    const target = this.file(record.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
  }

  static meta(rec) {
    return { rev: rec.rev, updatedAt: rec.updatedAt, deviceId: rec.deviceId, deviceName: rec.deviceName };
  }

  /** 以 timing-safe 方式比對憑證雜湊 */
  static matches(rec, token) {
    const a = Buffer.from(rec.tokenHash, 'hex');
    const b = Buffer.from(String(token || ''), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * 樂觀鎖寫入：baseRev 必須等於目前版本（或 force），否則回報衝突。
   * @returns {{status:'created'|'updated'|'conflict'|'forbidden', meta?:object}}
   */
  put(id, token, { baseRev, deviceId, deviceName, data, force }) {
    const rec = this.read(id);
    const now = Date.now();
    if (!rec) {
      if (baseRev !== 0 && !force) return { status: 'conflict', meta: { rev: 0 } };
      const created = { id, tokenHash: token, rev: 1, updatedAt: now, deviceId, deviceName, data };
      this.write(created);
      return { status: 'created', meta: SaveStore.meta(created) };
    }
    if (!SaveStore.matches(rec, token)) return { status: 'forbidden' };
    if (!force && baseRev !== rec.rev) return { status: 'conflict', meta: SaveStore.meta(rec) };
    Object.assign(rec, { rev: rec.rev + 1, updatedAt: now, deviceId, deviceName, data });
    this.write(rec);
    return { status: 'updated', meta: SaveStore.meta(rec) };
  }
}
