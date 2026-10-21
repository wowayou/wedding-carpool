// ---------- 地图上的「找站过程」图层 ----------
// 圈、路线、候选站生成 scene 的一部分（map-scene.js 的 sugParts），交给 map.js 和方案、预览一起发给地图页面。

import { sugOpen } from './drawer.js';
import { on } from './events.js';
import { requestFit, setSugLayer, view } from './map.js';
import { sugFitPoints, sugParts } from './map-scene.js';
import { sgSettingsKey, sug } from './state.js';
import { $ } from './util.js';

// 启动时调用：抽屉开关时跟着显示或隐藏
export function initSugLayer() {
  layerShown = false;
  on('drawer', ({ open, keepSug }) => {
    sug.peek = open ? false : keepSug; // 手机上点「去地图上看」：抽屉收起来，但地图上的找站过程留着
    syncSugLayer();
  });
}
export function sugStations() {
  return sug.result && sug.resultKey === sgSettingsKey() ? [...sug.result.stations.map((s) => ({ ...s, listed: true })), ...sug.result.more] : [];
}
// 重画找站图层（内容变了）。图例里找站的两行跟着：有图层才有
export function drawSugLayer() {
  if (!view.frame || !layerShown) return;
  setSugLayer(sugParts(sug.trace, sugStations()));
}
// 抽屉遮住的那一截通过留白传给地图页面
export function fitSugLayer() {
  const pts = sugFitPoints(sug.trace, sugStations());
  if (!pts || !view.frame) return false;
  const mapBox = $('#map').getBoundingClientRect(), drawer = $('#drawer').getBoundingClientRect();
  const covered = sugOpen() ? Math.max(0, mapBox.right - drawer.left) : 0; // 抽屉盖住的那一截不算
  requestFit({ points: pts, padding: { top: 16, right: covered + 16, bottom: 16, left: 16 }, maxZoom: 12 });
  return true;
}
// 图层该不该显示：抽屉开在「推荐车站」上（或者在手机上点了「去地图上看」），而且开关是开的
let layerShown = false;
export function syncSugLayer(redraw = false) {
  if (!view.frame) return;
  const show = sug.layerOn && (sugOpen() || sug.peek);
  if (!show) { if (layerShown) { layerShown = false; setSugLayer(null); } return; }
  const wasShown = layerShown;
  layerShown = true;
  if (redraw || !wasShown) setSugLayer(sugParts(sug.trace, sugStations()));
  if (!sug.fitted && sug.trace && fitSugLayer()) sug.fitted = true;
}
// 重新计算方案时清掉，免得和方案的路线混在一起
export function clearSugLayer() {
  layerShown = false;
  if (view.frame) setSugLayer(null);
  sug.peek = false;
}
