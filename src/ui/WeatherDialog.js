import { WORLD_EVENTS, WORLD_EVENT_KEYS } from '../config/worldEvents.js';

/** v15.18：今日天候的提示區塊（每日情報視窗共用） */
export function weatherBrief(w) {
  return `<div class="wx-brief wx-${w.id}"><span class="wx-ic">${w.icon}</span><div><b>今日天候：${w.name}</b><small class="muted block">${w.short}</small></div></div>`;
}

/** 點狀態列天候標籤：今天的效果＋全部天候一覽 */
export function openWeather(ui) {
  const w = ui.game.worldEvent.today();
  const list = WORLD_EVENT_KEYS.filter((k) => WORLD_EVENTS[k].weight > 0).map((k) => {
    const e = WORLD_EVENTS[k];
    return `<div class="wx-row ${k === w.id ? 'on' : ''}"><span>${e.icon} <b>${e.name}</b></span><small class="muted">${e.short}</small></div>`;
  }).join('');
  ui.modal.open({
    title: `${w.icon} 今日天候：${w.name}`,
    body: `<p>今天（00:00～24:00）全服都是 <b>${w.name}</b>：</p>
      <ul>${w.lines.map((x) => `<li>${x}</li>`).join('')}</ul>
      <p class="muted">每天 00:00 更換，所有玩家相同。地下城不受影響。</p>
      <div class="label">全部天候</div><div class="wx-list">${list}</div>
      <div class="btn-row end"><button class="btn btn-primary" data-action="close">知道了</button></div>`,
  });
}
