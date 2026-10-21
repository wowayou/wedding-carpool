// SPDX-License-Identifier: AGPL-3.0-or-later
// 高德 JS API 2.0 的画法：AMap.Map 画底图，CircleMarker 画点，Text 画标签，Polyline 画线，Circle 画圈。
// 只显示地图，不配安全密钥（securityJsCode）。深色用高德自带的深色样式。
import { declutter } from './declutter.js';
import { DEFAULT_MAX_ZOOM, DEFAULT_PRIORITY, DEFAULT_RADIUS, POINT_VARS, fitPadding, fitTargets, labelAlways } from './scene.js';

const styleOf = (theme) => (theme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal');

export function createAmapRenderer(host, theme) {
  const AMap = window.AMap;
  const map = new AMap.Map(host.container, { zoom: 5, center: [112, 34.5], resizeEnable: true, mapStyle: styleOf(theme), viewMode: '2D' });
  let overlays = [];
  let labels = []; // { priority, hi, text, rect(), hovered }
  let hovered = null;
  let currentTheme = theme;

  const px = (lng, lat) => {
    const p = map.lngLatToContainer(new AMap.LngLat(lng, lat));
    return [p.getX ? p.getX() : p.x, p.getY ? p.getY() : p.y];
  };
  // 标签的位置和大小是按文字估算的（AMap.Text 的 DOM 不对外），好在只是用来判断互相遮挡
  function layoutLabels() {
    const cand = labels.filter((l) => l.hi);
    const shown = declutter(cand.map((l) => ({ priority: l.priority, rect: l.rect() })));
    for (const l of labels) (l === hovered ? l.text.show() : l.text.hide());
    cand.forEach((l, i) => { if (shown[i]) l.text.show(); });
  }
  for (const ev of ['zoomend', 'moveend', 'resize']) map.on(ev, layoutLabels);

  const dashOf = (d) => (d ? { strokeStyle: 'dashed', strokeDasharray: d } : {});

  return {
    kind: 'amap',
    draw(scene) {
      if (scene.theme !== currentTheme) { currentTheme = scene.theme; map.setMapStyle(styleOf(scene.theme)); }
      if (overlays.length) map.remove(overlays);
      overlays = [];
      labels = [];
      hovered = null;
      const font = '12px ' + (getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif');
      // 叠放顺序：圈在最下，线，点，标签在最上（同一层按 scene 里的先后）
      for (const c of scene.circles) {
        overlays.push(new AMap.Circle({ center: c.center, radius: c.radius_m, strokeColor: host.color(c.color), strokeWeight: c.weight ?? 1, strokeOpacity: c.opacity ?? 0.6,
          fillColor: host.color(c.color), fillOpacity: c.fillOpacity ?? 0.06, zIndex: 10, bubble: true, ...dashOf(c.dash) }));
      }
      for (const l of scene.lines) {
        const line = new AMap.Polyline({ path: l.path, strokeColor: host.color(l.color), strokeWeight: l.weight ?? 4, strokeOpacity: l.opacity ?? 0.85,
          lineJoin: 'round', lineCap: 'round', zIndex: 20, ...dashOf(l.dash) });
        if (l.tooltip) {
          const at = (e) => host.showTip(l.tooltip, e.originEvent?.clientX ?? 0, e.originEvent?.clientY ?? 0);
          line.on('mouseover', at);
          line.on('mousemove', at);
          line.on('mouseout', () => host.hideTip());
        }
        overlays.push(line);
      }
      for (const p of scene.points) {
        const r = p.radius ?? DEFAULT_RADIUS[p.kind], fill = p.highlight !== false, hi = labelAlways(p);
        const marker = new AMap.CircleMarker({ center: [p.lng, p.lat], radius: r, strokeColor: host.color('--surface'), strokeWeight: 2,
          fillColor: host.color(POINT_VARS[p.kind]), fillOpacity: fill ? 1 : 0.5, zIndex: 30, bubble: false, cursor: 'pointer' });
        const content = [p.name, ...(p.notes || [])].join('\n');
        const text = new AMap.Text({ text: content, position: [p.lng, p.lat], anchor: 'bottom-center', offset: new AMap.Pixel(0, -(r + 4)), zIndex: 40,
          style: { 'font-size': '12px', padding: '1px 6px', 'white-space': 'pre', color: host.color('--ink'), background: host.color('--surface'), border: `1px solid ${host.color('--line-strong')}`, 'border-radius': '4px' } });
        const m = host.measure(content, font);
        const label = { priority: p.priority ?? DEFAULT_PRIORITY, hi, text, rect() {
          const [x, y] = px(p.lng, p.lat), bottom = y - r - 4;
          return { left: x - m.width / 2, right: x + m.width / 2, bottom, top: bottom - m.height };
        } };
        marker.on('mouseover', () => { hovered = label; text.show(); });
        marker.on('mouseout', () => { hovered = null; layoutLabels(); });
        labels.push(label);
        overlays.push(marker, text);
      }
      map.add(overlays);
      layoutLabels();
      return { points: scene.points.length, lines: scene.lines.length, circles: scene.circles.length };
    },
    // 返回这次是不是真的做了：容器没有尺寸（隐藏的页签）时返回 false，调用方记下，等有尺寸再做
    fit(scene) {
      const box = host.container;
      if (!box.clientWidth || !box.clientHeight) return false;
      map.resize?.();
      const targets = fitTargets(scene);
      if (!targets.length) return true;
      // setFitView 只认覆盖物：用一条看不见的线把要框住的位置交给它，框完就拿掉
      const probe = new AMap.Polyline({ path: targets.length > 1 ? targets : [targets[0], targets[0]], strokeOpacity: 0, strokeWeight: 1, clickable: false, bubble: true });
      map.add(probe);
      const pad = fitPadding(scene);
      map.setFitView([probe], true, [pad.top, pad.bottom, pad.left, pad.right], scene.fit?.maxZoom ?? DEFAULT_MAX_ZOOM); // 留白顺序：上、下、左、右
      map.remove(probe);
      layoutLabels();
      return true;
    },
    resize() { map.resize?.(); layoutLabels(); },
    setTheme(t) { if (t !== currentTheme) { currentTheme = t; map.setMapStyle(styleOf(t)); } },
  };
}
