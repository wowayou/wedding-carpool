// 拼车出行规划的编辑器：启动入口。本地版（python3 ui.py）、在线版（Cloudflare Worker，/t/<行程>）和试玩（/try）共用这个页面：
// 本地版由 ui.py 计算、手动保存；在线版在浏览器里用 Pyodide 计算，多人实时同步，有历史版本；试玩是固定的示例行程。
// 只有这个文件和 backend.js 判断「现在是哪种模式」；其他模块问 caps 能力表（见 backend.js 的 capsFor）。
// 其他模块在导入时都不碰页面，页面上的事全从这里开始。

import { backend, editKey, hooks, initBackend, plainApi } from './backend.js';
import { caps } from './caps.js';
import { loadFields } from './fields.js';
import { refreshDerived } from './form.js';
import { initMap } from './map.js';
import { askName, deny, installOverlayKeys } from './overlay.js';
import { load12306 } from './rail12306.js';
import { renderEmptyPlan, setupMarked } from './results.js';
import { me, state } from './state.js';
import { initSugLayer } from './sug-layer.js';
import { askCode, connectSync, startPing, tripGone } from './sync.js';
import { loadConfig, rememberTrip } from './trip.js';
import { $, esc, store } from './util.js';
import { bindEvents } from './wire.js';

// 本地版问 /api/env 得到 local；在线站点得到 online，其中 /try 是试玩
async function detectMode() {
  let mode = (await plainApi('/api/env').catch(() => ({ mode: 'local' }))).mode;
  if (mode === 'online' && /^\/try(\.html)?$/.test(location.pathname)) mode = 'try'; // 在线站点的 /try：示例行程，不连行程接口
  return mode;
}

async function boot() {
  initBackend('local'); // 先按本地版的样子，等问到模式再换
  Object.assign(hooks, { gone: tripGone, deny, askCode }); // 在线版遇到「行程没了」「链接无效」「要输口令」时弹整页遮罩
  me.name = store.get('carpool_name', '');
  setupMarked();
  installOverlayKeys();
  initSugLayer(); // 要在建地图之前订阅
  bindEvents();
  startPing();
  initMap();
  renderEmptyPlan();
  load12306().then(() => { if (state.cfg) refreshDerived(); });
  window.__editorReady?.(); // 通知 index 里的兜底脚本：主模块已经跑起来了，不用显示「页面没加载出来」

  const mode = await detectMode();
  initBackend(mode);
  document.body.classList.toggle('online', mode === 'online'); // 页面样式按模式显示和隐藏（.online-only、.try-only 等）
  document.body.classList.toggle('try', mode === 'try');
  $('#sharebtn').textContent = caps.text.publishLabel;
  try {
    await loadFields();
    if (caps.hasTrip) {
      state.tripId = location.pathname.match(/^\/t\/([a-z2-9]{10})/)?.[1];
      if (!state.tripId) { location.href = '/'; return; }
      const key = editKey();
      if (key) {
        await backend.session().catch(async (e) => {
          if (!/^EDIT_CODE_/.test(e.data?.info)) throw e;
          await askCode(); // 设了编辑口令：输对才继续加载
        });
      }
      await loadConfig();
      rememberTrip(key);
      if (!me.name) await askName();
      connectSync();
    } else {
      await loadConfig();
    }
  } catch (e) {
    if (e.status !== 401 && !e.gone) $('#form').innerHTML = `<div class="c-alert c-alert--danger" style="margin:16px"><div>读取失败：${esc(e.message)}</div></div>`;
  }
}

boot();
