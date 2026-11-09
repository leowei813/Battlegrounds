/**
 * 材料需求與掉落配比報表（同類別、同階互比）。
 * 用法：npm run balance          → 在終端機印出報表
 *       npm run balance -- --md  → 重新產生 docs/material-balance.md 的報表區塊
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { SUPPLIES, SUPPLY_KEYS, SUPPLY_CATS } from '../src/config/supplies.js';
import { materialDemand, balanceMultipliers, consumableMaterials, BALANCE } from '../src/systems/MaterialBalance.js';
import { baseSupplyWeight } from '../src/systems/LootStock.js';

const { total, bySrc } = materialDemand();
const mul = balanceMultipliers(baseSupplyWeight);
const keep = new Set(consumableMaterials());
const lines = [];
const pct = (v) => `${(v * 100).toFixed(1)}%`;
['part', 'fabric'].forEach((cat) => {
  for (let t = 1; t <= 5; t += 1) {
    const keys = SUPPLY_KEYS.filter((k) => SUPPLIES[k].cat === cat && SUPPLIES[k].tier === t && SUPPLIES[k].tag !== 'ammo');
    if (!keys.length) continue;
    const D = keys.reduce((a, k) => a + (total[k] || 0), 0);
    const W0 = keys.reduce((a, k) => a + baseSupplyWeight(k), 0);
    const W1 = keys.reduce((a, k) => a + baseSupplyWeight(k) * (mul[k] ?? 1), 0);
    lines.push(`\n### ${SUPPLY_CATS[cat].name} ${t} 階\n`);
    lines.push('| 材料 | 需求總量 | 佔需求 | 原本佔掉落 | 調整後佔掉落 | 倍率 | 主要用途 |');
    lines.push('|---|---|---|---|---|---|---|');
    keys.sort((a, b) => (total[b] || 0) - (total[a] || 0)).forEach((k) => {
      const src = Object.entries(bySrc[k] || {}).sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 2).join('、') || '—';
      lines.push(`| ${SUPPLIES[k].name}${keep.has(k) ? '（消耗品材料）' : ''} | ${Math.round(total[k] || 0)} | ${pct(D ? (total[k] || 0) / D : 0)} | ${pct(baseSupplyWeight(k) / W0)} | ${pct((baseSupplyWeight(k) * (mul[k] ?? 1)) / W1)} | ×${(mul[k] ?? 1).toFixed(2)} | ${src} |`);
    });
  }
});
const report = lines.join('\n');
if (process.argv.includes('--md')) {
  const p = new URL('../docs/material-balance.md', import.meta.url);
  const doc = readFileSync(p, 'utf8');
  const start = '<!-- balance:start -->';
  const end = '<!-- balance:end -->';
  const out = doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${report}\n\n${end}`);
  writeFileSync(p, out);
  console.log('已更新 docs/material-balance.md');
} else {
  console.log(`倍率範圍 ×${BALANCE.min}～×${BALANCE.max}（消耗品材料至少 ×1）`);
  console.log(report);
}
