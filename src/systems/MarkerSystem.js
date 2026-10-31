/** 標記地點上限 */
export const MAX_MARKERS = 5;

/**
 * 標記地點：GPS 只能偵測身邊 50 公尺的建築，走遠後就看不到了。
 * 把建築標記起來（最多 5 個），重新掃描或移動到別處後仍會保留在地圖上，方便日後在那裡建立避難所。
 */
export class MarkerSystem {
  constructor(game) {
    this.game = game;
  }

  get list() {
    const map = this.game.state.map;
    if (!map.markers) map.markers = [];
    return map.markers;
  }

  isMarked(poiId) {
    return this.list.some((m) => m.id === poiId);
  }

  mark(poi) {
    if (!poi) return { ok: false, reason: '找不到建築' };
    if (this.isMarked(poi.id)) return { ok: false, reason: '已經標記過了' };
    if (this.list.length >= MAX_MARKERS) return { ok: false, reason: `最多只能標記 ${MAX_MARKERS} 個地點，請先移除舊的標記` };
    const {
      id, type, name, lat, lon, osm,
    } = poi;
    this.list.push({
      id, type, name, lat, lon, osm: !!osm, at: Date.now(),
    });
    this.game.bus.emit('map:changed');
    return { ok: true, msg: `📌 已標記「${name}」（${this.list.length}/${MAX_MARKERS}）` };
  }

  unmark(poiId) {
    const m = this.list.find((x) => x.id === poiId);
    if (!m) return { ok: false, reason: '沒有這個標記' };
    this.game.state.map.markers = this.list.filter((x) => x.id !== poiId);
    this.game.bus.emit('map:changed');
    return { ok: true, msg: `已移除標記「${m.name}」` };
  }

  /** 標記的建築一定留在地圖建築清單中（重新掃描後也不會消失） */
  ensure(pois = this.game.state.map.pois) {
    const ids = new Set(pois.map((p) => p.id));
    this.list.forEach((m) => {
      if (ids.has(m.id)) return;
      const { at, ...poi } = m;
      pois.push({ ...poi });
    });
    return pois;
  }
}
