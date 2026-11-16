/** v15.9：控制點的報告（攻打、集結攻打、駐防）放在「🚩 控制點」分頁；舊報告依名稱判斷 */
export const isCpReport = (r) => !!r.cp || /控制點 #\d+/.test(String(r.poiName || ''));
/** v15.15：地下城（副本）報告放在「🕳️ 地下城」分頁 */
export const isDgReport = (r) => r.kind === 'dungeon';

/** 每個分頁（探索、控制點、地下城）各自保留的報告數 */
export const REPORT_KEEP = 20;

/** v16.1：報告依分頁各自保留最新 REPORT_KEEP 筆（避免探索報告把地下城、控制點的報告擠掉） */
export function trimReports(list) {
  const n = { e: 0, c: 0, d: 0 };
  return (list || []).filter((r) => {
    const k = isDgReport(r) ? 'd' : isCpReport(r) ? 'c' : 'e';
    n[k] += 1;
    return n[k] <= REPORT_KEEP;
  });
}
