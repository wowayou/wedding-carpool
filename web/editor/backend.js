// 后端接口和三种实现。页面里「这个模式怎么做」的分支都收在这个文件（和启动入口 main.js）里，其他模块只调 backend 的方法、读 caps 能力表。
//   local   本地版（python3 ui.py）：计算、搜索、保存、生成方案页都调 ui.py 的接口
//   online  在线版（/t/<行程>）：在浏览器里用 Pyodide 计算，保存、同步、历史、发布调 Worker 的接口
//   try     试玩（/try）：示例行程，在浏览器里用不联网的 TryAmap 计算；不保存、不实际搜索、不发布
// 三种实现有同一组方法（见 createBackend）；这个模式没有的功能（比如本地版没有历史）调用时会报错，界面按 caps 把入口藏起来，不会走到。

import { setCaps } from './caps.js';
import { updateProgress } from './progress.js';
import { load12306 } from './rail12306.js';
import { state, trip } from './state.js';
import { bj, bjDate } from './time.js';
import { store } from './util.js';

// ---------- 能力表：启动时按模式生成一次 ----------
export function capsFor(mode) {
  const online = mode === 'online', sample = mode === 'try';
  return {
    canSave: !sample, // 能保存（本地写配置文件，在线存到服务器）
    liveSync: online, // 多人实时同步：自动保存、WebSocket、冲突合并
    hasHistory: online, // 有历史版本
    hasTrip: online, // 有行程身份：行程名称、编辑链接、保留期、口令、高德额度、删除
    canSearch: !sample, // 能实际搜索（地点搜索、推荐车站的「开始找」）
    canImport: !sample, // 能导入配置
    canPublish: !sample, // 能发布或生成方案页
    fixedSample: sample, // 固定示例：地址只读，不能加成员和车站，也没有搜索
    quota: online, // 用站点的公共高德额度，额度用完要提示
    computeInBrowser: online || sample, // 在浏览器里算（Pyodide），不是调本机的 ui.py
    text: {
      // 按模式不同的文案
      publishLabel: online ? '发布方案页' : '生成方案页',
      title: (t) => (online ? t.name || '未命名行程' : sample ? '试玩：拼车出行规划' : '拼车出行规划'),
      status: (t) => (sample ? '试玩 · 改动不保存，刷新后回到示例' : online ? null : t.file ? `本地 · ${t.file}` : '本地'), // null：在线版的状态要看连接和同步
      noTrainHint: (minutes) => (sample ? `全部留空时，每个站都按默认的 ${minutes} 分钟算。` : '全部留空时改用高德估算：不含火车换乘，可能很不准。'),
      deleteHint: sample ? '点页面上方的「恢复示例」可以找回。' : '在线版可以在「历史」里找回。',
      importConfirm: online ? '旧内容会留在「历史」里。' : '现在的内容会被覆盖。',
      importNote: online ? '，旧内容留在「历史」里' : '',
      noSearchWhy: sample ? '试玩不能实际搜索，新建行程后就能用。' : '',
      published: (combo, r) => (online ? `${combo} 已发布，链接已复制。重新发布会更新同一个链接` : `${combo} 已生成：${r.file}`),
    },
  };
}

// ---------- 请求 ----------
// 在线版遇到「行程没了」「编辑链接无效」「要输口令」时要弹整页遮罩，这些界面在上层模块里，由 main.js 启动时挂进来
export const hooks = { gone() {}, deny() {}, askCode: async () => {} };

export async function request(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('网络连不上，稍后再试'); }
  const data = await res.json().catch(() => ({ error: res.statusText }));
  return { res, data };
}
export const fail = (res, data) => Object.assign(new Error(data.error || res.statusText), { status: res.status, data });

// 本地版和试玩用的普通请求（启动时问 /api/env 也用它）
export async function plainApi(path, body) {
  const { res, data } = await request(path, body);
  if (!res.ok) throw fail(res, data);
  return data;
}

