// SPDX-License-Identifier: AGPL-3.0-or-later
// 地图页面的离线测试（v3.16）：scene 格式校验、不带底图的投影和自适应范围、标签取舍、脚本打包。不联网、不开浏览器。运行：npm test
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { bundleMap } from './map/bundle.mjs';
import { declutter } from './map/declutter.js';
import { fitView, metersToPx, project, toScreen, unproject } from './map/mercator.js';
import { fitTargets, labelAlways, validateScene } from './map/scene.js';

const scene = (extra = {}) => ({
  v: 1, theme: 'light',
  points: [
    { lng: 117.98, lat: 30.0, kind: 'venue', name: '宏村示例酒店', priority: 0 },
    { lng: 118.27, lat: 29.81, kind: 'st', name: '黄山北站', notes: ['老王 多绕 15 分钟'], highlight: false, radius: 6 },
  ],
  lines: [{ path: [[120.12, 30.27], [118.27, 29.81], [117.98, 30.0]], color: '--taxi', weight: 4, opacity: 0.8, dash: [6, 8], tooltip: '老王：直达' }],
  circles: [{ center: [118.27, 29.81], radius_m: 30000, color: '#2563eb', weight: 1, fillOpacity: 0.06, dash: null }],
  fit: { auto: true, padding: { top: 16, right: 420, bottom: 16, left: 16 }, maxZoom: 12 },
  legend: [{ type: 'dot', color: '--dest', text: '目的地' }, { type: 'line', color: '--taxi', dash: [6, 8], text: '直达路线' }, { type: 'circle', color: '--station', text: '搜过的范围' }],
  ...extra,
});

test('scene：合法的完整例子、最小例子都通过', () => {
  assert.deepEqual(validateScene(scene()), []);
  assert.deepEqual(validateScene({ v: 1, theme: 'dark', points: [], lines: [], circles: [] }), []);
});

test('scene：不合法的写法逐项报出来', () => {
  const bad = (patch, re) => {
    const errs = validateScene(typeof patch === 'function' ? patch(scene()) : scene(patch));
    assert.ok(errs.some((e) => re.test(e)), `${re}：${JSON.stringify(errs)}`);
  };
  assert.deepEqual(validateScene(null), ['scene 不是对象']);
  assert.ok(validateScene([]).length);
  bad({ v: 2 }, /v 必须是 1/);
  bad({ theme: 'sepia' }, /theme/);
  bad({ points: 'x' }, /points 必须是数组/);
  bad((s) => { s.points[0].kind = 'bus'; return s; }, /points\[0\].*kind/);
  bad((s) => { s.points[0].lng = 'x'; return s; }, /points\[0\].*lng\/lat/);
  bad((s) => { s.points[0].lat = 91; return s; }, /points\[0\].*lng\/lat/); // 纬度越界（常见的是写反了 [lat, lng]）
  bad((s) => { s.points[0].name = 5; return s; }, /points\[0\].*name/);
  bad((s) => { s.points[1].notes = 'x'; return s; }, /notes/);
  bad((s) => { s.points[1].highlight = 'yes'; return s; }, /highlight/);
  bad((s) => { s.points[1].label = 'sometimes'; return s; }, /points\[1\].*label/);
  bad((s) => { s.lines[0].path = [[1, 2]]; return s; }, /lines\[0\].*path/);
  bad((s) => { s.lines[0].path = [[1, 2], [3]]; return s; }, /lines\[0\].*path/);
  bad((s) => { s.lines[0].color = 'red'; return s; }, /lines\[0\].*color/);
  bad((s) => { s.lines[0].opacity = 2; return s; }, /opacity/);
  bad((s) => { s.lines[0].dash = [1]; return s; }, /dash/);
  bad((s) => { s.circles[0].radius_m = 0; return s; }, /radius_m/);
  bad((s) => { s.circles[0].center = [200, 0]; return s; }, /center/);
  bad((s) => { s.fit = { auto: 'yes' }; return s; }, /fit\.auto/);
  bad((s) => { s.fit.padding = { top: 1 }; return s; }, /fit\.padding/);
  bad((s) => { s.legend[0].type = 'square'; return s; }, /legend\[0\].*type/);
  bad((s) => { s.legend[1].text = 1; return s; }, /legend\[1\].*text/);
});

test('scene：填充（highlight）和标签显示方式（label）分开；label 没写按 highlight 推出', () => {
  assert.deepEqual(validateScene(scene({ points: [{ lng: 118, lat: 30, kind: 'st', name: '甲站', highlight: true, label: 'hover' }] })), []);
  assert.equal(labelAlways({}), true);
  assert.equal(labelAlways({ highlight: true }), true);
  assert.equal(labelAlways({ highlight: false }), false);
  assert.equal(labelAlways({ highlight: true, label: 'hover' }), false, '实心但标签只在悬停时显示');
  assert.equal(labelAlways({ highlight: false, label: 'always' }), true, '半透明但标签一直显示');
});

test('scene：要框住的位置默认是全部点、线、圈心；fit.points 优先', () => {
  assert.equal(fitTargets(scene()).length, 2 + 3 + 1);
  assert.deepEqual(fitTargets(scene({ fit: { auto: true, points: [[1, 2]] } })), [[1, 2]]);
});

