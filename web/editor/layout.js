// ---------- 手机上的底部分页签：填写 / 地图 / 方案（宽度 960 以上三块同时显示，分页签隐藏） ----------
// 窄屏（手机）：三块区域用底部分页签切换。matchMedia 在用到时才取，导入模块时不碰 window

import { declutter, drawPreview, view } from './map.js';
import { state } from './state.js';
import { $ } from './util.js';

export const narrow = () => window.matchMedia('(max-width: 959px)');
export function setPane(name) {
  $('#app').dataset.tab = name;
  document.querySelectorAll('.ed-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === name)));
  if (name === 'map') setTimeout(() => { if (view.map) { view.map.invalidateSize(); if (!state.fitted) drawPreview(); declutter(); } }, 60);
}

