// ---------- 编辑页的地图：把 state 变成 scene（纯函数，不碰 DOM 和 Leaflet，node 里能直接测） ----------
// scene 的格式见 web/map/scene.js；坐标都是 [lng, lat]。后端给的路线 path 和找站的 trace 是 [lat, lng]，在这里统一翻过来。
// 颜色写设计变量名（--dest 等），由地图页面取值（深色自动换）。

import { fmtMin } from './time.js';

export const COLORS = ['#c2410c', '#1d4ed8', '#7c3aed', '#0f766e', '#be185d', '#4d7c0f'];
const PRIORITY = { venue: 0, car: 2, home: 3, st: 4 }; // 标签互相遮挡时：目的地 > 用到的车站 > 开车的 > 不开车的 > 其他车站

const swap = ([lat, lng]) => [lng, lat];
const locOf = (loc) => { const [lng, lat] = String(loc || '').split(',').map(Number); return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null; };

// 图例（一行一项）。找站用的两行只在找站过程显示时才有
export const LEGEND = [
  { type: 'dot', color: '--dest', text: '目的地' },
  { type: 'dot', color: '--drive', text: '开车的成员' },
  { type: 'dot', color: '--ride', text: '不开车的成员' },
  { type: 'dot', color: '--station', text: '车站' },
  { type: 'line', color: COLORS[0], text: '彩色线 = 接人后的实际路线' },
  { type: 'line', color: '--taxi', dash: [6, 8], text: '灰色虚线 = 不接人时的直达路线' },
];
export const SUG_LEGEND = [
  { type: 'line', color: '--drive', dash: [2, 7], text: '点线 = 车主路线（找站用）' },
  { type: 'circle', color: '--station', text: '浅色圈 = 搜过的范围' },
];

// 没算方案时：目的地、车站、成员（已定位的）。返回 { points, lines, circles, fit }，fit 是要框住的位置
export function previewParts(cfg) {
  const points = [];
  const add = (loc, kind, name, radius) => {
    const at = locOf(loc);
    if (!at) return;
    points.push({ lng: at[0], lat: at[1], kind, name, priority: PRIORITY[kind], highlight: kind !== 'st', ...(radius ? { radius } : {}) });
  };
  add(cfg.venue?.location, 'venue', cfg.venue?.name || '目的地', 10);
  (cfg.stations || []).forEach((s) => add(s.location, 'st', s.name || '车站', 6));
  (cfg.people || []).forEach((p) => add(p.location, p.car_seats !== undefined ? 'car' : 'home', `${p.name || '成员'}${p.car_seats !== undefined ? '（开车）' : ''}`, 7));
  return { points, lines: [], circles: [], fit: { points: points.map((p) => [p.lng, p.lat]), padding: 40, maxZoom: 11 } };
}

// 算出方案后：车主路线、不接人的直达路线（虚线）、打车（虚线）、用到的站高亮、附注「多绕 X 分钟」。
// view：{ viewLeg, active, activeBack }，决定画去程还是返程的第几个方案
export function planParts(result, view) {
  const pts = result.points;
  const back = view.viewLeg === 'back' && result.back;
  const plan = back ? result.back.plans[view.activeBack] : result.plans[view.active];
  const seq = (r) => (back ? ['venue', ...r.stops, `car:${r.driver}`] : [`car:${r.driver}`, ...r.stops, 'venue']);
  const lg = (id) => [pts[id].lng, pts[id].lat];
  const used = new Set();
  const stopNotes = {};
  const lines = [];
  const routes = plan?.routes || [];
  routes.forEach((r) => {
    // 先画不接人时的直达路线（灰色虚线），接人的彩色路线盖在上面，分岔的那段就是绕的路
    if (!r.stops.length) return;
    lines.push({
      path: r.direct_path ? r.direct_path.map(swap) : seq({ driver: r.driver, stops: [] }).map(lg),
      color: '--taxi', weight: 4, opacity: 0.8, dash: [6, 8], tooltip: `${r.driver} ${back ? '不送人直接回家' : '不接人'}的直达路线`,
    });
    (stopNotes[r.stops[0]] ??= []).push(`${r.driver} 多绕 ${fmtMin(r.detour)}`);
  });
  routes.forEach((r, i) => {
    r.stops.forEach((s) => used.add(s));
    lines.push({
      path: r.path ? r.path.map(swap) : seq(r).map(lg),
      color: COLORS[i % COLORS.length], weight: 5, opacity: 0.85, dash: r.path ? null : [8, 8],
      tooltip: `${r.driver}：${r.stops.length ? '多绕 ' + fmtMin(r.detour) : '直达'}，全程约 ${fmtMin(r.minutes)}`,
    });
  });
  Object.entries(plan?.taxi || {}).forEach(([who, s]) => {
    used.add(s);
    lines.push({ path: [lg(s), lg('venue')], color: '--taxi', weight: 3, dash: [4, 6], tooltip: `${who} 打车` });
  });
  const points = [];
  for (const [id, p] of Object.entries(pts)) {
    const kind = id === 'venue' ? 'venue' : id.split(':')[0];
    const highlight = kind !== 'st' || used.has(id);
    points.push({
      lng: p.lng, lat: p.lat, kind, name: p.name, ...(stopNotes[id] ? { notes: stopNotes[id] } : {}),
      priority: kind === 'venue' ? 0 : kind === 'st' ? (used.has(id) ? 1 : 4) : kind === 'car' ? 2 : 3,
      highlight, radius: kind === 'venue' ? 10 : kind === 'st' ? (used.has(id) ? 9 : 5) : 7,
    });
  }
  const focus = [lg('venue'), ...[...used].map(lg), ...routes.flatMap((r) => [...(r.path ? r.path.map(swap) : [lg(`car:${r.driver}`)]), ...(r.direct_path ? r.direct_path.map(swap) : [])])];
  return { points, lines, circles: [], fit: { points: focus, padding: 24 } };
}

