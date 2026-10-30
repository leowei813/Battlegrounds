/**
 * 解析 CHANGELOG.md（純函式，瀏覽器與 Node 檢查腳本共用）。
 *
 * 格式：
 *   ## [1.9.0] - 2026-10-30
 *   ### 新增
 *   - 內容
 *
 * @returns {Array<{version:string, date:string, sections:Array<{title:string, items:string[]}>}>} 新版本在前
 */
export function parseChangelog(md) {
  const entries = [];
  let entry = null;
  let section = null;
  String(md).split(/\r?\n/).forEach((line) => {
    const v = /^##\s+\[([^\]]+)\]\s*-\s*(\S+)/.exec(line);
    if (v) {
      entry = { version: v[1], date: v[2], sections: [] };
      entries.push(entry);
      section = null;
      return;
    }
    const s = /^###\s+(.+)/.exec(line);
    if (s && entry) {
      section = { title: s[1].trim(), items: [] };
      entry.sections.push(section);
      return;
    }
    const item = /^\s*[-*]\s+(.+)/.exec(line);
    if (item && section) section.items.push(item[1].trim());
  });
  return entries;
}

/** 比較版本號：a > b 回傳正數 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
