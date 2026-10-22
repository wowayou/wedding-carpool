// SPDX-License-Identifier: AGPL-3.0-or-later
// 编辑页地图 scene 的生成（web/editor/map-scene.js，纯函数）：给定 state，点、线、圈、图例、自适应范围对不对；生成的每份 scene 都能通过 web/map/scene.js 的校验。运行：npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { COLORS, LEGEND, SUG_LEGEND, composeScene, planParts, previewParts, sugFitPoints, sugParts } from './editor/map-scene.js';
import { validateScene } from './map/scene.js';

const CFG = {
  venue: { name: '宏村示例酒店', location: '117.98,30.0' },
  stations: [{ name: '黄山北站', location: '118.27,29.81' }, { name: '没定位的站' }, { name: '', location: '118.0,29.9' }],
  people: [{ name: '老王', car_seats: 3, location: '120.12,30.27' }, { name: '小李', location: '121.4,31.2' }, { name: '没填地点' }],
};

test('预览：目的地、已定位的车站和成员；经度在前；没定位的不画；标签优先级和高亮', () => {
  const p = previewParts(CFG);
  assert.deepEqual(p.points.map((x) => [x.kind, x.name]), [['venue', '宏村示例酒店'], ['st', '黄山北站'], ['st', '车站'], ['car', '老王（开车）'], ['home', '小李']]);
  assert.deepEqual([p.points[0].lng, p.points[0].lat], [117.98, 30.0]);
  assert.deepEqual(p.points.map((x) => x.priority), [0, 4, 4, 2, 3]);
  assert.deepEqual(p.points.map((x) => x.highlight), [true, false, false, true, true], '候选站只在悬停时显示名字');
  assert.deepEqual(p.points.map((x) => x.radius), [10, 6, 6, 7, 7]);
  assert.deepEqual([p.lines, p.circles], [[], []]);
  assert.equal(p.fit.points.length, 5);
  assert.equal(p.fit.maxZoom, 11);
  assert.deepEqual(previewParts({ venue: {}, stations: [], people: [] }).points, [], '什么都没定位：没有点');
  assert.equal(previewParts({ venue: { location: 'abc' } }).points.length, 0, '坐标不合法的不画');
});

// 方案：老王开车接黄山北站的人（绕 15 分钟），小李打车到黄山北站；返程是反过来
const PTS = {
  venue: { lat: 30.0, lng: 117.98, name: '宏村示例酒店' },
  'car:老王': { lat: 30.27, lng: 120.12, name: '老王' },
  'home:小李': { lat: 31.2, lng: 121.4, name: '小李' },
  'st:黄山北站': { lat: 29.81, lng: 118.27, name: '黄山北站' },
  'st:屯溪站': { lat: 29.7, lng: 118.3, name: '屯溪站' },
};
const ROUTE = { driver: '老王', stops: ['st:黄山北站'], detour: 15, minutes: 135, path: [[30.27, 120.12], [29.9, 119.0], [29.81, 118.27], [30.0, 117.98]], direct_path: [[30.27, 120.12], [30.0, 117.98]] };
const RESULT = (extra = {}) => ({ points: PTS, plans: [{ routes: [ROUTE], taxi: { 小李: 'st:黄山北站' } }], back: null, ...extra });
const VIEW = { viewLeg: 'out', active: 0, activeBack: 0 };

