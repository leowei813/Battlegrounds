import { CloudError, fetchJson } from './CloudError.js';

/**
 * Supabase 後端（免自架）。資料表與 RPC 函式定義見 supabase/schema.sql。
 * 資料表啟用 RLS 且不開放任何 policy，所有存取都必須經過驗證憑證的 SECURITY DEFINER 函式。
 * 即時通知以輪詢 meta 實作（CloudSync 每 10 秒一次）。
 */
export class SupabaseProvider {
  constructor(url, anonKey) {
    this.base = url.replace(/\/$/, '');
    this.key = anonKey;
    this.name = 'Supabase';
  }

  async rpc(fn, args, opts = {}) {
    const { status, body } = await fetchJson(`${this.base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      timeout: 15000,
      ...opts,
    });
    if (status !== 200) throw new CloudError('server', `Supabase 錯誤（${status}）：${body?.message || ''}`);
    // 函式回傳 { status, meta, data }
    if (body?.status === 'forbidden') throw new CloudError('forbidden', '同步碼不正確');
    if (body?.status === 'notfound') throw new CloudError('notfound', '雲端找不到這份存檔');
    if (body?.status === 'conflict') throw new CloudError('conflict', '其他裝置已更新存檔', body.meta);
    return body;
  }

  async health() {
    try {
      await this.rpc('jdqs_save_meta', { p_id: '0'.repeat(32), p_token: '0'.repeat(64) });
      return true;
    } catch (err) {
      return err.kind === 'notfound' || err.kind === 'forbidden';
    }
  }

  async meta(id, token) {
    return (await this.rpc('jdqs_save_meta', { p_id: id, p_token: token })).meta;
  }

  async pull(id, token) {
    const body = await this.rpc('jdqs_save_get', { p_id: id, p_token: token });
    return { meta: body.meta, data: body.data };
  }

  async push(id, token, payload, { keepalive = false } = {}) {
    const args = {
      p_id: id,
      p_token: token,
      p_base_rev: payload.baseRev,
      p_device_id: payload.deviceId,
      p_device_name: payload.deviceName,
      p_data: payload.data,
      p_force: !!payload.force,
    };
    const body = await this.rpc('jdqs_save_put', args, { keepalive: keepalive && JSON.stringify(args).length < 60000 });
    return body.meta;
  }

  watch() {
    return null;
  }
}
