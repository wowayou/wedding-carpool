// ---------- 地图：没算方案时实时显示已定位的地点；算出方案后画路线 ----------

import { emit } from './events.js';
import { isStale, state } from './state.js';
import { fmtMin } from './time.js';
import { $, esc, parseLoc, themeVar } from './util.js';

// 地图（Leaflet）和三个图层。地图没加载出来时 map 是 null，画图的函数都先看一眼
export const view = { map: null, planLayer: null, previewLayer: null };

export const COLORS = ['#c2410c', '#1d4ed8', '#7c3aed', '#0f766e', '#be185d', '#4d7c0f'];
// 地图标记的颜色取自设计变量（深色模式自动换成深色的值）
export const POINT_VARS = { venue: '--dest', st: '--station', car: '--drive', home: '--ride' };

export const pointColor = (kind) => themeVar(POINT_VARS[kind]);

export function showLayers() {
  if (!view.map) return;
  const plan = state.result && !isStale();
  if (plan) { view.map.removeLayer(view.previewLayer); view.planLayer.addTo(view.map); }
  else { view.map.removeLayer(view.planLayer); view.previewLayer.addTo(view.map); }
}

// 标签互相遮挡时，按优先级（目的地 > 用到的车站 > 开车的 > 不开车的 > 其他车站）只留前面的，鼠标移上去再显示
export function declutter() {
  if (!view.map) return;
  const layer = view.map.hasLayer(view.planLayer) ? view.planLayer : view.previewLayer;
  const items = [];
  layer.eachLayer((m) => {
    const tip = m.getTooltip && m.getTooltip();
    const el = tip && tip.options.permanent && tip.getElement();
    if (el) items.push([m.options.priority ?? 5, el]);
  });
  items.sort((a, b) => a[0] - b[0]);
  const placed = [];
  for (const [, el] of items) {
    el.style.visibility = '';
    const r = el.getBoundingClientRect();
    if (placed.some((p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top)) el.style.visibility = 'hidden';
    else placed.push(r);
  }
}
export function labelled(marker, priority) {
  marker.options.priority = priority;
  marker.on('mouseover', () => { const el = marker.getTooltip()?.getElement(); if (el) el.style.visibility = ''; });
  marker.on('mouseout', declutter);
  return marker;
}

let previewTimer = null;
export function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 250); }

export function drawPreview() {
  if (!view.map || !state.cfg) return;
  view.previewLayer.clearLayers();
  const pts = [];
  const priority = { venue: 0, car: 2, home: 3, st: 4 };
  const add = (loc, kind, label, r = 7) => {
    const ll = parseLoc(loc);
    if (!ll) return;
    pts.push(ll);
    labelled(L.circleMarker(ll, { radius: r, color: '#fff', weight: 2, fillColor: pointColor(kind), fillOpacity: kind === 'st' ? 0.75 : 1 })
      .bindTooltip(esc(label), { permanent: kind !== 'st', direction: 'top', offset: [0, -6], className: 'lbl' }), priority[kind]).addTo(view.previewLayer);
  };
  add(state.cfg.venue?.location, 'venue', state.cfg.venue?.name || '目的地', 10);
  (state.cfg.stations || []).forEach((s) => add(s.location, 'st', s.name || '车站', 6));
  (state.cfg.people || []).forEach((p) => add(p.location, p.car_seats !== undefined ? 'car' : 'home', `${p.name || '成员'}${p.car_seats !== undefined ? '（开车）' : ''}`));
  if (!state.fitted && pts.length) {
    view.map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 11 });
    state.fitted = true;
  }
  showLayers();
  setTimeout(declutter, 0);
}

