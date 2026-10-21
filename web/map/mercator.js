// SPDX-License-Identifier: AGPL-3.0-or-later
// 墨卡托投影和自适应范围的计算（不带底图的画法用；纯计算，不碰 DOM）。
// 世界在缩放级别 z 下是 256 * 2^z 像素见方的正方形；x 向右、y 向下，和屏幕一致。

const TILE = 256;
const MAX_LAT = 85.0511287798;
export const worldSize = (z) => TILE * 2 ** z;

export function project(lng, lat, z) {
  const s = worldSize(z), la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
  return [(lng + 180) / 360 * s, (0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI)) * s];
}
export function unproject(x, y, z) {
  const s = worldSize(z);
  return [x / s * 360 - 180, (2 * Math.atan(Math.exp((0.5 - y / s) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI];
}
// 经纬度在当前视野里的屏幕坐标。view = { center: [lng, lat], zoom, width, height }
export function toScreen(lng, lat, view) {
  const [cx, cy] = project(view.center[0], view.center[1], view.zoom), [x, y] = project(lng, lat, view.zoom);
  return [x - cx + view.width / 2, y - cy + view.height / 2];
}
// 一米对应多少像素（在这个纬度、这个缩放级别）
export const metersToPx = (m, lat, z) => m / (40075016.686 * Math.cos(lat * Math.PI / 180) / worldSize(z));

// 把一组点框进 width×height 的容器，四边各留 padding 像素；返回 { center, zoom }。
// 只有一个点（或所有点重合）时用 maxZoom。容器没有尺寸时返回 null（调用方记下，等有尺寸再做）
export function fitView(points, { width, height, padding = {}, maxZoom = 16, minZoom = 1 }) {
  if (!points.length || !(width > 0) || !(height > 0)) return null;
  const pad = { top: 0, right: 0, bottom: 0, left: 0, ...padding };
  const availW = Math.max(1, width - pad.left - pad.right), availH = Math.max(1, height - pad.top - pad.bottom);
  const xy = points.map(([lng, lat]) => project(lng, lat, 0));
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const dx = x1 - x0, dy = y1 - y0;
  let zoom = maxZoom;
  if (dx > 0) zoom = Math.min(zoom, Math.log2(availW / dx));
  if (dy > 0) zoom = Math.min(zoom, Math.log2(availH / dy));
  zoom = Math.max(minZoom, Math.min(maxZoom, zoom));
  const k = 2 ** zoom;
  // 范围的中心要落在留白之后的可用区域正中，所以容器中心对应的位置要往留白少的一侧偏
  const mx = (x0 + x1) / 2 * k - (pad.left - pad.right) / 2, my = (y0 + y1) / 2 * k - (pad.top - pad.bottom) / 2;
  return { center: unproject(mx, my, zoom), zoom };
}
