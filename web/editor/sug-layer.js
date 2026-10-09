// ---------- 地图上的「找站过程」图层 ----------

import { sugOpen } from './drawer.js';
import { on } from './events.js';
import { view } from './map.js';
import { sgSettingsKey, sug } from './state.js';
import { $, esc, parseLoc, themeVar } from './util.js';

let sugLayer = null;
// 启动时调用：地图建好以后建「找站过程」的图层，抽屉开关时跟着显示或隐藏
export function initSugLayer() {
  on('map', (map) => {
    map.createPane('sugPane').style.zIndex = 350; // 找站过程的圈和路线放在方案路线、站点标记下面
    sugLayer = L.layerGroup();
  });
  on('drawer', ({ open, keepSug }) => {
    sug.peek = open ? false : keepSug; // 手机上点「去地图上看」：抽屉收起来，但地图上的找站过程留着
    syncSugLayer();
  });
}
// 把圈和路线圈出的范围换成经纬度范围（不依赖地图，隐藏的地图也能算）
export function sugBounds(trace, stations) {
  const pts = [];
  for (const c of trace?.circles || []) {
    const dLat = c.radius_km / 111.2, dLng = c.radius_km / (111.2 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
    pts.push([c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]);
  }
  for (const r of trace?.routes || []) pts.push(...r.path);
  for (const s of stations || []) { const ll = parseLoc(s.location); if (ll) pts.push(ll); }
  return pts.length ? L.latLngBounds(pts) : null;
}
export function sugStations() {
  return sug.result && sug.resultKey === sgSettingsKey() ? [...sug.result.stations.map((s) => ({ ...s, listed: true })), ...sug.result.more] : [];
}
export function drawSugLayer() {
  if (!view.map || !sugLayer) return;
  sugLayer.clearLayers();
  const trace = sug.trace;
  if (!trace) return;
  const station = themeVar('--station'), drive = themeVar('--drive'), surface = themeVar('--surface');
  for (const c of trace.circles) {
    L.circle([c.lat, c.lng], { pane: 'sugPane', radius: c.radius_km * 1000, color: station, weight: 1, opacity: c.searched === false ? 0.35 : 0.6,
      fillColor: station, fillOpacity: c.searched === false ? 0.02 : 0.06, dashArray: c.searched === false ? '4 4' : null, interactive: false }).addTo(sugLayer);
  }
  for (const r of trace.routes) {
    L.polyline(r.path, { pane: 'sugPane', color: drive, weight: 3, opacity: r.alt > 1 ? 0.45 : 0.9, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(sugLayer);
  }
  for (const s of sugStations()) {
    const ll = parseLoc(s.location);
    if (!ll) continue;
    L.circleMarker(ll, { radius: s.listed ? 6 : 4, color: surface, weight: 2, fillColor: station, fillOpacity: s.listed && !s.over_all ? 1 : 0.55 })
      .bindTooltip(esc(s.name), { direction: 'top', offset: [0, -6], className: 'lbl' }).addTo(sugLayer);
  }
}
export function fitSugLayer() {
  const b = sugBounds(sug.trace, sugStations());
  if (!b || !view.map || view.map.getSize().x < 50) return false;
  const mapBox = $('#map').getBoundingClientRect(), drawer = $('#drawer').getBoundingClientRect();
  const covered = sugOpen() ? Math.max(0, mapBox.right - drawer.left) : 0; // 抽屉盖住的那一截不算
  view.map.fitBounds(b, { paddingTopLeft: [16, 16], paddingBottomRight: [covered + 16, 16], maxZoom: 12 });
  return true;
}
// 图层该不该显示：抽屉开在「推荐车站」上（或者在手机上点了「去地图上看」），而且开关是开的
export function syncSugLayer(redraw = false) {
  if (!view.map || !sugLayer) return;
  const show = sug.layerOn && (sugOpen() || sug.peek);
  const legend = document.querySelector('.legend-sug');
  if (legend) legend.hidden = !(show && sug.trace);
  if (!show) { view.map.removeLayer(sugLayer); return; }
  if (redraw || !view.map.hasLayer(sugLayer)) drawSugLayer();
  if (!view.map.hasLayer(sugLayer)) sugLayer.addTo(view.map);
  if (!sug.fitted && sug.trace && fitSugLayer()) sug.fitted = true;
}
// 重新计算方案时清掉，免得和方案的路线混在一起
export function clearSugLayer() {
  if (sugLayer) sugLayer.clearLayers();
  if (view.map && sugLayer) view.map.removeLayer(sugLayer);
  sug.peek = false;
}