export function drawPlan(fit) {
  if (!view.map) return;
  view.planLayer.clearLayers();
  const pts = state.result.points;
  const back = state.viewLeg === 'back' && state.result.back;
  const plan = back ? state.result.back.plans[state.activeBack] : state.result.plans[state.active];
  const seq = (r) => (back ? ['venue', ...r.stops, `car:${r.driver}`] : [`car:${r.driver}`, ...r.stops, 'venue']);
  const used = new Set();
  const stopNotes = {};
  const ll = (id) => [pts[id].lat, pts[id].lng];
  (plan?.routes || []).forEach((r) => {
    // 先画不接人时的直达路线（灰色虚线），接人的彩色路线盖在上面，分岔的那段就是绕的路
    if (!r.stops.length) return;
    L.polyline(r.direct_path || [seq({ driver: r.driver, stops: [] })].flat().map(ll), { color: themeVar('--taxi'), weight: 4, opacity: 0.8, dashArray: '6 8' })
      .bindTooltip(`${esc(r.driver)} ${back ? '不送人直接回家' : '不接人'}的直达路线`, { sticky: true }).addTo(view.planLayer);
    (stopNotes[r.stops[0]] ??= []).push(`${r.driver} 多绕 ${fmtMin(r.detour)}`);
  });
  (plan?.routes || []).forEach((r, i) => {
    r.stops.forEach((s) => used.add(s));
    const line = r.path || seq(r).map(ll);
    L.polyline(line, { color: COLORS[i % COLORS.length], weight: 5, opacity: 0.85, dashArray: r.path ? null : '8 8' })
      .bindTooltip(`${esc(r.driver)}：${r.stops.length ? '多绕 ' + fmtMin(r.detour) : '直达'}，全程约 ${fmtMin(r.minutes)}`, { sticky: true })
      .addTo(view.planLayer);
  });
  Object.entries(plan?.taxi || {}).forEach(([who, s]) => {
    used.add(s);
    L.polyline([ll(s), ll('venue')], { color: themeVar('--taxi'), weight: 3, dashArray: '4 6' }).bindTooltip(`${esc(who)} 打车`, { sticky: true }).addTo(view.planLayer);
  });
  for (const [id, p] of Object.entries(pts)) {
    const kind = id === 'venue' ? 'venue' : id.split(':')[0];
    const highlighted = kind !== 'st' || used.has(id);
    const priority = kind === 'venue' ? 0 : kind === 'st' ? (used.has(id) ? 1 : 4) : kind === 'car' ? 2 : 3;
    labelled(L.circleMarker([p.lat, p.lng], {
      radius: kind === 'venue' ? 10 : kind === 'st' ? (used.has(id) ? 9 : 5) : 7,
      color: '#fff', weight: 2, fillColor: pointColor(kind), fillOpacity: highlighted ? 1 : 0.5,
    }).bindTooltip(esc(p.name) + (stopNotes[id] ? `<br><b>${stopNotes[id].map(esc).join('<br>')}</b>` : ''),
      { permanent: highlighted, direction: 'top', offset: [0, -6], className: 'lbl' }), priority).addTo(view.planLayer);
  }
  if (fit) {
    const focus = [ll('venue'), ...[...used].map(ll),
      ...(plan?.routes || []).flatMap((r) => [...(r.path || [ll(`car:${r.driver}`)]), ...(r.direct_path || [])])];
    view.map.fitBounds(L.latLngBounds(focus).pad(0.1));
  }
  showLayers();
  setTimeout(declutter, 0);
}

// 地图组件（Leaflet）没加载出来也不影响填写和计算：地图区显示说明和「重试」
export function initMap() {
  if (typeof L === 'undefined') { $('#mapFail').hidden = false; return false; }
  $('#mapFail').hidden = true;
  view.map = L.map('map').setView([34.5, 112], 5);
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    subdomains: '1234', maxZoom: 18, attribution: '© 高德地图 GS(2025)5996号',
  }).addTo(view.map);
  view.planLayer = L.layerGroup();
  view.previewLayer = L.layerGroup().addTo(view.map);
  view.map.on('zoomend moveend resize', declutter);
  emit('map', view.map);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'legend');
    d.innerHTML = `<div><i style="background:var(--dest)"></i>目的地</div><div><i style="background:var(--drive)"></i>开车的成员</div>
      <div><i style="background:var(--ride)"></i>不开车的成员</div><div><i style="background:var(--station)"></i>车站</div>
      <div>彩色线 = 接人后的实际路线</div><div>灰色虚线 = 不接人时的直达路线</div>
      <div class="legend-sug" hidden><div><i class="lg-route"></i>点线 = 车主路线（找站用）</div><div><i class="lg-circle"></i>浅色圈 = 搜过的范围</div></div>`;
    return d;
  };
  legend.addTo(view.map);
  return true;
}

