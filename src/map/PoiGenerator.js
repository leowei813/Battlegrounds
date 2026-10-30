import { POI_TYPES, POI_MIN_PER_TYPE } from '../config/poiTypes.js';
import { offsetLatLon, randFloat, pick } from '../utils/math.js';

const RUIN_PREFIX = ['廢棄的', '燒毀的', '荒廢的', '被封鎖的', '倒塌的'];

/**
 * 程序化補足 POI：當 OSM 查不到某類建築（鄉村、海上、網路失敗）時，
 * 在玩家周圍生成「傳聞中」的地點，確保所有玩法都能進行。
 */
export function fillPois(pois, lat, lon) {
  const out = [...pois];
  Object.entries(POI_MIN_PER_TYPE).forEach(([type, min]) => {
    const have = out.filter((p) => p.type === type).length;
    for (let i = have; i < min; i += 1) {
      const [min, max] = type === 'military' ? [1200, 2200] : POI_TYPES[type].danger >= 4 ? [500, 1300] : [120, 1150];
      // 以面積均勻分布（距離取平方根），避免地點都擠在中心
      const dist = Math.sqrt(randFloat(min * min, max * max));
      const pos = offsetLatLon(lat, lon, dist, randFloat(0, Math.PI * 2));
      out.push({
        id: `gen_${type}_${i}_${Math.random().toString(36).slice(2, 7)}`,
        type,
        name: `${pick(RUIN_PREFIX)}${POI_TYPES[type].name} ${i + 1}號`,
        lat: pos.lat,
        lon: pos.lon,
        osm: false,
      });
    }
  });
  return out;
}
