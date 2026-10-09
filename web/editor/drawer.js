// ---------- 侧边面板：历史、更多、推荐车站共用的抽屉 ----------

import { emit } from './events.js';
import { $ } from './util.js';

// 抽屉现在开在「推荐车站」上
export const sugOpen = () => !$('#drawer').hidden && $('#drawer').dataset.panel === 'suggest';

export function openDrawer(title, html, panel = '') {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').dataset.panel = panel;
  $('#drawer').hidden = false;
  emit('drawer', { open: true }); // 只有「推荐车站」开着时才显示找站过程（sug-layer.js 订阅）
}
// keepSug：手机上点「去地图上看」，抽屉收起来，但地图上的找站过程留着
export function closeDrawer(keepSug = false) {
  $('#drawer').hidden = true;
  $('#drawer').dataset.panel = '';
  emit('drawer', { open: false, keepSug });
}
