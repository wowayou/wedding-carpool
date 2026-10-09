// ---------- 方案过期提示：配置改过以后，提示方案可能不对了 ----------

import { showLayers } from './map.js';
import { isStale, state } from './state.js';
import { $ } from './util.js';

export function updateStale() {
  $('#stale').hidden = !isStale();
  showLayers();
  updatePlanDot();
}
// 底部「方案」页签上的提示：有方案时显示方案数，方案过期了显示感叹号
export function updatePlanDot() {
  const dot = $('#planDot');
  dot.hidden = !state.result;
  if (state.result) dot.textContent = isStale() ? '!' : String(state.result.plans.length + (state.result.back ? state.result.back.plans.length : 0));
}

