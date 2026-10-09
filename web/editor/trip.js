// ---------- 行程与身份：标题、保留期、记住最近的行程、载入配置 ----------

import { backend } from './backend.js';
import { caps } from './caps.js';
import { toast } from './dialogs.js';
import { renderForm, rerenderKeepingFocus } from './form.js';
import { renderEmptyPlan } from './results.js';
import { updateStale } from './stale.js';
import { state, trip } from './state.js';
import { setStatus } from './sync.js';
import { fmtDate } from './time.js';
import { $, clone, store } from './util.js';

export function rememberTrip(key) {
  if (!caps.hasTrip) return;
  const list = store.get('carpool_trips', []).filter((t) => t.id !== state.tripId);
  const old = store.get('carpool_trips', []).find((t) => t.id === state.tripId);
  list.unshift({ id: state.tripId, key: key || old?.key, name: trip.name || state.cfg?.venue?.name || '', at: Date.now() });
  store.set('carpool_trips', list.slice(0, 30));
}

// 保留到哪天：只有在线模式有保留期；点标签打开「更多」，里面有规则说明
export function renderExpiry() {
  const chip = $('#expiryChip');
  chip.hidden = !(caps.hasTrip && trip.expiresAt);
  if (chip.hidden) return;
  chip.textContent = `保留到 ${fmtDate(trip.expiresAt)}`;
  chip.title = '北京时间。这个行程到期会自动删除，点开看说明';
  chip.classList.toggle('c-tag--warn', trip.expiresAt - Date.now() <= 7 * 864e5);
}

export function renderTitle() {
  const name = caps.text.title(trip);
  $('#title').textContent = name;
  document.title = `${name} · 拼车出行规划`;
}

// 试玩：恢复示例就是重新取一遍示例行程
export async function resetTry() {
  const { config } = await backend.loadConfig();
  state.cfg = config;
  state.synced = clone(state.cfg);
  state.result = state.resultHash = null;
  state.active = state.activeBack = 0;
  state.viewLeg = 'out';
  state.fitted = false;
  $('#tabs').innerHTML = '';
  $('#warn').innerHTML = '';
  renderEmptyPlan();
  updateStale();
  renderForm();
  toast('已恢复示例');
}

export async function loadConfig(keepFocus) {
  const data = await backend.loadConfig();
  state.cfg = data.config;
  state.synced = clone(state.cfg);
  state.version = data.version;
  Object.assign(trip, data.trip);
  renderTitle();
  renderExpiry();
  if (keepFocus) rerenderKeepingFocus(); else renderForm();
  setStatus();
}
