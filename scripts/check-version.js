/**
 * 版本與更新日誌檢查（npm run check 的一部分，部署前會執行）：
 *  - package.json 的版本必須是 CHANGELOG.md 最上方的版本
 *  - 版本由新到舊排列、不重複，每個版本都有日期與改動內容
 */
import { readFileSync } from 'node:fs';
import { parseChangelog, compareVersions } from '../src/utils/changelog.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const entries = parseChangelog(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
const errors = [];

if (!entries.length) errors.push('CHANGELOG.md 沒有任何版本');
if (entries[0]?.version !== pkg.version) {
  errors.push(`package.json 版本 ${pkg.version} 與 CHANGELOG.md 最新版本 ${entries[0]?.version} 不一致——每次改動請升版本號並新增更新日誌`);
}
entries.forEach((e, i) => {
  if (!/^\d+\.\d+\.\d+$/.test(e.version)) errors.push(`版本格式錯誤：${e.version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errors.push(`${e.version} 日期格式錯誤：${e.date}`);
  if (!e.sections.some((s) => s.items.length)) errors.push(`${e.version} 沒有改動內容`);
  if (i > 0 && compareVersions(entries[i - 1].version, e.version) <= 0) errors.push(`版本順序錯誤：${entries[i - 1].version} 應大於 ${e.version}`);
});

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
if (!readme.includes(`**v${pkg.version}**`)) errors.push(`README.md 的「目前版本」不是 v${pkg.version}`);

if (errors.length) {
  errors.forEach((e) => console.error(`✗ ${e}`));
  process.exit(1);
}
console.log(`✓ 版本 v${pkg.version}，更新日誌 ${entries.length} 個版本`);
