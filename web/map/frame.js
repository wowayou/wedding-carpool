// SPDX-License-Identifier: AGPL-3.0-or-later
// 地图页面（/map、/map/share）的入口：收 scene、选画法、画、回报。消息格式见 scene.js。
// 构建时（web/map/bundle.mjs）把 scene、mercator、declutter、两种画法和这个文件并成一个普通脚本：
// 方案页的沙箱里页面来源是 null，ES 模块脚本要 CORS 才能加载，普通脚本不用。
import { createAmapRenderer } from './amap-render.js';
import { createPlainRenderer } from './plain-render.js';
import { MSG, validateScene } from './scene.js';

const AMAP_TIMEOUT_MS = 10_000;
// /map：只接受同源的父窗口；/map/share：嵌它的方案页在沙箱里，来源是 null，只认「消息是父窗口发的」。两者是同一份页面，按路径区分
const isShare = location.pathname.replace(/\/$/, '') === '/map/share';
const fromParent = (e) => e.source === window.parent && window.parent !== window && (isShare || e.origin === location.origin);
const send = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, isShare ? '*' : location.origin); };

const box = document.getElementById('map');
const tipEl = document.getElementById('tip');
const legendEl = document.getElementById('legend');

const rootStyle = () => getComputedStyle(document.documentElement);
let measureCtx = null;
const host = {
  container: box,
  color: (c) => (c.startsWith('--') ? rootStyle().getPropertyValue(c).trim() : c),
  measure(text, font = `12px ${rootStyle().getPropertyValue('--font').trim() || 'sans-serif'}`) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const lines = text.split('\n');
    return { width: Math.max(...lines.map((l) => measureCtx.measureText(l).width)) + 14, height: lines.length * 17 + 4 };
  },
  showTip(text, x, y) {
    tipEl.textContent = text;
    tipEl.hidden = false;
    tipEl.style.left = `${Math.min(x + 12, window.innerWidth - tipEl.offsetWidth - 4)}px`;
    tipEl.style.top = `${y + 12}px`;
  },
  hideTip() { tipEl.hidden = true; },
};

// 加载高德 JS API：脚本加载失败，或 10 秒内没有 AMap.Map，都算失败
function loadAmap(key) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearInterval(poll); clearTimeout(timer); resolve(ok); } };
    const ready = () => Boolean(window.AMap && window.AMap.Map);
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onerror = () => finish(false);
    const poll = setInterval(() => { if (ready()) finish(true); }, 100);
    const timer = setTimeout(() => finish(ready()), AMAP_TIMEOUT_MS);
    document.head.append(script);
  });
}

let amapOk = false; // 高德 JS API 可用
let settled = false; // 已经决定用哪种画法
let queued = null; // 决定之前收到的 scene
let renderer = null;
let current = null; // 最近一份 scene
let pendingFit = null; // 容器 0 尺寸时没能做的自适应（只记 fit 的要求；后来要求自适应的覆盖先前的，没要求自适应的 scene 不取消它），有尺寸了补做

function makeRenderer(theme) {
  if (amapOk) {
    try { return createAmapRenderer(host, theme); } catch (err) {
      amapOk = false;
      box.replaceChildren(); // 半路建失败的地图容器清掉
      send({ type: MSG.FAIL, reason: `amap-init: ${err?.message || err}` });
    }
  }
  return createPlainRenderer(host);
}

function drawLegend(scene) {
  legendEl.replaceChildren();
  const rows = scene.legend || [];
  legendEl.hidden = !rows.length;
  for (const row of rows) {
    const div = document.createElement('div');
    const mark = document.createElement('i');
    mark.className = `lg-${row.type}`;
    const color = host.color(row.color);
    if (row.type === 'dot') mark.style.background = color;
    else if (row.type === 'circle') mark.style.borderColor = color;
    else mark.style.borderTop = `3px ${row.dash ? 'dashed' : 'solid'} ${color}`;
    div.append(mark, row.text);
    legendEl.append(div);
  }
}

function doFit(scene) { pendingFit = renderer.fit(scene) ? null : scene.fit; }

function show(scene) {
  current = scene;
  document.documentElement.dataset.theme = scene.theme; // 设计变量跟着换成深色或浅色的值
  renderer ??= makeRenderer(scene.theme);
  document.documentElement.dataset.renderer = renderer.kind; // CSS 据此把图例抬到高德标识和审图号上面
  renderer.setTheme(scene.theme);
  drawLegend(scene);
  const counts = renderer.draw(scene);
  if (scene.fit?.auto) doFit(scene); // 没要求自适应的 scene 不动视野，也不取消还没做完的自适应（编辑页算完方案后紧接着还会重发 scene）
  send({ type: MSG.DRAWN, renderer: renderer.kind, ...counts });
}

function onScene(scene) {
  const errs = validateScene(scene);
  if (errs.length) return send({ type: MSG.FAIL, reason: `bad-scene: ${errs.slice(0, 5).join('；')}` });
  if (!settled) queued = scene;
  else show(scene);
}

// 容器尺寸变了（手机页签切换）：重算尺寸，再补做没能做的自适应
function onResize() {
  if (!renderer) return;
  renderer.resize();
  if (pendingFit) doFit({ ...current, fit: pendingFit }); // 用最近的内容，加上当时要求的 fit（没写 points 就框住现在的全部）
}

window.addEventListener('message', (e) => {
  if (!fromParent(e) || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === MSG.SCENE) onScene(e.data.scene);
  else if (e.data.type === MSG.RESIZE) onResize();
});
window.addEventListener('resize', onResize);

async function boot() {
  send({ type: MSG.READY });
  const key = (document.querySelector('meta[name="amap-js-key"]')?.content || '').trim();
  if (key) {
    amapOk = await loadAmap(key);
    if (!amapOk) send({ type: MSG.FAIL, reason: 'amap-load' });
  }
  settled = true;
  if (queued) { const s = queued; queued = null; show(s); }
}
boot();
