// SPDX-License-Identifier: AGPL-3.0-or-later
// 地图页面（/map、/map/share）的「要画什么」：scene 的格式、校验和消息类型。
// 外面的页面（编辑页、示例页、方案页）生成 scene，用 postMessage 交给地图页面；地图页面画完回报。
// 这个文件同时被浏览器（地图页面的脚本打包时并进去，编辑页以后直接 import）和 node 测试使用，所以不碰 DOM。
//
// 坐标一律是高德坐标（GCJ-02）的 [lng, lat]（经度在前）。
//
// scene = {
//   v: 1,
//   theme: 'light' | 'dark',                       // 深色用高德自带的深色样式；颜色变量跟着换
//   points: [{
//     lng, lat,                                    // 位置
//     kind: 'venue' | 'st' | 'car' | 'home',       // 目的地 / 车站 / 开车的成员 / 不开车的成员，决定颜色（--dest/--station/--drive/--ride）
//     name,                                        // 标签文字
//     notes?: string[],                            // 附注，每条一行，接在名字后面
//     priority?: number,                           // 标签互相遮挡时数字小的优先留下，默认 5
//     highlight?: boolean,                         // 填充：true 实心，false 半透明。默认 true
//     label?: 'always' | 'hover',                  // 标签：always 一直显示（互相遮挡时按优先级取舍），hover 只在悬停时显示。默认按 highlight 推出（true 为 always，false 为 hover）
//     radius?: number,                             // 圆点半径（像素），默认按 kind
//   }],
//   lines: [{
//     path: [[lng, lat], …],                       // 至少两个点
//     color: '#rrggbb' | '--设计变量名',            // 设计变量在地图页面里取值（深色自动换）
//     weight?: number, opacity?: number,           // 线宽（像素）、不透明度 0–1
//     dash?: [number, number] | null,              // 虚线：[实, 空]（像素）
//     tooltip?: string,                            // 悬停时显示的文字
//   }],
//   circles: [{
//     center: [lng, lat], radius_m,                // 圆心、半径（米）
//     color, weight?, opacity?,                    // 边线
//     fillOpacity?: number,                        // 填充不透明度，填充色同边线色
//     dash?: [number, number] | null,
//   }],
//   fit?: {
//     auto: boolean,                               // 收到这份 scene 后是否自适应范围
//     padding?: { top, right, bottom, left },      // 四边留白（像素），比如被抽屉遮住的那一截
//     points?: [[lng, lat], …],                    // 要框住的位置；不写就框住全部点、线、圈的圆心
//     maxZoom?: number,
//   },
//   legend?: [                                     // 图例，一行一项
//     { type: 'dot', color, text }                 // 色块 + 文字
//     | { type: 'line', color, dash?, text }       // 线样式 + 文字
//     | { type: 'circle', color, text }            // 圈 + 文字
//   ],
// }
//
// 消息（都是 { type, … } 的普通对象）：
//   外 → 内：{ type: 'scene', scene }  要画的内容（整份替换）；{ type: 'resize' }  容器尺寸变了（手机页签切换等）
//   内 → 外：{ type: 'ready' }  可以接收了；{ type: 'drawn', renderer: 'amap' | 'plain', points, lines, circles }  画完（带实际用的画法和个数）；
//            { type: 'fail', reason }  高德 JS API 没加载出来（随后会改用 plain 并回报 drawn），或者 scene 不合法（不会画）

