import { CLASSES } from '../config/survivors.js';
import { GAME_TITLE } from '../config/constants.js';
import { SaveManager } from '../core/SaveManager.js';
import { COPYRIGHT } from '../config/legal.js';
import { APP_VERSION, CHANGELOG } from '../config/version.js';
import { versionHtml } from './ChangelogView.js';

const PRESETS = [
  { name: '台北 101', lat: 25.0339, lon: 121.5645 },
  { name: '台中車站', lat: 24.1372, lon: 120.6869 },
  { name: '高雄駁二', lat: 22.6197, lon: 120.2817 },
  { name: '東京 新宿', lat: 35.6896, lon: 139.7006 },
  { name: '紐約 時代廣場', lat: 40.758, lon: -73.9855 },
  { name: '倫敦 西敏', lat: 51.4995, lon: -0.1248 },
];

/**
 * 首次進入畫面：輸入名字、選擇領袖職業、決定起始座標（定位或手動）。
 */
export class SetupScreen {
  /**
   * @param {HTMLElement} root
   * @param {import('../cloud/CloudSync.js').CloudSync} cloud
   */
  constructor(root, cloud = null) {
    this.root = root;
    this.cloud = cloud;
  }

  /** @returns {Promise<{type:'new', playerName, classId, lat, lon}|{type:'import', data}>} */
  show() {
    return new Promise((resolve) => {
      this.root.innerHTML = this.template();
      this.root.classList.add('show');
      const $ = (s) => this.root.querySelector(s);
      const status = $('#setup-status');
      let classId = 'warrior';

      this.root.querySelectorAll('.class-opt').forEach((el) => {
        el.addEventListener('click', () => {
          this.root.querySelectorAll('.class-opt').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          classId = el.dataset.class;
        });
      });

      $('#btn-geo').addEventListener('click', () => {
        if (!navigator.geolocation) {
          status.textContent = '此瀏覽器不支援定位，請手動輸入座標。';
          return;
        }
        status.textContent = '📡 定位中…';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            $('#in-lat').value = pos.coords.latitude.toFixed(6);
            $('#in-lon').value = pos.coords.longitude.toFixed(6);
            status.textContent = `✅ 已取得位置（精度 ${Math.round(pos.coords.accuracy)} 公尺）`;
          },
          (err) => { status.textContent = `❌ 定位失敗：${err.message}。請手動輸入或選擇預設城市。`; },
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
        );
      });

      this.root.querySelectorAll('[data-preset]').forEach((el) => {
        el.addEventListener('click', () => {
          const p = PRESETS[+el.dataset.preset];
          $('#in-lat').value = p.lat;
          $('#in-lon').value = p.lon;
          status.textContent = `已選擇 ${p.name}`;
        });
      });

      $('#btn-import').addEventListener('click', () => {
        const str = prompt('貼上匯出的存檔字串：');
        if (!str) return;
        try {
          const data = SaveManager.importString(str);
          this.hide();
          resolve({ type: 'import', data });
        } catch (err) {
          status.textContent = `❌ 匯入失敗：${err.message}`;
        }
      });

      $('#btn-cloud')?.addEventListener('click', async () => {
        const code = prompt('輸入其他裝置上顯示的同步碼（XXXX-XXXX-…）：');
        if (!code) return;
        status.textContent = '☁️ 讀取雲端存檔中…';
        try {
          const { state, meta } = await this.cloud.link(code);
          SaveManager.save(state);
          this.hide();
          resolve({ type: 'import', data: state, meta });
        } catch (err) {
          status.textContent = `❌ ${err.message}`;
        }
      });

      $('#setup-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = $('#in-name').value.trim() || '倖存者';
        const lat = parseFloat($('#in-lat').value);
        const lon = parseFloat($('#in-lon').value);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
          status.textContent = '❌ 請提供有效的座標（可使用定位或預設城市）';
          return;
        }
        this.hide();
        resolve({ type: 'new', playerName: name.slice(0, 16), classId, lat, lon });
      });
    });
  }

  hide() {
    this.root.classList.remove('show');
    this.root.innerHTML = '';
  }

  template() {
    const classes = Object.entries(CLASSES)
      .map(([id, c], i) => `
        <button type="button" class="class-opt ${i === 0 ? 'active' : ''}" data-class="${id}" style="--cc:${c.color}">
          <span>${c.icon}</span><b>${c.name}</b><small>${c.skills[0].name}：${c.skills[0].desc}</small>
        </button>`)
      .join('');
    const presets = PRESETS.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${p.name}</button>`).join('');
    return `
    <div class="setup-card">
      <h1 class="logo">${GAME_TITLE}<small>ZOMBIE OUTBREAK · IDLE SURVIVAL</small></h1>
      <div class="home-version"><span class="ver-tag">v${APP_VERSION}</span></div>
      <p class="lore">病毒在一夜之間席捲全球。城市淪陷、通訊中斷……<br>你是少數的倖存者之一。在真實世界的街道上建立避難所，活下去。</p>
      <div class="home-news">${CHANGELOG[0] ? versionHtml(CHANGELOG[0], { open: false, label: '🆕 最新更新' }) : ''}</div>
      <form id="setup-form">
        <label>倖存者名稱<input id="in-name" maxlength="16" placeholder="輸入你的名字" autocomplete="off"></label>
        <div class="label">選擇你的職業</div>
        <div class="class-grid">${classes}</div>
        <div class="label">起始位置（真實地圖）</div>
        <button type="button" id="btn-geo" class="btn btn-primary wide">📍 使用目前位置</button>
        <div class="coord-row">
          <label>緯度<input id="in-lat" inputmode="decimal" placeholder="25.0339"></label>
          <label>經度<input id="in-lon" inputmode="decimal" placeholder="121.5645"></label>
        </div>
        <div class="chips">${presets}</div>
        <p id="setup-status" class="status"></p>
        <button type="submit" class="btn btn-danger wide big">☣️ 開始求生</button>
        ${this.cloud?.available ? '<button type="button" id="btn-cloud" class="btn btn-primary wide">☁️ 用同步碼讀取雲端存檔</button>' : ''}
        <button type="button" id="btn-import" class="btn btn-ghost wide">📥 匯入存檔</button>
      </form>
      <p class="copyright">${COPYRIGHT}・v${APP_VERSION}</p>
    </div>`;
  }
}
