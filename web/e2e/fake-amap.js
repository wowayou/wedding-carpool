// SPDX-License-Identifier: AGPL-3.0-or-later
// 高德 JS API 2.0 的替身（e2e 用，不连外网）：lib.mjs 的 fakeJsApi 把 https://webapi.amap.com/maps?… 的请求换成这个文件。
// 只实现地图页面（web/map/amap-render.js）用到的部分：Map、CircleMarker、Polyline、Circle、Text、Pixel、LngLat。
// Text 的 text 和真的一样当 HTML 解析（所以调用方要自己转义）。
// 覆盖物画成带 data 属性的 DOM 元素（data-fake="circlemarker|polyline|circle|text"），位置按一个简单的等距投影算，便于断言个数、位置和显示隐藏；
// 所有调用记在 window.__fakeAmap.calls，建过的地图在 window.__fakeAmap.maps。
(() => {
  const rec = (window.__fakeAmap = { calls: [], maps: [], loads: (window.__fakeAmap?.loads || 0) + 1 });
  const log = (fn, arg) => rec.calls.push({ fn, arg });

  class Pixel { constructor(x, y) { this.x = x; this.y = y; } getX() { return this.x; } getY() { return this.y; } }
  class LngLat { constructor(lng, lat) { this.lng = lng; this.lat = lat; } getLng() { return this.lng; } getLat() { return this.lat; } toString() { return `${this.lng},${this.lat}`; } }
  const ll = (p) => (Array.isArray(p) ? { lng: p[0], lat: p[1] } : { lng: p.lng ?? p.getLng(), lat: p.lat ?? p.getLat() });

  class Overlay {
    constructor(kind, opts) { this.kind = kind; this.opts = opts || {}; this.handlers = {}; this.hidden = false; }
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
    hide() { this.hidden = true; log(`${this.kind}.hide`); this._sync(); }
    show() { this.hidden = false; log(`${this.kind}.show`); this._sync(); }
    // 地图上的位置（用于测试断言）：点和文字是一个位置，线和圈是一组
    _points() {
      const o = this.opts;
      if (o.path) return o.path.map(ll);
      return [ll(o.center || o.position)];
    }
    _el() {
      if (this.el) return this.el;
      const el = document.createElement('div');
      el.dataset.fake = this.kind.toLowerCase();
      el.style.position = 'absolute';
      if (this.opts.text !== undefined) el.innerHTML = this.opts.text; // 和真的 AMap.Text 一样：text 当 HTML 解析（线上实测）
      if (this.opts.text !== undefined && this.opts.style) Object.assign(el.style, { whiteSpace: this.opts.style['white-space'] });
      const o = this.opts;
      el.dataset.stroke = o.strokeColor || '';
      el.dataset.fill = o.fillColor || '';
      el.dataset.fillOpacity = String(o.fillOpacity ?? '');
      el.dataset.dash = o.strokeDasharray ? o.strokeDasharray.join(' ') : '';
      el.dataset.opacity = String(o.strokeOpacity ?? '');
      if (o.radius !== undefined) el.dataset.radius = String(o.radius);
      if (o.zIndex !== undefined) el.style.zIndex = String(o.zIndex);
      for (const ev of ['mouseover', 'mouseout', 'mousemove']) {
        el.addEventListener(ev, (e) => (this.handlers[ev] || []).forEach((fn) => fn({ originEvent: e, pixel: new Pixel(e.offsetX, e.offsetY) })));
      }
      this.el = el;
      return el;
    }
    _sync() { if (this.el) this.el.dataset.hidden = String(this.hidden); if (this.el) this.el.style.display = this.hidden ? 'none' : ''; }
    getPath() { return this.opts.path; }
    getCenter() { return this.opts.center; }
  }
  class CircleMarker extends Overlay { constructor(o) { super('CircleMarker', o); log('CircleMarker', o); } }
  class Polyline extends Overlay { constructor(o) { super('Polyline', o); log('Polyline', o); } }
  class Circle extends Overlay { constructor(o) { super('Circle', o); log('Circle', o); } }
  class Text extends Overlay { constructor(o) { super('Text', o); log('Text', o); } setText(t) { this.opts.text = t; if (this.el) this.el.innerHTML = t; } }

  class Map {
    constructor(container, opts) {
      this.container = typeof container === 'string' ? document.getElementById(container) : container;
      this.opts = opts || {};
      log('Map', opts);
      this.root = document.createElement('div');
      this.root.dataset.fake = 'map';
      this.root.dataset.style = opts?.mapStyle || '';
      Object.assign(this.root.style, { position: 'absolute', inset: '0', overflow: 'hidden' });
      // 真的高德在这个 Key 下给的是栅格底图：容器里一张张 <img> 瓦片（线上实测），地址形如 webrd0x.is.autonavi.com/appmaptile?…
      const tile = document.createElement('img');
      tile.dataset.fake = 'tile';
      tile.src = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=1&y=1&z=3';
      Object.assign(tile.style, { position: 'absolute', left: '0', top: '0', width: '256px', height: '256px' });
      this.root.append(tile);
      this.container.append(this.root);
      this.overlays = new Set();
      this.view = { center: ll(opts?.center || [112, 34.5]), zoom: opts?.zoom ?? 5 };
      this.handlers = {};
      this._paint();
      rec.maps.push(this);
      setTimeout(() => (this.handlers.complete || []).forEach((fn) => fn()), 0);
    }
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
    _fire(ev) { (this.handlers[ev] || []).forEach((fn) => fn()); }
    // 等距投影：一度经度（纬度同）对应 256 * 2^zoom / 360 像素
    _scale() { return (256 * 2 ** this.view.zoom) / 360; }
    lngLatToContainer(p) {
      const { lng, lat } = ll(p), s = this._scale();
      return new Pixel((lng - this.view.center.lng) * s + this.container.clientWidth / 2, (this.view.center.lat - lat) * s + this.container.clientHeight / 2);
    }
    _paint() {
      for (const o of this.overlays) {
        const el = o._el();
        if (!el.parentNode) this.root.append(el);
        o._sync();
        const pts = o._points().map((p) => this.lngLatToContainer(p));
        el.dataset.x = String(Math.round(pts[0].x));
        el.dataset.y = String(Math.round(pts[0].y));
        el.dataset.xs = pts.map((p) => Math.round(p.x)).join(',');
        el.dataset.ys = pts.map((p) => Math.round(p.y)).join(',');
        Object.assign(el.style, { left: `${pts[0].x}px`, top: `${pts[0].y}px` });
        if (o.kind === 'Circle') el.dataset.radiusM = String(o.opts.radius);
      }
    }
    add(list) { log('add', (Array.isArray(list) ? list : [list]).map((o) => o.kind)); for (const o of Array.isArray(list) ? list : [list]) this.overlays.add(o); this._paint(); }
    remove(list) {
      log('remove', (Array.isArray(list) ? list : [list]).map((o) => o.kind));
      for (const o of Array.isArray(list) ? list : [list]) { this.overlays.delete(o); o.el?.remove(); o.el = null; }
    }
    resize() { log('resize'); this._paint(); this._fire('resize'); }
    setMapStyle(style) { log('setMapStyle', style); this.root.dataset.style = style; }
    getZoom() { return this.view.zoom; }
    getCenter() { return new LngLat(this.view.center.lng, this.view.center.lat); }
    setZoom(z) { this.view.zoom = z; this._paint(); this._fire('zoomend'); }
    // avoid 的顺序和真 API 一样：[上, 下, 左, 右]
    setFitView(overlays, immediately, avoid, maxZoom) {
      log('setFitView', { count: overlays?.length, immediately, avoid, maxZoom });
      const pts = (overlays || [...this.overlays]).flatMap((o) => o._points());
      if (!pts.length) return;
      const [t, b, l, r] = avoid || [60, 60, 60, 60];
      const W = this.container.clientWidth, H = this.container.clientHeight;
      const lngs = pts.map((p) => p.lng), lats = pts.map((p) => p.lat);
      const dx = Math.max(...lngs) - Math.min(...lngs), dy = Math.max(...lats) - Math.min(...lats);
      let zoom = maxZoom ?? 18;
      if (dx > 0) zoom = Math.min(zoom, Math.log2(((W - l - r) * 360) / (256 * dx)));
      if (dy > 0) zoom = Math.min(zoom, Math.log2(((H - t - b) * 360) / (256 * dy)));
      this.view.zoom = zoom;
      const s = this._scale();
      // 范围的中心要落在留白之后的区域正中
      this.view.center = { lng: (Math.max(...lngs) + Math.min(...lngs)) / 2 - (l - r) / 2 / s, lat: (Math.max(...lats) + Math.min(...lats)) / 2 + (t - b) / 2 / s };
      this._paint();
      this._fire('zoomend');
    }
  }

  window.AMap = { Map, CircleMarker, Polyline, Circle, Text, Pixel, LngLat, version: 'fake-2.0' };
})();
