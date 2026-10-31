/**
 * 避難所底圖（四種規模共用同一張要塞圖）與格子配置。
 * 座標為底圖原始像素（1540×1025）。圍牆內地面的四個內角：
 *   left 左、top 上（後方）、right 右、front 前；大門在 front→right 這面牆上。
 * 地面切成 6×6 格（u：沿大門牆 front→right；v：從大門牆往內 front→left）：
 *  - 最內側兩排（遠離大門）為一般設施的綠色格，共 12 格
 *  - 靠大門的兩排為防禦設施的藍色格，依據點規模顯示 3／5／8／11 格（從大門附近開始排）
 */
export const BASE_IMAGE_SIZE = { w: 1540, h: 1025 };

const CORNERS = {
  left: [222, 322], top: [800, 140], right: [1405, 445], front: [640, 728],
};
const GRID = 6;
const PAD = 0.04; // 與圍牆保留的距離
const GAP = 0.06; // 格子之間的間隙（格寬比例）

/** 地面上 (u, v) 0～1 → 底圖像素（雙線性內插） */
export function groundPoint(u, v) {
  const {
    left: A, top: B, right: C, front: D,
  } = CORNERS;
  const f = (k) => D[k] + u * (C[k] - D[k]) + v * (A[k] - D[k]) + u * v * (B[k] - C[k] - A[k] + D[k]);
  return [f(0), f(1)];
}

/** 第 (i, j) 格的四個角與中心（i：沿大門牆，j：0 為最靠大門的一排） */
export function cellShape(i, j) {
  const span = 1 - PAD * 2;
  const u0 = PAD + (span * (i + GAP / 2)) / GRID;
  const u1 = PAD + (span * (i + 1 - GAP / 2)) / GRID;
  const v0 = PAD + (span * (j + GAP / 2)) / GRID;
  const v1 = PAD + (span * (j + 1 - GAP / 2)) / GRID;
  return {
    corners: [groundPoint(u0, v0), groundPoint(u1, v0), groundPoint(u1, v1), groundPoint(u0, v1)],
    center: groundPoint((u0 + u1) / 2, (v0 + v1) / 2),
  };
}

/** 一般設施的 12 個綠色格（最內側兩排） */
export const FACILITY_CELLS = [5, 4].flatMap((j) => [0, 1, 2, 3, 4, 5].map((i) => cellShape(i, j)));

/** 防禦設施的藍色格（靠大門兩排；大門在右側，從右往左排） */
const DEFENSE_ORDER = [0, 1].flatMap((j) => [5, 4, 3, 2, 1, 0].map((i) => cellShape(i, j)));

/** 依防禦欄位數取得藍色格 */
export const defenseCells = (n) => DEFENSE_ORDER.slice(0, n);
