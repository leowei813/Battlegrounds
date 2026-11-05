/**
 * v10 地點探索佔用規則（所有玩家共用）。
 *  - 每個地點一筆共用紀錄（kind 'poi'）：誰正在探索（抵達與離開時間）、搜過一部分時剩下的物資與檢核點、搜空的時間。
 *  - 同一時間只有一支隊伍在探索；依「抵達時間」決定先後（不是誰先按出發），離線也照抵達時間計算。
 *  - 晚到的隊伍會自動前往佇列的下一個地點（沒有就回家）。
 *  - 探索到一半離開：下一位從剩下的檢核點繼續，只拿得到剩下的物資。
 *  - 全部搜完或物資被拿光：已搜空，90 分鐘後恢復（物資重新產生）。
 * NPC 的探索只影響自己的地圖（NPC 隊伍由各玩家各自模擬）。
 */
export const POI_SHARE = {
  /** 搜空後多久恢復 */
  recoverMs: 90 * 60000,
  /** 同步範圍（公里） */
  km: 3,
  /** 佔用紀錄離開後保留多久（避免時間誤差） */
  graceMs: 60000,
};

export class PoiShareSystem {
  constructor(game) {
    this.game = game;
    /** 還沒成功寫入伺服器的更新（例如剛建立據點、還沒同步身分前）：每次同步後重送 */
    this.pending = [];
    game.shared?.watch('poi', POI_SHARE.km);
    game.bus?.on?.('shared:changed', () => this.flush());
  }

  /** 重送之前失敗的寫入 */
  flush() {
    if (!this.pending.length || this.flushing) return;
    const list = this.pending.splice(0);
    this.flushing = true;
    Promise.all(list.map(({ poi, fn }) => this.write(poi, fn, { retry: false }).then((r) => {
      if (!r?.ok && Date.now() - (fn.at || 0) < 6 * 3600000) this.pending.push({ poi, fn });
    }))).finally(() => { this.flushing = false; });
  }

  /** 自己的玩家編號（佔用紀錄用） */
  me() {
    try { return this.game.shared.store().me; } catch { return 'local'; }
  }

  rec(poiId) {
    return this.game.shared?.get('poi', poiId) || null;
  }

  /** 紀錄在 at 時的世代與是否搜空（搜空 90 分鐘後恢復成新的一輪） */
  static genOf(d, at) {
    const g = d?.g || 0;
    if (d?.e && at >= d.e + POI_SHARE.recoverMs) return { gen: g + 1, emptyAt: 0 };
    return { gen: g, emptyAt: d?.e || 0 };
  }

  /**
   * 地點在 at 時的狀態。
   * @returns {{gen:number, empty:boolean, until:number, by:string|null, left:{res:object, done:number, total:number}|null, occ:{p?:string, n:string, a:number, l:number, npc?:boolean, x?:string}[]}}
   */
  view(poi, at = Date.now()) {
    if (!poi) return { gen: 0, empty: false, until: 0, by: null, left: null, occ: [] };
    const d = this.rec(poi.id);
    const { gen, emptyAt } = PoiShareSystem.genOf(d, at);
    let empty = !!emptyAt && at >= emptyAt;
    let until = empty ? emptyAt + POI_SHARE.recoverMs : 0;
    let by = empty ? d?.by || null : null;
    // NPC 搜過（只在自己的地圖）：lootedDay 存的是搜空時間
    const nb = poi.lootedBy;
    if (nb?.kind === 'npc' && poi.lootedDay > 1e11 && at >= poi.lootedDay && at < poi.lootedDay + POI_SHARE.recoverMs) {
      empty = true;
      until = Math.max(until, poi.lootedDay + POI_SHARE.recoverMs);
      by = by || `NPC「${nb.name}」`;
    }
    const left = !empty && d?.r && d.r.g === gen && Object.keys(d.r.res || {}).length ? d.r : null;
    const occ = (d?.o || []).filter((x) => x && x.l + POI_SHARE.graceMs > at);
    // NPC 正在探索這個地點
    (this.game.npcs?.list || []).forEach((n) => {
      const t = n.trip;
      if (t?.kind !== 'explore' || t.poiId !== poi.id) return;
      const a = t.startAt + t.travelMs;
      occ.push({ npc: true, n: `NPC「${n.name}」`, a, l: a + t.searchMs });
    });
    return { gen, empty, until, by, left, occ };
  }