export const SCENE_VERSION = 1;
export const MSG = { SCENE: 'scene', RESIZE: 'resize', READY: 'ready', DRAWN: 'drawn', FAIL: 'fail' };
export const KINDS = ['venue', 'st', 'car', 'home'];
export const THEMES = ['light', 'dark'];
export const RENDERERS = ['amap', 'plain'];
// 点的颜色取自设计变量（design.css）
export const POINT_VARS = { venue: '--dest', st: '--station', car: '--drive', home: '--ride' };
export const DEFAULT_RADIUS = { venue: 10, st: 6, car: 7, home: 7 };
export const DEFAULT_PRIORITY = 5;
export const LABEL_MODES = ['always', 'hover'];
// 标签是不是一直显示：label 写了就按它，没写按 highlight 推出
export const labelAlways = (p) => (p.label ? p.label === 'always' : p.highlight !== false);

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isLngLat = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
const isColor = (c) => typeof c === 'string' && (/^#[0-9a-fA-F]{3,8}$/.test(c) || /^--[a-z0-9-]+$/.test(c));
const isDash = (d) => d === undefined || d === null || (Array.isArray(d) && d.length === 2 && d.every((x) => isNum(x) && x >= 0));
const isOpacity = (n) => n === undefined || (isNum(n) && n >= 0 && n <= 1);
const isPos = (n) => n === undefined || (isNum(n) && n > 0);

// 校验 scene，返回问题清单（空数组表示合法）。只看格式，不改它
export function validateScene(scene) {
  const errs = [];
  const bad = (msg) => errs.push(msg);
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return ['scene 不是对象'];
  if (scene.v !== SCENE_VERSION) bad(`v 必须是 ${SCENE_VERSION}`);
  if (!THEMES.includes(scene.theme)) bad('theme 只能是 light 或 dark');
  for (const key of ['points', 'lines', 'circles']) if (!Array.isArray(scene[key])) bad(`${key} 必须是数组`);
  (Array.isArray(scene.points) ? scene.points : []).forEach((p, i) => {
    const at = `points[${i}]`;
    if (!p || typeof p !== 'object') return bad(`${at} 不是对象`);
    if (!isLngLat([p.lng, p.lat])) bad(`${at} 的 lng/lat 不是有效的经纬度`);
    if (!KINDS.includes(p.kind)) bad(`${at} 的 kind 只能是 ${KINDS.join('/')}`);
    if (typeof p.name !== 'string') bad(`${at} 的 name 必须是字符串`);
    if (p.notes !== undefined && !(Array.isArray(p.notes) && p.notes.every((n) => typeof n === 'string'))) bad(`${at} 的 notes 必须是字符串数组`);
    if (p.priority !== undefined && !isNum(p.priority)) bad(`${at} 的 priority 必须是数字`);
    if (p.highlight !== undefined && typeof p.highlight !== 'boolean') bad(`${at} 的 highlight 必须是布尔值`);
    if (p.label !== undefined && !LABEL_MODES.includes(p.label)) bad(`${at} 的 label 只能是 ${LABEL_MODES.join('/')}`);
    if (!isPos(p.radius)) bad(`${at} 的 radius 必须是正数`);
  });
  (Array.isArray(scene.lines) ? scene.lines : []).forEach((l, i) => {
    const at = `lines[${i}]`;
    if (!l || typeof l !== 'object') return bad(`${at} 不是对象`);
    if (!(Array.isArray(l.path) && l.path.length >= 2 && l.path.every(isLngLat))) bad(`${at} 的 path 要至少两个 [lng, lat]`);
    if (!isColor(l.color)) bad(`${at} 的 color 要写 #十六进制 或 --设计变量名`);
    if (!isPos(l.weight)) bad(`${at} 的 weight 必须是正数`);
    if (!isOpacity(l.opacity)) bad(`${at} 的 opacity 要在 0 到 1 之间`);
    if (!isDash(l.dash)) bad(`${at} 的 dash 要写 [实, 空] 或 null`);
    if (l.tooltip !== undefined && typeof l.tooltip !== 'string') bad(`${at} 的 tooltip 必须是字符串`);
  });
  (Array.isArray(scene.circles) ? scene.circles : []).forEach((c, i) => {
    const at = `circles[${i}]`;
    if (!c || typeof c !== 'object') return bad(`${at} 不是对象`);
    if (!isLngLat(c.center)) bad(`${at} 的 center 不是有效的 [lng, lat]`);
    if (!(isNum(c.radius_m) && c.radius_m > 0)) bad(`${at} 的 radius_m 必须是正数（米）`);
    if (!isColor(c.color)) bad(`${at} 的 color 要写 #十六进制 或 --设计变量名`);
    if (!isPos(c.weight)) bad(`${at} 的 weight 必须是正数`);
    if (!isOpacity(c.opacity) || !isOpacity(c.fillOpacity)) bad(`${at} 的 opacity/fillOpacity 要在 0 到 1 之间`);
    if (!isDash(c.dash)) bad(`${at} 的 dash 要写 [实, 空] 或 null`);
  });
  if (scene.fit !== undefined) {
    const f = scene.fit;
    if (!f || typeof f !== 'object') bad('fit 不是对象');
    else {
      if (typeof f.auto !== 'boolean') bad('fit.auto 必须是布尔值');
      if (f.padding !== undefined && !(f.padding && ['top', 'right', 'bottom', 'left'].every((k) => isNum(f.padding[k]) && f.padding[k] >= 0))) bad('fit.padding 要有 top/right/bottom/left 四个非负数');
      if (f.points !== undefined && !(Array.isArray(f.points) && f.points.every(isLngLat))) bad('fit.points 必须是 [lng, lat] 数组');
      if (!isPos(f.maxZoom)) bad('fit.maxZoom 必须是正数');
    }
  }
  if (scene.legend !== undefined) {
    if (!Array.isArray(scene.legend)) bad('legend 必须是数组');
    else scene.legend.forEach((row, i) => {
      const at = `legend[${i}]`;
      if (!row || typeof row !== 'object') return bad(`${at} 不是对象`);
      if (!['dot', 'line', 'circle'].includes(row.type)) bad(`${at} 的 type 只能是 dot/line/circle`);
      if (!isColor(row.color)) bad(`${at} 的 color 要写 #十六进制 或 --设计变量名`);
      if (typeof row.text !== 'string') bad(`${at} 的 text 必须是字符串`);
      if (!isDash(row.dash)) bad(`${at} 的 dash 要写 [实, 空] 或 null`);
    });
  }
  return errs;
}

// 要框住的位置：fit.points，没写就是全部点、线的坐标和圈的圆心
export function fitTargets(scene) {
  if (scene.fit?.points?.length) return scene.fit.points;
  return [
    ...scene.points.map((p) => [p.lng, p.lat]),
    ...scene.lines.flatMap((l) => l.path),
    ...scene.circles.map((c) => c.center),
  ];
}
export const DEFAULT_PADDING = 16; // 没写 fit.padding 时四边各留 16 像素
export const fitPadding = (scene) => ({ top: DEFAULT_PADDING, right: DEFAULT_PADDING, bottom: DEFAULT_PADDING, left: DEFAULT_PADDING, ...(scene.fit?.padding || {}) });
export const DEFAULT_MAX_ZOOM = 16;
