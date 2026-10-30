import { MapService } from '../../map/MapService.js';
import { POI_TYPES } from '../../config/poiTypes.js';
import { ALL_ENEMIES } from '../../config/enemies.js';
import { RESOURCES } from '../../config/constants.js';
import { delegateActions } from '../../utils/dom.js';
import { haversine } from '../../utils/math.js';
import { btn } from '../components.js';
import { openTeamPicker } from '../TeamPicker.js';
import { showBattle } from '../BattleView.js';

const stars = (n) => '☠'.repeat(Math.min(7, n));

/**
 * 地圖分頁：Leaflet 地圖 + 浮動控制列，以及 POI / 殭屍群互動彈窗。
 */
export class MapPanel {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.lastRender = 0;
    this.scanning = false;
  }

  init() {
    const root = this.ui.mapRoot;
    root.innerHTML = '<div id="map-canvas"></div><div id="map-overlay" class="map-overlay"></div>';
    this.overlay = root.querySelector('#map-overlay');
    this.service = new MapService(root.querySelector('#map-canvas'));
    const sh = this.game.state.shelter;
    const c = sh.lat != null ? sh : this.game.state.map.center;
    this.service.init(c.lat, c.lon);
    delegateActions(this.overlay, (action) => this.onAction(action));
  }

  onShow() {
    this.service.invalidate();
    this.renderMap(true);
  }

  renderMap(force = false) {
    if (this.ui.tab !== 'map' && !force) return;
    this.lastRender = Date.now();
    this.service.render(this.game.state);
  }

  renderOverlay() {
    if (Date.now() - this.lastRender > 5000) this.renderMap(true);
    const st = this.game.state;
    const has = this.game.shelter.hasShelter();
    const src = { overpass: 'OpenStreetMap', generated: '程序生成（OSM 無法連線）', none: '—' }[st.map.source] || st.map.source;
    const html = `
      ${has ? '' : '<div class="map-hint">👆 點選地圖上任一建築，將它設為你的<b>避難所</b></div>'}
      <div class="map-tools">
        ${btn('🏰', 'gotoShelter', {}, { cls: 'btn-icon', disabled: !has, title: '回到避難所' })}
        ${btn(this.scanning ? '⏳' : '🔄', 'rescan', {}, { cls: 'btn-icon', disabled: this.scanning, title: '重新掃描附近建築' })}
        ${btn('🧾', 'legend', {}, { cls: 'btn-icon', title: '圖例' })}
      </div>
      <div class="map-info">建築 ${st.map.pois.length}・殭屍群 ${st.map.zombieGroups.length}・資料：${src}</div>`;
    if (html !== this.lastOverlay) {
      this.lastOverlay = html;
      this.overlay.innerHTML = html;
    }
  }

  async onAction(action) {
    const sh = this.game.state.shelter;
    if (action === 'gotoShelter' && sh.lat != null) this.service.focus(sh.lat, sh.lon);
    if (action === 'legend') this.showLegend();
    if (action === 'rescan') {
      if (this.scanning) return;
      this.scanning = true;
      this.renderOverlay();
      const c = sh.lat != null ? sh : this.game.state.map.center;
      this.ui.toastEl.show('📡 掃描附近建築中…', 'info');
      const r = await this.game.scanMap(c.lat, c.lon);
      this.scanning = false;
      this.ui.toastEl.show(`發現 ${r.count} 個地點（${r.source === 'overpass' ? 'OSM' : '程序生成'}）`, 'success');
      this.renderMap(true);
    }
  }

  showLegend() {
    const rows = Object.values(POI_TYPES).map((p) => `<div class="legend-row"><span class="poi-pin" style="--c:${p.color}">${p.icon}</span> ${p.name} <span class="danger">${stars(p.danger)}</span><small>${Object.keys(p.loot).map((k) => RESOURCES[k].icon).join('')}</small></div>`).join('');
    this.ui.modal.open({ title: '🧾 圖例', body: `${rows}<p class="muted">☠ 越多越危險；距離避難所越遠危險度越高。紅框為探索範圍。</p>` });
  }

  poiBody(poi) {
    const g = this.game;
    const pt = POI_TYPES[poi.type];
    const sh = g.state.shelter;
    const isShelter = poi.id === sh.poiId;
    const dist = sh.lat != null ? Math.round(haversine(sh.lat, sh.lon, poi.lat, poi.lon)) : null;
    const danger = g.zombies.areaDanger(poi);
    const groups = g.state.map.zombieGroups.filter((z) => z.poiId === poi.id);
    const exploring = g.state.expeditions.filter((e) => e.poiId === poi.id).length;
    const actions = [];
    if (!g.shelter.hasShelter()) actions.push(btn('🏠 設為避難所', 'setShelter', {}, { cls: 'btn-primary' }));
    else if (isShelter) actions.push(btn('🏠 進入避難所', 'enterShelter', {}, { cls: 'btn-primary' }));
    else {
      actions.push(btn('🧭 派遣探索', 'explore', {}, { cls: 'btn-primary' }));
      actions.push(btn('🏚️ 搬遷至此（💰200 ⛽50）', 'setShelter', {}, { cls: 'btn-ghost' }));
    }
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:${pt.color}">${pt.icon}</div>
        <div>
          <b>${pt.name}</b>${poi.osm ? ' <small class="tag">OSM</small>' : ' <small class="tag">傳聞</small>'}
          <div>危險度 <span class="danger">${stars(danger)}</span> ${pt.special ? '<span class="tag tag-red">高級怪物</span>' : ''}</div>
          ${dist != null ? `<div class="muted">距避難所 ${dist} 公尺</div>` : ''}
          <div class="muted">可能物資：${Object.keys(pt.loot).map((k) => `${RESOURCES[k].icon}${RESOURCES[k].name}`).join(' ')}</div>
          <div class="muted">物資殘量：${Math.round((1 - (poi.depletion || 0)) * 100)}%・裝備掉率 ${Math.round(pt.itemChance * 100)}%</div>
          ${exploring ? `<div class="tag tag-blue">${exploring} 支隊伍探索中</div>` : ''}
        </div>
      </div>
      ${groups.length ? `<div class="label">附近殭屍</div>${groups.map((z) => `<div class="row-between"><span>${ALL_ENEMIES[z.enemyId].icon} ${g.zombies.groupLabel(z)}</span>${btn('⚔️ 攻擊', 'attack', { id: z.id }, { cls: 'btn-danger btn-sm', disabled: !g.shelter.hasShelter() })}</div>`).join('')}` : ''}
      <div class="btn-row">${actions.join('')}</div>`;
  }

  openPoi(poiId) {
    const poi = this.game.state.map.pois.find((p) => p.id === poiId);
    if (!poi) return;
    this.ui.modal.open({
      title: `${POI_TYPES[poi.type].icon} ${poi.name}`,
      body: this.poiBody(poi),
      live: () => this.poiBody(poi),
      onAction: (action, data, m) => {
        if (action === 'setShelter') {
          const r = this.ui.result(this.game.shelter.setShelter(poi));
          if (r.ok) {
            m.close();
            this.renderMap(true);
            this.game.zombies.refresh();
            this.ui.switchTab('shelter');
          }
        } else if (action === 'enterShelter') {
          m.close();
          this.ui.switchTab('shelter');
        } else if (action === 'explore') {
          this.openExplore(poi);
        } else if (action === 'attack') {
          this.attackGroup(data.id);
        }
      },
    });
  }

  openExplore(poi) {
    const g = this.game;
    openTeamPicker(this.ui, {
      title: `🧭 探索：${poi.name}`,
      intro: `<p class="muted">${POI_TYPES[poi.type].name}・危險度 ${stars(g.zombies.areaDanger(poi))}・敵人等級約 Lv${g.zombies.areaLevel(poi)}</p>`,
      withDuration: true,
      estimate: (ids, dur) => g.exploration.actualDurationMs(poi, ids.map((id) => g.survivors.get(id)), dur),
      confirmLabel: '出發！',
      onConfirm: (ids, dur, auto) => {
        const r = this.ui.result(g.exploration.start(poi.id, ids, dur, auto));
        if (r.ok) this.renderMap(true);
        return r;
      },
    });
  }

  zombieBody(gr) {
    const e = ALL_ENEMIES[gr.enemyId];
    const sample = this.game.combat.createEnemy(gr.enemyId, gr.level, gr.elite);
    return `
      <div class="poi-detail">
        <div class="poi-big" style="--c:#b71c1c">${e.icon}</div>
        <div>
          <b>${this.game.zombies.groupLabel(gr)}</b> ${gr.boss ? '<span class="tag tag-red">BOSS</span>' : ''}
          <div class="muted">單體：生命 ${sample.maxHp}・攻擊 ${sample.atk}・防禦 ${sample.def}</div>
          <div class="muted">擊殺可得經驗、金錢、材料，並有機率掉落裝備</div>
        </div>
      </div>
      <div class="btn-row">${btn('⚔️ 派隊攻擊', 'attack', { id: gr.id }, { cls: 'btn-danger', disabled: !this.game.shelter.hasShelter() })}</div>`;
  }

  openZombie(groupId) {
    const gr = this.game.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    this.ui.modal.open({
      title: `${ALL_ENEMIES[gr.enemyId].icon} 殭屍群`,
      body: this.zombieBody(gr),
      onAction: (action, data) => { if (action === 'attack') this.attackGroup(data.id); },
    });
  }

  attackGroup(groupId) {
    const g = this.game;
    const gr = g.state.map.zombieGroups.find((z) => z.id === groupId);
    if (!gr) return;
    openTeamPicker(this.ui, {
      title: `⚔️ 攻擊 ${g.zombies.groupLabel(gr)}`,
      intro: '<p class="muted">戰鬥為自動進行。倒下的隊員會受傷，需要休養或使用藥品治療。</p>',
      confirmLabel: '開戰！',
      onConfirm: (ids) => {
        const r = g.zombies.attack(groupId, ids);
        if (!r.ok) return this.ui.result(r);
        g.changed();
        this.renderMap(true);
        setTimeout(() => showBattle(this.ui, r.result, r.loot, `⚔️ ${g.zombies.groupLabel(r.group)}`), 0);
        return { ok: true };
      },
    });
  }
}
