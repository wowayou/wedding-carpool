// ---------- 配置路径 ----------

import { state } from './state.js';

export function getPath(path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state.cfg); }
export function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => (o[k] ??= {}), state.cfg);
  if (value === '' || value === undefined || Number.isNaN(value)) delete obj[last];
  else obj[last] = value;
}

// 表单元素对应的配置路径，用来标出「谁在编辑哪一格」
export function pathOf(el) {
  if (!el || !el.dataset) return null;
  if (el.dataset.bind) return el.dataset.bind;
  if (el.dataset.stationName !== undefined) return `stations.${el.dataset.stationName}.name`;
  if (el.dataset.rail !== undefined) return `people.${el.dataset.rail}.rail_min.${el.dataset.station}`;
  if (el.dataset.train !== undefined) return `people.${el.dataset.train}.trains.${el.dataset.station}`;
  if (el.dataset.backtrain !== undefined) return `people.${el.dataset.backtrain}.return_trains.${el.dataset.station}`;
  return null;
}
export function elementOf(path) {
  const byBind = document.querySelector(`#form [data-bind="${CSS.escape(path)}"]`);
  if (byBind) return byBind;
  const k = path.split('.');
  if (k[0] === 'stations' && k[2] === 'name') return document.querySelector(`#form [data-station-name="${k[1]}"]`);
  if (k[0] === 'people' && ['rail_min', 'trains', 'return_trains'].includes(k[2])) {
    const attr = { rail_min: 'rail', trains: 'train', return_trains: 'backtrain' }[k[2]];
    return document.querySelector(`#form [data-${attr}="${k[1]}"][data-station="${CSS.escape(k.slice(3).join('.'))}"]`);
  }
  return null;
}

