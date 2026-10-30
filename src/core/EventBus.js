/**
 * 全域事件匯流排：系統層、UI 層與 Phaser 場景之間唯一的溝通管道，
 * 讓模組之間保持鬆耦合。
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler error on "${event}"`, err);
      }
    });
  }
}

export const bus = new EventBus();

/** 事件名稱常數，避免字串拼錯。 */
export const EVT = {
  STATE_CHANGED: 'state:changed',
  TICK: 'game:tick',
  TOAST: 'ui:toast',
  LOG: 'game:log',
  PHASE_CHANGED: 'time:phaseChanged',
  EXPEDITION_DONE: 'expedition:done',
  BATTLE_RESULT: 'battle:result',
  SHELTER_CHANGED: 'shelter:changed',
  MAP_CHANGED: 'map:changed',
  OPEN_SLOT: 'ui:openDefenseSlot',
  OPEN_POI: 'ui:openPoi',
  SIEGE_BREACH: 'siege:breach',
  QUEST_UPDATED: 'quest:updated',
  SAVE: 'game:save',
};