test('方案：直达虚线、车主路线、打车虚线；用到的站高亮；附注「多绕 X 分钟」；路径翻成 [lng, lat]', () => {
  const p = planParts(RESULT(), VIEW);
  assert.equal(p.lines.length, 3);
  const [direct, route, taxi] = p.lines;
  assert.deepEqual([direct.color, direct.dash, direct.weight, direct.opacity], ['--taxi', [6, 8], 4, 0.8]);
  assert.equal(direct.tooltip, '老王 不接人的直达路线');
  assert.deepEqual(direct.path, [[120.12, 30.27], [117.98, 30.0]]);
  assert.deepEqual([route.color, route.dash, route.weight], [COLORS[0], null, 5]);
  assert.equal(route.tooltip, '老王：多绕 15分钟，全程约 2小时15分');
  assert.deepEqual(route.path[2], [118.27, 29.81]);
  assert.deepEqual([taxi.color, taxi.dash, taxi.weight, taxi.tooltip], ['--taxi', [4, 6], 3, '小李 打车']);
  assert.deepEqual(taxi.path, [[118.27, 29.81], [117.98, 30.0]]);
  const by = Object.fromEntries(p.points.map((x) => [x.name, x]));
  assert.equal(p.points.length, 5);
  assert.deepEqual([by['黄山北站'].highlight, by['黄山北站'].radius, by['黄山北站'].priority], [true, 9, 1], '用到的站：高亮、大、优先级高');
  assert.deepEqual([by['屯溪站'].highlight, by['屯溪站'].radius, by['屯溪站'].priority], [false, 5, 4]);
  assert.deepEqual(by['黄山北站'].notes, ['老王 多绕 15分钟']);
  assert.equal(by['屯溪站'].notes, undefined);
  assert.deepEqual([by['宏村示例酒店'].kind, by['宏村示例酒店'].priority, by['老王'].kind, by['小李'].kind], ['venue', 0, 'car', 'home']);
  // 自适应：目的地、用到的站、路线和直达路线的坐标；不含没用到的站
  assert.ok(p.fit.points.some(([lng, lat]) => lng === 118.27 && lat === 29.81));
  assert.ok(!p.fit.points.some(([lng]) => lng === 118.3));
  assert.ok(p.fit.points.some(([lng, lat]) => lng === 120.12 && lat === 30.27));
});

test('方案：没有路线数据（path）时用点连线并画成虚线；直达的车主没有直达虚线；返程的顺序反过来', () => {
  const plain = { driver: '老王', stops: ['st:黄山北站'], detour: 5, minutes: 60 };
  const p = planParts(RESULT({ plans: [{ routes: [plain], taxi: {} }] }), VIEW);
  assert.equal(p.lines.length, 2);
  assert.deepEqual(p.lines[0].path, [[120.12, 30.27], [117.98, 30.0]], '直达：车主到目的地');
  assert.deepEqual(p.lines[1].path, [[120.12, 30.27], [118.27, 29.81], [117.98, 30.0]]);
  assert.deepEqual(p.lines[1].dash, [8, 8]);
  const direct = planParts(RESULT({ plans: [{ routes: [{ driver: '老王', stops: [], minutes: 90 }], taxi: {} }] }), VIEW);
  assert.equal(direct.lines.length, 1);
  assert.equal(direct.lines[0].tooltip, '老王：直达，全程约 1小时30分');
  const back = planParts(RESULT({ back: { plans: [{ routes: [plain], taxi: {} }] } }), { viewLeg: 'back', active: 0, activeBack: 0 });
  assert.equal(back.lines[0].tooltip, '老王 不送人直接回家的直达路线');
  assert.deepEqual(back.lines[0].path, [[117.98, 30.0], [120.12, 30.27]], '返程：目的地出发');
  assert.deepEqual(back.lines[1].path, [[117.98, 30.0], [118.27, 29.81], [120.12, 30.27]]);
  // 切到第二个方案
  const two = planParts(RESULT({ plans: [{ routes: [], taxi: {} }, { routes: [ROUTE, { ...ROUTE, driver: '老王' }], taxi: {} }] }), { ...VIEW, active: 1 });
  assert.deepEqual(two.lines.map((l) => l.color), ['--taxi', '--taxi', COLORS[0], COLORS[1]], '每个车主一种颜色');
});

const TRACE = {
  circles: [{ lat: 30, lng: 118, radius_km: 50 }, { lat: 31, lng: 119, radius_km: 20, searched: false }],
  routes: [{ path: [[30, 118], [30.5, 118.5]], alt: 1 }, { path: [[31, 119], [31.5, 119.5]], alt: 2 }],
};
const STATIONS = [{ name: '甲站', location: '118.1,30.1', listed: true }, { name: '乙站', location: '118.2,30.2' }, { name: '丙站' }, { name: '丁站', location: '118.3,30.3', listed: true, over_all: true }];

