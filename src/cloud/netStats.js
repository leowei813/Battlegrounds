/**
 * v17.4：本次連線的網路用量（下載＝伺服器回傳的資料，未壓縮的位元組數；上傳＝送出的資料）。
 * 所有雲端與多人連線都經過 fetchJson，在那裡累計。
 */
export const NET = { down: 0, up: 0, since: Date.now(), calls: 0 };

const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export const byteLen = (s) => (s ? (enc ? enc.encode(s).length : String(s).length) : 0);

export function countNet(down, up = 0) {
  NET.down += down || 0;
  NET.up += up || 0;
  NET.calls += 1;
}
