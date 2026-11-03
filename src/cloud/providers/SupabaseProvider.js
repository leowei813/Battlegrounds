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
      // 舊版 anon key 是 JWT，可同時放 Authorization；新版 sb_publishable_ 金鑰只能放 apikey
      headers: {
        apikey: this.key,
        ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      timeout: 15000,
      ...opts,
    });
    if (status !== 200) throw new CloudError('server', `Supabase 錯誤（${status}）：${body?.message || ''}`);
    // 函式回傳 { status, meta, data }
    if (body?.status === 'forbidden') throw new CloudError('forbidden', '帳號或密碼錯誤');
    if (body?.status === 'notfound') throw new CloudError('notfound', '雲端找不到這份存檔');
    if (body?.status === 'conflict') throw new CloudError('conflict', '其他裝置已更新存檔', body.meta);
    // 例如事件類型不在資料庫允許清單中（資料庫函式是舊版，需要重新執行 supabase/schema.sql）
    if (body?.status === 'invalid') throw new CloudError('invalid', '伺服器不接受這個操作（資料庫可能需要更新）');
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

  // ---------------- 多人世界 ----------------

  async worldPut(id, token, presence) {
    const primary = presence.bases.find((b) => b.primary) || presence.bases[0];
    await this.rpc('jdqs_world_put', {
      p_id: id, p_token: token, p_payload: presence, p_lat: primary.lat, p_lon: primary.lon,
    });
  }

  async worldDelete(id, token) {
    await this.rpc('jdqs_world_delete', { p_id: id, p_token: token });
  }

  async worldNearby(lat, lon, km, excludeId) {
    const body = await this.rpc('jdqs_world_nearby', {
      p_lat: lat, p_lon: lon, p_km: km, p_exclude: excludeId || '',
    });
    return body.players || [];
  }

  /** 送出事件給其他玩家（攻擊、友好請求…） */
  async worldSend(fromId, token, toId, type, data = {}) {
    await this.rpc('jdqs_world_send', {
      p_from: fromId, p_token: token, p_to: toId, p_type: type, p_data: data,
    });
  }

  /** 共用世界物件：範圍內某種類 */
  async objList(kind, lat, lon, km) {
    const body = await this.rpc('jdqs_obj_list', { p_kind: kind, p_lat: lat, p_lon: lon, p_km: km });
    return body.objects || [];
  }

  /** 共用世界物件：一次查詢多種（[{kind, km}]） */
  async objListMany(list, lat, lon) {
    const body = await this.rpc('jdqs_obj_list_many', {
      p_kinds: list.map((x) => x.kind), p_kms: list.map((x) => x.km), p_lat: lat, p_lon: lon,
    });
    return body.objects || [];
  }

  /** 共用世界物件：以版本號寫入；回傳 { status: 'ok'|'conflict', obj }（conflict 不丟錯） */
  async objPut(fromId, token, kind, id, { lat = null, lon = null, data, ver = 0 }) {
    const { status, body } = await fetchJson(`${this.base}/rest/v1/rpc/jdqs_obj_put`, {
      method: 'POST',
      headers: {
        apikey: this.key,
        ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_from: fromId, p_token: token, p_kind: kind, p_id: id, p_lat: lat, p_lon: lon, p_data: data, p_ver: ver }),
      timeout: 15000,
    });
    if (status !== 200) throw new CloudError('server', `Supabase 錯誤（${status}）：${body?.message || ''}`);
    if (body?.status === 'conflict') return { status: 'conflict', obj: body.obj || null };
    if (body?.status === 'forbidden') throw new CloudError('forbidden', '帳號或密碼錯誤');
    if (body?.status === 'invalid') throw new CloudError('invalid', '伺服器不接受這個操作（資料庫可能需要更新）');
    return body;
  }

  /** 全服聊天：讀取 after 之後的訊息與被檢舉隱藏的訊息編號 */
  async chatList(after = 0) {
    const body = await this.rpc('jdqs_chat_list', { p_after: Number(after) || 0 });
    return { messages: body.messages || [], hidden: body.hidden || [] };
  }

  /** 全服聊天：送出訊息；回傳 { status: 'ok'|'slow', msg?, waitMs? } */
  async chatSend(fromId, token, text) {
    return this.rpc('jdqs_chat_send', { p_from: fromId, p_token: token, p_text: text });
  }

  async chatReport(fromId, token, id) {
    return this.rpc('jdqs_chat_report', { p_from: fromId, p_token: token, p_id: Number(id) });
  }

  /** 讀取並清空自己的事件信箱 */
  async worldInbox(id, token) {
    const body = await this.rpc('jdqs_world_inbox', { p_id: id, p_token: token });
    return body.events || [];
  }
}