test('找站过程：圈（米）、点线路线、候选站只在悬停时显示名字；没搜的圈虚线加淡', () => {
  const p = sugParts(TRACE, STATIONS);
  assert.equal(p.circles.length, 2);
  assert.deepEqual(p.circles[0], { center: [118, 30], radius_m: 50000, color: '--station', weight: 1, opacity: 0.6, fillOpacity: 0.06, dash: null });
  assert.deepEqual([p.circles[1].opacity, p.circles[1].fillOpacity, p.circles[1].dash], [0.35, 0.02, [4, 4]]);
  assert.deepEqual(p.lines.map((l) => [l.color, l.dash, l.opacity]), [['--drive', [2, 7], 0.9], ['--drive', [2, 7], 0.45]]);
  assert.deepEqual(p.lines[0].path, [[118, 30], [118.5, 30.5]]);
  assert.deepEqual(p.points.map((x) => [x.name, x.radius, x.highlight, x.label]),
    [['甲站', 6, true, 'hover'], ['乙站', 4, false, 'hover'], ['丁站', 6, false, 'hover']], '列出且没超所有车主上限的实心，其余半透明；标签都只在悬停时显示；没坐标的不画');
  assert.equal(sugParts(null, STATIONS), null);
});

test('找站过程要框住的位置：圈的外框、路线、候选站；没有就是 null', () => {
  const pts = sugFitPoints(TRACE, STATIONS);
  const lngs = pts.map((x) => x[0]), lats = pts.map((x) => x[1]);
  assert.ok(Math.min(...lngs) < 118 - 0.4 && Math.max(...lats) > 31.15, '圈的半径换成了经纬度范围');
  assert.ok(pts.some(([lng, lat]) => lng === 118.1 && lat === 30.1));
  assert.equal(sugFitPoints(null, []), null);
  assert.equal(sugFitPoints({ circles: [], routes: [] }, [{ name: 'x' }]), null);
});

test('合成 scene：找站的圈和线排在方案前面（画在下面）；图例；theme；fit 要求；生成的 scene 都合法', () => {
  const base = planParts(RESULT(), VIEW), sug = sugParts(TRACE, STATIONS);
  const both = composeScene({ base, sug, theme: 'dark', fit: null });
  assert.deepEqual(validateScene(both), []);
  assert.equal(both.theme, 'dark');
  assert.equal(both.circles.length, 2);
  assert.equal(both.lines.length, 3 + 2);
  assert.equal(both.lines[0].dash[0], 2, '找站的路线在前，方案的在后');
  assert.equal(both.points.length, 5 + 3);
  assert.equal(both.points[0].name, '甲站');
  assert.deepEqual(both.legend, [...LEGEND, ...SUG_LEGEND]);
  assert.deepEqual(both.fit, { auto: false });
  const only = composeScene({ base, sug: null, theme: 'light', fit: null });
  assert.deepEqual(only.legend, LEGEND);
  assert.equal(only.circles.length, 0);
  // fit：数字留白四边一样；对象原样（抽屉遮住的那一截）；maxZoom
  const f1 = composeScene({ base, sug: null, theme: 'light', fit: { points: [[118, 30], [119, 31]], padding: 24, maxZoom: 11 } }).fit;
  assert.deepEqual(f1, { auto: true, points: [[118, 30], [119, 31]], padding: { top: 24, right: 24, bottom: 24, left: 24 }, maxZoom: 11 });
  const f2 = composeScene({ base, sug, theme: 'light', fit: { points: [[118, 30]], padding: { top: 16, right: 436, bottom: 16, left: 16 }, maxZoom: 12 } }).fit;
  assert.equal(f2.padding.right, 436);
  assert.equal(composeScene({ base, sug, theme: 'light', fit: { points: [] } }).fit.auto, false, '没有要框的位置就不自适应');
  for (const scene of [composeScene({ base: previewParts(CFG), sug: null, theme: 'light', fit: previewParts(CFG).fit }), composeScene({ base: null, sug, theme: 'light' }), composeScene({ base: null, sug: null, theme: 'light' })]) {
    assert.deepEqual(validateScene(scene), []);
  }
});
