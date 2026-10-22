// SPDX-License-Identifier: AGPL-3.0-or-later
// 不带底图的画法：没有 Key、高德 JS API 没加载出来时用。墨卡托投影，SVG 画点、线、圈，HTML 叠一层标签。
// 可以拖动和滚轮缩放；角上写「没有底图」。
import { declutter } from './declutter.js';
import { fitView, metersToPx, toScreen, unproject, project } from './mercator.js';
import { DEFAULT_MAX_ZOOM, DEFAULT_PRIORITY, DEFAULT_RADIUS, POINT_VARS, fitPadding, fitTargets, labelAlways } from './scene.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

export function createPlainRenderer(host) {
  const box = host.container;
  box.classList.add('plain');
  const svg = svgEl('svg', { class: 'plain-svg' });
  const labels = document.createElement('div');
  labels.className = 'plain-labels';
  const note = document.createElement('div');
  note.className = 'plain-note';
  note.textContent = '没有底图';
  box.append(svg, labels, note);

  let scene = null;
  let view = { center: [105, 35], zoom: 3 };
  let hasView = false;
  let hovered = null;

  const size = () => ({ width: box.clientWidth, height: box.clientHeight });

  function render() {
    svg.replaceChildren();
    labels.replaceChildren();
    if (!scene) return;
    const { width, height } = size();
    const v = { ...view, width, height };
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    const dash = (el, d) => { if (d) el.setAttribute('stroke-dasharray', d.join(' ')); };
    for (const c of scene.circles) {
      const [x, y] = toScreen(c.center[0], c.center[1], v);
      const col = host.color(c.color);
      const el = svgEl('circle', { 'data-layer': 'circle', cx: x, cy: y, r: metersToPx(c.radius_m, c.center[1], view.zoom), stroke: col, 'stroke-width': c.weight ?? 1,
        'stroke-opacity': c.opacity ?? 0.6, fill: col, 'fill-opacity': c.fillOpacity ?? 0.06 });
      dash(el, c.dash);
      svg.append(el);
    }
    for (const l of scene.lines) {
      const pts = l.path.map(([lng, lat]) => toScreen(lng, lat, v).map((n) => n.toFixed(1)).join(',')).join(' ');
      const el = svgEl('polyline', { 'data-layer': 'line', points: pts, fill: 'none', stroke: host.color(l.color), 'stroke-width': l.weight ?? 4,
        'stroke-opacity': l.opacity ?? 0.85, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      dash(el, l.dash);
      if (l.tooltip) {
        // 线很细，悬停用一条透明的粗线来接
        const hit = svgEl('polyline', { points: pts, fill: 'none', stroke: 'transparent', 'stroke-width': 14, class: 'plain-hit' });
        hit.addEventListener('mousemove', (e) => host.showTip(l.tooltip, e.clientX, e.clientY));
        hit.addEventListener('mouseleave', () => host.hideTip());
        svg.append(el, hit);
      } else svg.append(el);
    }
    const items = [];
    scene.points.forEach((p) => {
      const [x, y] = toScreen(p.lng, p.lat, v);
      const r = p.radius ?? DEFAULT_RADIUS[p.kind];
      const fill = p.highlight !== false, hi = labelAlways(p);
      const dot = svgEl('circle', { 'data-layer': 'point', 'data-kind': p.kind, 'data-name': p.name, cx: x, cy: y, r, stroke: host.color('--surface'), 'stroke-width': 2,
        fill: host.color(POINT_VARS[p.kind]), 'fill-opacity': fill ? 1 : 0.5 });
      const text = [p.name, ...(p.notes || [])].join('\n');
      const label = document.createElement('div');
      label.className = 'lbl';
      label.textContent = text;
      label.style.left = `${x}px`;
      label.style.top = `${y - r - 4}px`;
      labels.append(label);
      const m = host.measure(text);
      const item = { priority: p.priority ?? DEFAULT_PRIORITY, hi, label, rect: { left: x - m.width / 2, right: x + m.width / 2, bottom: y - r - 4, top: y - r - 4 - m.height } };
      items.push(item);
      dot.addEventListener('mouseenter', () => { hovered = item; label.style.visibility = 'visible'; });
      dot.addEventListener('mouseleave', () => { hovered = null; layoutLabels(items); });
      svg.append(dot);
    });
    layoutLabels(items);
  }
  // 要显示的标签：只有 label 为 always 的参与竞争，按优先级留下互不遮挡的；其余只在悬停时显示
  function layoutLabels(items) {
    const cand = items.filter((it) => it.hi);
    const shown = declutter(cand);
    for (const it of items) it.label.style.visibility = it === hovered ? 'visible' : 'hidden';
    cand.forEach((it, i) => { if (shown[i]) it.label.style.visibility = 'visible'; });
  }

  // 拖动和滚轮缩放
  let drag = null;
  box.addEventListener('pointerdown', (e) => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY }; box.setPointerCapture?.(e.pointerId); } });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [cx, cy] = project(view.center[0], view.center[1], view.zoom);
    view = { ...view, center: unproject(cx - (e.clientX - drag.x), cy - (e.clientY - drag.y), view.zoom) };
    drag = { x: e.clientX, y: e.clientY };
    hasView = true;
    render();
  });
  const endDrag = () => { drag = null; };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = box.getBoundingClientRect(), { width, height } = size();
    const mx = e.clientX - rect.left - width / 2, my = e.clientY - rect.top - height / 2;
    const zoom = Math.max(1, Math.min(18, view.zoom + (e.deltaY < 0 ? 0.5 : -0.5)));
    // 鼠标指着的那个位置缩放前后不动
    const [cx, cy] = project(view.center[0], view.center[1], view.zoom);
    const k = 2 ** (zoom - view.zoom);
    view = { center: unproject((cx + mx) * k - mx, (cy + my) * k - my, zoom), zoom };
    hasView = true;
    render();
  }, { passive: false });

  return {
    kind: 'plain',
    draw(next) {
      scene = next;
      if (!hasView) this.fit(next); // 第一次画一定要有个合适的视野
      else render();
      return { points: next.points.length, lines: next.lines.length, circles: next.circles.length };
    },
    // 返回这次是不是真的做了：容器没有尺寸（隐藏的页签）时返回 false，调用方记下，等有尺寸再做
    fit(next = scene) {
      const { width, height } = size();
      const f = next && fitView(fitTargets(next), { width, height, padding: fitPadding(next), maxZoom: next.fit?.maxZoom ?? DEFAULT_MAX_ZOOM });
      if (!f) { if (next && !fitTargets(next).length) hasView = true; return !next || !fitTargets(next).length; }
      view = f;
      hasView = true;
      render();
      return true;
    },
    resize() { if (!hasView && scene) this.fit(scene); else render(); },
    setTheme() { render(); },
  };
}
