/**
 * 研究、設施、防禦建築共用的等級規則（最高 15 級）。
 *
 * 時長（現實秒數）：前 6 級成長較緩（都在 1 天以內），之後每級增加得越來越多。
 *  - 研究：最難的第 4 階科技 Lv15 約 30 天
 *  - 設施：Lv15 約 7 天；防禦建築：Lv15 約 1.6 天
 * 費用：Lv10 以前維持原本的成長速度，Lv11 以後每級只再增加 10%（避免超過倉庫上限）。
 */
export const MAX_LEVEL = 15;

/** 前 6 級每級倍率 early，之後每級倍率 late；回傳相對於 Lv1 的倍數 */
export const timeCurve = (lv, early, late) => {
  const l = Math.max(1, lv);
  return l <= 6 ? early ** (l - 1) : early ** 5 * late ** (l - 6);
};

/** 費用倍數：Lv10 以前 g^(lv-1)，之後每級 ×after */
export const costCurve = (lv, g, after = 1.1) => {
  const l = Math.max(1, lv);
  return l <= 10 ? g ** (l - 1) : g ** 9 * after ** (l - 10);
};
