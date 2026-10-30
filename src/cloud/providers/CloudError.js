/**
 * 雲端操作錯誤。kind：
 *  - conflict  其他裝置已寫入較新版本（附 meta）
 *  - forbidden 帳號或密碼錯誤
 *  - taken     註冊時帳號已被使用
 *  - invalid   帳號或密碼格式錯誤
 *  - notfound  雲端沒有這份存檔
 *  - network   連線失敗或逾時
 *  - server    伺服器錯誤
 */
export class CloudError extends Error {
  constructor(kind, message, meta = null) {
    super(message);
    this.kind = kind;
    this.meta = meta;
  }
}

export async function fetchJson(url, { timeout = 8000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    throw new CloudError('network', err.name === 'AbortError' ? '連線逾時' : '無法連線到雲端伺服器');
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 回應 */
  }
  return { status: res.status, body };
}