test('墨卡托：投影和反投影互逆，赤道和本初子午线在世界中心', () => {
  assert.deepEqual(project(0, 0, 0), [128, 128]);
  for (const [lng, lat, z] of [[117.98, 30.0, 8], [-73.9, 40.7, 3], [0, 0, 18]]) {
    const [x, y] = project(lng, lat, z), [lng2, lat2] = unproject(x, y, z);
    assert.ok(Math.abs(lng2 - lng) < 1e-9 && Math.abs(lat2 - lat) < 1e-9, `${lng},${lat}`);
  }
  assert.ok(metersToPx(1000, 0, 10) > 0 && metersToPx(1000, 60, 10) > metersToPx(1000, 0, 10)); // 高纬度一米占的像素更多
});

test('自适应范围：所有点落在容器里，留白之外', () => {
  const pts = [[120.12, 30.27], [118.27, 29.81], [117.98, 30.0], [117.0, 31.5]];
  const size = { width: 800, height: 500 };
  for (const padding of [{}, { top: 16, right: 420, bottom: 16, left: 16 }, { top: 100, right: 20, bottom: 300, left: 20 }]) {
    const { center, zoom } = fitView(pts, { ...size, padding });
    const pad = { top: 0, right: 0, bottom: 0, left: 0, ...padding };
    for (const [lng, lat] of pts) {
      const [x, y] = toScreen(lng, lat, { center, zoom, ...size });
      assert.ok(x >= pad.left - 0.5 && x <= size.width - pad.right + 0.5 && y >= pad.top - 0.5 && y <= size.height - pad.bottom + 0.5, `${JSON.stringify(padding)} ${x},${y}`);
    }
  }
  // 范围紧贴留白（至少有一个方向是满的），不是缩得很小
  const { center, zoom } = fitView(pts, { ...size, padding: { top: 10, right: 10, bottom: 10, left: 10 } });
  const sx = pts.map(([lng, lat]) => toScreen(lng, lat, { center, zoom, ...size }));
  const spanX = Math.max(...sx.map((p) => p[0])) - Math.min(...sx.map((p) => p[0])), spanY = Math.max(...sx.map((p) => p[1])) - Math.min(...sx.map((p) => p[1]));
  assert.ok(Math.abs(spanX - 780) < 1 || Math.abs(spanY - 480) < 1, `${spanX} ${spanY}`);
});

test('自适应范围：单个点用 maxZoom 并居中；容器没有尺寸返回 null；maxZoom 限制放大', () => {
  const one = fitView([[117.98, 30]], { width: 600, height: 400, maxZoom: 11 });
  assert.equal(one.zoom, 11);
  const [x, y] = toScreen(117.98, 30, { ...one, width: 600, height: 400 });
  assert.ok(Math.abs(x - 300) < 0.01 && Math.abs(y - 200) < 0.01);
  assert.equal(fitView([[1, 1]], { width: 0, height: 400 }), null);
  assert.equal(fitView([[1, 1]], { width: 400, height: 0 }), null);
  assert.equal(fitView([], { width: 400, height: 400 }), null);
  assert.equal(fitView([[117.98, 30], [117.981, 30.001]], { width: 600, height: 400, maxZoom: 12 }).zoom, 12);
});

test('标签取舍：重叠时留优先级高（数字小）的，同级先到先得，不重叠的都留', () => {
  const r = (l, t, w = 50, h = 20) => ({ left: l, top: t, right: l + w, bottom: t + h });
  assert.deepEqual(declutter([{ priority: 4, rect: r(0, 0) }, { priority: 0, rect: r(30, 5) }, { priority: 2, rect: r(200, 0) }]), [false, true, true]);
  assert.deepEqual(declutter([{ priority: 1, rect: r(0, 0) }, { priority: 1, rect: r(10, 0) }]), [true, false]);
  assert.deepEqual(declutter([{ priority: 1, rect: r(0, 0) }, { priority: 1, rect: r(50, 0) }]), [true, true]); // 只是挨着，不算重叠
  assert.deepEqual(declutter([]), []);
});

test('脚本打包：地图页面的脚本是不含 import/export 的普通脚本，能被解析，名字不冲突', () => {
  const code = bundleMap();
  assert.doesNotMatch(code, /^\s*(import|export)\b/m);
  assert.ok(code.includes('createAmapRenderer') && code.includes('createPlainRenderer') && code.includes('validateScene'));
  new vm.Script(code); // 语法和重复声明在这里报错（不执行）
  assert.doesNotMatch(code.replace(/^\s*\/\/.*$/gm, ''), /securityJsCode|_AMapSecurityConfig/, '只显示地图，不配安全密钥'); // 注释里提到不算
});

test('地图页面源文件：页面从 meta 取 Key，没有内嵌脚本，不带任何真实 Key', () => {
  const html = readFileSync('web/map.html', 'utf8');
  assert.match(html, /<meta name="amap-js-key" content="">/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.match(html, /<script src="\/map\/frame\.js"><\/script>/);
  for (const f of ['web/map.html', 'web/map/frame.js', 'web/map/amap-render.js', 'web/map/plain-render.js', 'web/map/scene.js']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\b[0-9a-f]{32}\b/, `${f} 里不能有像 Key 的字符串`);
  }
  assert.ok(existsSync('web/map/frame.css'));
});
