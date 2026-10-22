// ---------- 地图：没算方案时实时显示已定位的地点；算出方案后画路线 ----------
// 地图画在同源 iframe 里的地图页面（/map，见 web/map/）。这里只负责：根据 state 生成 scene（map-scene.js），
// 用 postMessage 发给它；收它的 ready / drawn / fail；容器尺寸变了发 resize。编辑页自己的安全策略因此不用放宽。

import { isStale, state } from './state.js';
import { $ } from './util.js';
import { composeScene, planParts, previewParts } from './map-scene.js';

export { COLORS } from './map-scene.js';

// 地图的 iframe 和状态。frame 是 null 表示还没建；ready 表示地图页面已经能接收 scene
export const view = { frame: null, ready: false };

const READY_TIMEOUT_MS = 10_000; // 地图页面这么久没报 ready：当作没加载出来（显示「重试」）
const DRAWN_TIMEOUT_MS = 20_000; // 地图页面报了 fail（高德没加载出来）以后，这么久还没画出来（plain）：同上

// 要画的内容：预览和方案各存一份，showLayers 决定显示哪个；找站图层由 sug-layer.js 通过 setSugLayer 放进来
const layers = { preview: null, plan: null, sug: null, show: 'preview' };
let pendingFit = null; // 还没发出去的自适应请求（地图页面没 ready 时留着，发出去就清掉）
let dirty = false; // 有还没发出去的改动
let scheduled = false;

// 测试用：回到刚启动的样子
export function resetMap() {
  Object.assign(layers, { preview: null, plan: null, sug: null, show: 'preview' });
  pendingFit = null; dirty = false; scheduled = false;
  view.frame = null; view.ready = false;
}

const theme = () => document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const post = (msg) => view.frame?.contentWindow?.postMessage(msg, location.origin);

// 把最新的 scene 发给地图页面（没 ready 就等 ready 以后再发）
export function sendScene() {
  scheduled = false;
  if (!view.frame || !view.ready || !dirty) return;
  const base = layers[layers.show] || layers.preview;
  post({ type: 'scene', scene: composeScene({ base, sug: layers.sug, theme: theme(), fit: pendingFit }) });
  pendingFit = null;
  dirty = false;
}
// 一次操作里常常连着改几处（画方案、显示图层、请求缩放），合并成一条消息
function schedule() {
  dirty = true;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(sendScene);
}

export function showLayers() {
  layers.show = state.result && !isStale() ? 'plan' : 'preview';
  schedule();
}
// 找站图层：parts 是 sugParts 的结果；null 表示不显示
export function setSugLayer(parts) {
  layers.sug = parts;
  schedule();
}
// 请求缩放到指定位置。地图在隐藏的页签里（0 尺寸）时，地图页面会记下来，等 resize 了再补做
export function requestFit(fit) {
  pendingFit = fit;
  schedule();
}
// 地图变得可见、尺寸变了以后调用（手机页签切到「地图」、窄宽屏切换）：地图页面重算尺寸，再补做没做完的缩放
export function refreshMap() {
  post({ type: 'resize' });
}

let previewTimer = null;
export function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 250); }

export function drawPreview() {
  if (!view.frame || !state.cfg) return;
  layers.preview = previewParts(state.cfg);
  if (!state.fitted && layers.preview.points.length) {
    requestFit(layers.preview.fit);
    state.fitted = true;
  }
  showLayers();
}

export function drawPlan(fit) {
  if (!view.frame) return;
  layers.plan = planParts(state.result, state);
  if (fit) requestFit(layers.plan.fit);
  showLayers();
}

// ---------- 地图页面（iframe）的加载和消息 ----------

const mapFailBox = () => $('#mapFail');
let readyTimer = null, drawnTimer = null;
const failed = () => { mapFailBox().hidden = false; };

function onMessage(e) {
  if (!view.frame || e.source !== view.frame.contentWindow || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'ready') {
    clearTimeout(readyTimer);
    view.ready = true;
    mapFailBox().hidden = true;
    if (layers.preview || layers.plan) schedule(); // 把已经有的内容发过去（重试时是新的 iframe，要重发）
  } else if (e.data.type === 'drawn') {
    clearTimeout(drawnTimer);
    mapFailBox().hidden = true;
  } else if (e.data.type === 'fail' && !String(e.data.reason).startsWith('bad-scene')) {
    // 高德 JS API 没加载出来：地图页面会改用不带底图的画法并回报 drawn；到点还没画出来才算失败
    clearTimeout(drawnTimer);
    drawnTimer = setTimeout(failed, DRAWN_TIMEOUT_MS);
  }
}

let listening = false;
// 地图页面没加载出来也不影响填写和计算：地图区显示说明和「重试」（再调一次就是重试：重新加载 iframe）
export function initMap() {
  if (!listening) { window.addEventListener('message', onMessage); listening = true; }
  clearTimeout(readyTimer);
  clearTimeout(drawnTimer);
  mapFailBox().hidden = true;
  const frame = document.createElement('iframe');
  frame.className = 'ed-mapframe';
  frame.title = '地图';
  frame.src = '/map';
  view.frame = frame;
  view.ready = false;
  $('#map').replaceChildren(frame);
  readyTimer = setTimeout(failed, READY_TIMEOUT_MS);
  return true;
}