export async function onlineApi(path, body) {
  const { res, data } = await request(path, body);
  if (data.info === 'TRIP_GONE') { hooks.gone(); throw Object.assign(new Error(data.error || '这个行程已经删除或到期'), { status: res.status, data, gone: true }); }
  if (res.status === 401) {
    if (!/^EDIT_CODE_/.test(data.info)) hooks.deny(data.error || '编辑链接无效或已失效');
    else if (!path.endsWith('/session')) { await hooks.askCode(); return onlineApi(path, body); } // 口令变了：输对后把这次请求再发一遍
  }
  if (!res.ok) throw fail(res, data);
  return data;
}

// 编辑链接里的钥匙：地址 # 后面的 k，没有就取这台设备记住的
export const editKey = () => new URLSearchParams(location.hash.slice(1)).get('k') || store.get('carpool_trips', []).find((t) => t.id === state.tripId)?.key;

// ---------- 计算环境：Web Worker 里的 Pyodide（web/pyworker.js）。在线版和试玩共用 ----------
export function createPy(initArgs) {
  let pyWorker = null, pyCalls = 0;
  const pending = new Map();
  // 计算环境（Pyodide）没加载出来：丢掉这个线程，下次调用会重新创建，这样「重试」才有用
  const reset = () => { try { pyWorker?.terminate(); } catch { /* 已经结束 */ } pyWorker = null; };
  const failEnv = (msg) => {
    for (const { reject } of pending.values()) reject(Object.assign(new Error(msg), { envFail: true }));
    pending.clear();
    reset();
  };
  return function py(method, args) {
    if (!pyWorker) {
      updateProgress({ label: '下载计算环境（第一次约 12MB）', done: null, total: null });
      pyWorker = new Worker('/pyworker.js', { type: 'module' });
      pyWorker.onerror = (e) => failEnv(`计算环境加载失败：${e.message || '网络问题，或文件没下载完整'}`); // 把等待中的调用都结束掉，别一直转圈
      pyWorker.onmessage = (e) => {
        if (e.data.progress) { updateProgress(e.data.progress); return; }
        const { id, result: out } = e.data;
        const wait = pending.get(id);
        if (!wait) return;
        pending.delete(id);
        if (out && /^计算环境出错/.test(out.error || '')) { wait.reject(Object.assign(new Error(out.error), { envFail: true })); reset(); return; }
        out && out.error ? wait.reject(new Error(out.error)) : wait.resolve(out);
      };
      pyWorker.postMessage({ id: 0, method: 'init', args: initArgs() });
    }
    return new Promise((resolve, reject) => {
      const id = ++pyCalls;
      pending.set(id, { resolve, reject });
      pyWorker.postMessage({ id, method, args });
    });
  };
}

// 在浏览器里算的两种实现共用：计算、找地点、找站、生成方案页的内容都在 Pyodide 里
export const inBrowser = (py) => ({
  plan: (config) => py('plan', { config }),
  search: (q, city, station) => py('search', { q, city, station }),
  // planOnly：只估算（查车主路线、算出搜索圈和次数），不做地点搜索；试玩也能用
  async suggest(config, planOnly = false) {
    const data = (await load12306()) || {};
    return py('suggest', { config, valid_names: Object.keys(data.stations || {}), plan_only: planOnly });
  },
});

// 这个模式没有的功能
export const NOT_HERE = ['syncPath', 'session', 'history', 'historyAt', 'restore', 'shareSettings', 'setEditCode', 'rotateKey', 'rename', 'deleteTrip', 'setOwnKey'];
export const unsupported = () => Object.fromEntries(NOT_HERE.map((name) => [name, async () => { throw new Error('这个功能只在在线版可用'); }]));