  /**
   * 抵達時是否被別人搶先：抵達時間比自己早（同時抵達時先登記的優先）且還沒離開的隊伍。
   * @returns {{who:string, l:number, reason:'busy'}|{reason:'empty', by:string|null, until:number}|null}
   */
  blockerAt(poi, arriveAt, expId = null) {
    const v = this.view(poi, arriveAt);
    if (v.empty) return { reason: 'empty', by: v.by, until: v.until };
    const me = this.me();
    const mine = v.occ.find((x) => x.x && x.x === expId);
    const first = v.occ
      .filter((x) => !(x.x && x.x === expId) && !(x.p === me && x.x === expId))
      .filter((x) => x.a < arriveAt || (x.a === arriveAt && mine && (x.t || 0) < (mine.t || 0)))
      .find((x) => x.l > arriveAt);
    return first ? { reason: 'busy', who: first.n, l: first.l, npc: !!first.npc } : null;
  }

  /** 寫入共用紀錄；失敗時（連線、身分還沒同步）放進待重送清單，下次同步後再送 */
  write(poi, fn, { retry = true } = {}) {
    const sh = this.game.shared;
    if (!sh || !poi) return Promise.resolve({ ok: false });
    if (!fn.at) fn.at = Date.now();
    return sh.update('poi', poi.id, (cur) => {
      const d = cur && typeof cur === 'object' ? cur : {};
      const now = Date.now();
      d.o = (d.o || []).filter((x) => x && x.l + POI_SHARE.graceMs > now - 6 * 3600000);
      fn(d);
      return { data: d };
    }, { lat: poi.lat, lon: poi.lon }).catch(() => ({ ok: false })).then((r) => {
      if (!r?.ok && retry && this.pending.length < 100) this.pending.push({ poi, fn });
      return r;
    });
  }

  /** 出發時登記：預計抵達與離開的時間 */
  claim(exp, poi) {
    if (!exp || exp.kind !== 'explore' || !poi) return Promise.resolve({ ok: false });
    const a = exp.startAt + (exp.travelMs || 0);
    const entry = { p: this.me(), n: this.game.state.player.name || '倖存者', a, l: a + (exp.searchMs || 0), x: exp.id, t: Date.now() };
    exp.claimed = true;
    // 本機先反映（伺服器確認前，自己的地圖也看得到）
    this.patchCache(poi, (d) => { d.o = [...(d.o || []).filter((x) => x.x !== exp.id), entry]; });
    return this.write(poi, (d) => { d.o = [...(d.o || []).filter((x) => x.x !== exp.id), entry]; });
  }

  /**
   * 離開地點：移除自己的佔用紀錄，並記下結果。
   * @param {{at:number, complete?:boolean, rest?:object, done?:number, total?:number, gen?:number}|null} result 沒有搜索（被搶先、撤退）時為 null
   */
  release(exp, poi, result = null) {
    if (!exp || !poi || (!exp.claimed && !result)) return Promise.resolve({ ok: false });
    exp.claimed = false;
    const name = this.game.state.player.name || '倖存者';
    const apply = (d) => {
      d.o = (d.o || []).filter((x) => x.x !== exp.id);
      if (!result) return;
      const { gen, emptyAt } = PoiShareSystem.genOf(d, result.at);
      // 已經搜空（別人先搜完）就不再覆蓋
      if (emptyAt && result.at >= emptyAt) return;
      d.g = gen;
      d.e = 0;
      const rest = Object.fromEntries(Object.entries(result.rest || {}).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.floor(v)]));
      if (result.complete && !Object.keys(rest).length) {
        d.e = result.at;
        d.by = `玩家「${name}」`;
        d.r = null;
      } else {
        d.r = { g: gen, res: rest, done: result.done || 0, total: result.total || 1 };
        if (!Object.keys(rest).length) { d.e = result.at; d.by = `玩家「${name}」`; d.r = null; }
      }
    };
    this.patchCache(poi, apply);
    return this.write(poi, apply);
  }

  /** NPC 搜過（只在自己的地圖）：恢復時間內不能探索 */
  markNpc(poi, at, name) {
    poi.lootedDay = at;
    poi.lootedBy = { kind: 'npc', name, day: at };
  }

  /** 先更新本機快取，讓自己的畫面立即反映 */
  patchCache(poi, fn) {
    const sh = this.game.shared;
    if (!sh?.cache) return;
    const k = sh.key('poi', poi.id);
    const cur = sh.cache.get(k);
    const data = cur?.data ? JSON.parse(JSON.stringify(cur.data)) : {};
    fn(data);
    sh.cache.set(k, { ...(cur || { kind: 'poi', id: poi.id, ver: 0, lat: poi.lat, lon: poi.lon }), data });
  }

  /** 地圖重畫用：共用紀錄的簡短簽章 */
  signature(at = Date.now()) {
    const list = this.game.shared?.all?.('poi') || [];
    return `${list.length}:${list.reduce((s, o) => s + (o.ver || 0) + ((o.data?.o || []).length), 0)}:${Math.floor(at / 60000)}`;
  }
}
