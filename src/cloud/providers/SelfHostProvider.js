import { CloudError, fetchJson } from './CloudError.js';

/**
 * 自架伺服器（server/index.js）的客戶端。
 * 支援 Server-Sent Events，其他裝置存檔時會即時通知。
 */
export class SelfHostProvider {
  constructor(baseUrl = '') {
    this.base = baseUrl.replace(/\/$/, '');
    this.name = '自架伺服器';
  }

  url(path) {
    return `${this.base}/api${path}`;
  }

  check(status, body) {
    if (status === 200) return body;
    if (status === 409) throw new CloudError('conflict', '其他裝置已更新存檔', body?.meta);
    if (status === 401 || status === 403) throw new CloudError('forbidden', '同步碼不正確');
    if (status === 404) throw new CloudError('notfound', '雲端找不到這份存檔');
    if (status === 413) throw new CloudError('server', '存檔過大');
    // 反向代理（Vite/Nginx）在後端停機時回 502~504 或無內容的 500，視為暫時離線
    if ((status >= 502 && status <= 504) || (status >= 500 && !body)) throw new CloudError('network', '雲端伺服器暫時無法連線');
    throw new CloudError('server', `伺服器錯誤（${status}）`);
  }

  async health() {
    const { status } = await fetchJson(this.url('/health'), { timeout: 4000 });
    return status === 200;
  }

  async meta(id, token) {
    const { status, body } = await fetchJson(this.url(`/saves/${id}/meta`), { headers: { Authorization: `Bearer ${token}` } });
    return this.check(status, body).meta;
  }

  /** @returns {Promise<{meta:object, data:object}>} */
  async pull(id, token) {
    const { status, body } = await fetchJson(this.url(`/saves/${id}`), { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return this.check(status, body);
  }

  /** @returns {Promise<object>} 新的 meta */
  async push(id, token, payload, { keepalive = false } = {}) {
    const body = JSON.stringify(payload);
    const { status, body: res } = await fetchJson(this.url(`/saves/${id}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      // keepalive 讓關閉分頁時的最後一次上傳仍能送出（瀏覽器限制 64KB）
      keepalive: keepalive && body.length < 60000,
      timeout: 15000,
    });
    return this.check(status, res).meta;
  }

  /**
   * 即時訂閱存檔版本變化。
   * @returns {(() => void)|null} 取消訂閱函式；不支援時回傳 null（改用輪詢）
   */
  watch(id, token, onMeta) {
    if (typeof EventSource === 'undefined') return null;
    const es = new EventSource(this.url(`/saves/${id}/events?token=${token}`));
    es.addEventListener('rev', (e) => {
      try {
        onMeta(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }
}