// ---------- 三种实现 ----------
// 方法（每种实现都有）：
//   loadConfig()                 → { config, version, trip }：取配置；trip 是要并进行程信息的字段
//   saveConfig(config, meta)     → 保存；在线版的 meta 是 { base_version, client_id, author, note }
//   plan(config)                 → 算方案
//   search(q, city, station)     → { results }：找地点；station 为真时只搜火车站
//   suggest(config, planOnly)    → 推荐车站（planOnly：只估算）
//   share(plan, backPlan)        → { url, file?, share? }：发布（在线）或生成（本地）方案页，url 是页面地址
// 只有在线版有的方法见 NOT_HERE：syncPath、session、history、historyAt、restore、shareSettings、setEditCode、rotateKey、rename、deleteTrip、setOwnKey
export function localBackend() {
  return {
    ...unsupported(),
    async loadConfig() {
      const data = await plainApi('/api/config');
      return { config: data.config, version: data.version ?? null, trip: { file: data.file } };
    },
    saveConfig: (config) => plainApi('/api/config', { config }),
    plan: (config) => plainApi('/api/plan', { config }),
    search(q, city, station) {
      const params = new URLSearchParams({ q });
      if (city) params.set('city', city);
      if (station) params.set('station', '1');
      return plainApi('/api/search?' + params);
    },
    suggest: (config, planOnly = false) => plainApi('/api/suggest', { config, plan_only: planOnly }),
    async share(plan, backPlan) {
      const r = await plainApi('/api/share', { plan, back_plan: backPlan });
      return { url: r.url, file: r.file };
    },
  };
}

export function onlineBackend() {
  const base = () => `/api/t/${state.tripId}`;
  const py = createPy(() => ({ base: base() }));
  const api = (path, body) => onlineApi(`${base()}${path}`, body);
  return {
    ...unsupported(),
    ...inBrowser(py),
    async loadConfig() {
      const data = await api('/config');
      return { config: data.config, version: data.version ?? null,
        trip: { name: data.name, mode: data.mode, share: data.share, usage: data.usage, expiresAt: data.expiresAt, editCode: data.editCode } };
    },
    saveConfig: (config, meta) => api('/config', { config, ...meta }),
    async share(plan, backPlan) {
      const { html } = await py('share', { plan, back_plan: backPlan, expires: trip.expiresAt || null }); // 方案页页脚写明自动删除日期
      const r = await api('/page', { html });
      return { url: r.share.url, share: r.share };
    },
    syncPath: () => `${base()}/sync`, // 实时连接的路径
    session: (code) => api('/session', { key: editKey(), code }),
    history: () => api('/history'),
    historyAt: (v) => api(`/history/${v}`),
    restore: (version, who) => api('/restore', { version, ...who }),
    shareSettings: (body) => api('/share', body), // { action: 'code', code } 或 { action: 'new-link' | 'stop' }
    setEditCode: (code, clientId) => api('/edit-code', { code, client_id: clientId }),
    rotateKey: (clientId) => api('/rotate-key', { clientId }),
    rename: (name) => api('/rename', { name }),
    deleteTrip: () => api('/delete', {}),
    setOwnKey: (amapKey) => api('/key', { amapKey }),
  };
}

// 试玩：读 /try-trip.json（虚构行程），日期设成下一个周六和周日；恢复示例就是重新来一遍
export async function loadTryTrip() {
  const { config } = await plainApi('/try-trip.json');
  const dow = bj(Date.now()).getUTCDay(); // 0 周日 … 6 周六，北京时间
  const days = (6 - dow + 7) % 7 || 7; // 今天是周六也取下周六，保证日期还没过
  config.options.travel_date = bjDate(Date.now() + days * 864e5);
  if (config.return) config.return.date = bjDate(Date.now() + (days + 1) * 864e5);
  return { config };
}

export function tryBackend() {
  const py = createPy(() => ({ try: true })); // 计算环境用不联网的 TryAmap
  const notInTry = async () => { throw new Error('试玩里没有这个功能'); };
  return {
    ...unsupported(),
    ...inBrowser(py),
    async loadConfig() {
      const { config } = await loadTryTrip();
      return { config, version: null, trip: {} };
    },
    saveConfig: notInTry,
    share: notInTry,
  };
}

export function createBackend(mode) {
  if (mode === 'online') return onlineBackend();
  if (mode === 'try') return tryBackend();
  return localBackend();
}

// 界面用的就是这两个对象：启动时 initBackend 按模式填进去（对象不换，各模块 import 到的一直是同一个）
export const backend = {};

export function initBackend(mode) {
  for (const k of Object.keys(backend)) delete backend[k];
  Object.assign(backend, createBackend(mode));
  setCaps(capsFor(mode));
}