// 找站过程：搜过的圈、车主路线（点线）、候选站（只在悬停时显示名字）
export function sugParts(trace, stations) {
  if (!trace) return null;
  const circles = (trace.circles || []).map((c) => ({
    center: [c.lng, c.lat], radius_m: c.radius_km * 1000, color: '--station', weight: 1, opacity: c.searched === false ? 0.35 : 0.6,
    fillOpacity: c.searched === false ? 0.02 : 0.06, dash: c.searched === false ? [4, 4] : null,
  }));
  const lines = (trace.routes || []).map((r) => ({ path: r.path.map(swap), color: '--drive', weight: 3, opacity: r.alt > 1 ? 0.45 : 0.9, dash: [2, 7] }));
  const points = [];
  for (const s of stations || []) {
    const at = locOf(s.location);
    if (at) points.push({ lng: at[0], lat: at[1], kind: 'st', name: s.name, priority: 4, highlight: false, radius: s.listed ? 6 : 4 });
  }
  return { points, lines, circles };
}

// 找站图层要框住的位置：圈（按半径换成经纬度范围的两个角）、车主路线、候选站。没有就返回 null
export function sugFitPoints(trace, stations) {
  const pts = [];
  for (const c of trace?.circles || []) {
    const dLat = c.radius_km / 111.2, dLng = c.radius_km / (111.2 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
    pts.push([c.lng - dLng, c.lat - dLat], [c.lng + dLng, c.lat + dLat]);
  }
  for (const r of trace?.routes || []) pts.push(...r.path.map(swap));
  for (const s of stations || []) { const at = locOf(s.location); if (at) pts.push(at); }
  return pts.length ? pts : null;
}

// 合成一份 scene。base：previewParts 或 planParts 的结果（或 null）；sug：sugParts 的结果（或 null，null 表示不显示）；
// fit：要自适应时 { points, padding?, maxZoom? }（padding 可以是数字，也可以是四边的对象），不写就不动视野
export function composeScene({ base, sug, theme, fit }) {
  const parts = [sug, base].filter(Boolean); // 找站图层放前面：圈和线画在方案路线下面，点画在下面
  let fitOut = { auto: false };
  if (fit?.points?.length) {
    const p = fit.padding ?? 16;
    fitOut = { auto: true, points: fit.points, padding: typeof p === 'number' ? { top: p, right: p, bottom: p, left: p } : p, ...(fit.maxZoom ? { maxZoom: fit.maxZoom } : {}) };
  }
  return {
    v: 1, theme,
    points: parts.flatMap((x) => x.points),
    lines: parts.flatMap((x) => x.lines),
    circles: parts.flatMap((x) => x.circles),
    fit: fitOut,
    legend: [...LEGEND, ...(sug ? SUG_LEGEND : [])],
  };
}
