// ---------- 保存与同步 ----------
// 改动标记、保存（本地写文件，在线存服务器）、在线版的自动保存、三方合并、实时连接、编辑口令。
// 同步过程中要通知界面的事（别人改了名称、冲突、需要重新载入）用事件（见 events.js），这里不去 import 上层模块。

import { backend } from './backend.js';
import { caps } from './caps.js';
import { toast } from './dialogs.js';
import { emit } from './events.js';
import { renderSteps, rerenderKeepingFocus } from './form.js';
import { schedulePreview } from './map.js';
import { describeChanges, merge3 } from './merge.js';
import { deny, hideOverlay, showOverlay } from './overlay.js';
import { pathOf } from './paths.js';
import { markPeers, renderPeers } from './peers.js';
import { updateStale } from './stale.js';
import { me, state, trip } from './state.js';
import { $, clone, same, store } from './util.js';
import { decorateSoon } from './validate.js';

export function markDirty() {
  if (caps.canSave) { state.dirty = true; $('#save').textContent = '保存*'; } // 试玩不保存，也就没有「未保存的修改」
  if (caps.liveSync) scheduleSync();
  renderSteps();
  updateStale();
  schedulePreview();
  decorateSoon();
}

let syncTimer = null, syncing = null, socket = null, retryDelay = 1000, lastError = '';
let isGone = false;

export function setStatus() {
  const fixed = caps.text.status(trip); // 本地版和试玩的状态是固定的；在线版要看连接和同步
  let text;
  if (fixed !== null) text = fixed;
  else if (!socket || socket.readyState !== 1) text = '连接断开，正在重连…改动会在恢复后保存';
  else if (lastError) text = lastError;
  else if (syncing || syncTimer) text = '同步中…';
  else text = '已同步';
  $('#status').textContent = text;
}

export function scheduleSync(delay = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; save(true).catch(() => {}); }, delay);
  setStatus();
}

export async function syncSave() {
  clearTimeout(syncTimer); syncTimer = null;
  while (syncing) await syncing; // 一次只发一个保存
  if (!state.dirty) { setStatus(); return; } // 已经存好了（比如冲突合并后重存过）：定时器刚清掉，状态栏要从「同步中…」改回来
  syncing = (async () => {
    setStatus();
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = clone(state.cfg);
      let data;
      try {
        data = await backend.saveConfig(snapshot, { base_version: state.version, client_id: me.clientId, author: me.name, note: describeChanges(state.synced, snapshot) });
      } catch (e) {
        if (e.status === 409) { // 别人先存了：合并后重试
          const conflicts = [];
          state.cfg = merge3(state.synced, state.cfg, e.data.config, '', conflicts);
          state.synced = clone(e.data.config);
          state.version = e.data.version;
          rerenderKeepingFocus();
          emit('conflicts', conflicts, e.data.author);
          continue;
        }
        throw e;
      }
      state.version = data.version;
      state.synced = snapshot;
      if (same(state.cfg, snapshot)) { state.dirty = false; $('#save').textContent = '保存'; }
      lastError = '';
      return;
    }
    throw new Error('冲突太多，请刷新页面');
  })();
  try {
    await syncing;
  } catch (e) {
    lastError = `没保存上：${e.message}`;
    if (e.status !== 401) scheduleSync(4000); // 网络问题：过一会儿再试，改动不会丢
    throw e;
  } finally {
    syncing = null;
    setStatus();
  }
  if (state.dirty) scheduleSync();
}

export async function save(quiet) {
  if (!caps.canSave) return;
  if (caps.liveSync) {
    await syncSave();
    if (!quiet) toast('已同步');
    return;
  }
  await backend.saveConfig(state.cfg);
  state.dirty = false;
  $('#save').textContent = '保存';
  if (!quiet) toast('已保存');
}

export function applyRemote(msg) {
  if (msg.client_id === me.clientId || (state.version !== null && msg.version <= state.version)) return;
  const who = msg.author || '有人';
  if (state.dirty || syncing) { // 我这边有没存的改动：合并进来，再存一次
    const conflicts = [];
    state.cfg = merge3(state.synced, state.cfg, msg.config, '', conflicts);
    state.synced = clone(msg.config);
    state.version = msg.version;
    rerenderKeepingFocus();
    emit('conflicts', conflicts, who);
    scheduleSync();
    return;
  }
  const note = describeChanges(state.cfg, msg.config);
  state.cfg = clone(msg.config);
  state.synced = clone(msg.config);
  state.version = msg.version;
  rerenderKeepingFocus();
  updateStale();
  toast(msg.restored ? `${who} 恢复到了版本 ${msg.restored}` : `${who}：${note || '更新了配置'}`);
}

// ---------- 实时连接：在线名单、谁在编辑哪一格 ----------
export function connectSync() {
  if (!caps.liveSync || !me.name || (socket && socket.readyState <= 1)) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${backend.syncPath()}`);
  socket.onopen = () => {
    retryDelay = 1000;
    socket.send(JSON.stringify({ type: 'join', clientId: me.clientId, name: me.name }));
    sendFocus();
    setStatus();
    if (state.dirty) scheduleSync(0); // 断线期间的改动补存
  };
  socket.onmessage = (e) => {
    if (e.data === 'pong') return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'presence') { state.peers = msg.people; renderPeers(); markPeers(); }
    if (msg.type === 'config') applyRemote(msg);
    if (msg.type === 'meta') { trip.name = msg.name; if (msg.mode) trip.mode = msg.mode; emit('meta'); }
    if (msg.type === 'share') { trip.share = msg.share; emit('share'); }
    if (msg.type === 'deleted') tripGone();
    if (msg.type === 'hello' && state.version !== null && msg.version !== state.version) {
      // 断线期间别人改过：没有本地改动就重新载入，有的话下次保存会走合并
      if (state.dirty) scheduleSync(); else emit('reload');
    }
  };
  socket.onclose = (e) => {
    state.peers = [];
    renderPeers();
    markPeers();
    if (e.code === 4001) { state.dirty = false; deny('编辑链接已经被重置，旧链接失效了'); return; }
    if (e.code === 4003) { setStatus(); reauthAfterCodeChange(); return; }
    setStatus();
    setTimeout(connectSync, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
}

// 每 25 秒发一次心跳，由 main.js 启动时开始
export function startPing() {
  setInterval(() => { if (socket && socket.readyState === 1) socket.send('ping'); }, 25000);
}

let focusTimer = null;
export function sendFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'focus', path: pathOf(document.activeElement) }));
  }, 150);
}

// 行程不存在（已删除或到期）：显示专门的页面状态，并把它从这台设备的「最近的行程」里去掉
export function tripGone() {
  if (isGone) return;
  isGone = true;
  state.dirty = false;
  clearTimeout(syncTimer);
  if (socket) { socket.onclose = null; try { socket.close(); } catch { /* 已经断了 */ } }
  store.set('carpool_trips', store.get('carpool_trips', []).filter((t) => t.id !== state.tripId));
  for (const id of ['nameBox', 'codeBox', 'denied', 'quotaBox']) $(`#${id}`).hidden = true;
  showOverlay('gone', '#goneHome');
}

// ---------- 编辑口令：设了口令的行程，新设备（或口令被换后）要输入口令才能换到会话 ----------
let codePrompt = null;
export function askCode(message = '这个行程设了编辑口令，问一下发给你链接的人。') {
  codePrompt ||= new Promise((resolve) => {
    $('#codeMsg').textContent = message;
    $('#codeErr').textContent = '';
    $('#codeInput').value = '';
    showOverlay('codeBox', '#codeInput');
    $('#codeForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await backend.session($('#codeInput').value);
        hideOverlay('codeBox');
        codePrompt = null;
        resolve();
      } catch (err) {
        $('#codeErr').textContent = err.data?.info === 'EDIT_CODE_WRONG' ? '口令不对' : err.data?.info === 'EDIT_CODE_REQUIRED' ? '请输入口令' : err.message;
        $('#codeInput').select();
      }
    };
  });
  return codePrompt;
}

// 实时连接被请出（口令被设置或更换）：口令被清除的话直接就能回来，否则输口令
export async function reauthAfterCodeChange() {
  try {
    await backend.session();
  } catch (err) {
    if (/^EDIT_CODE_/.test(err.data?.info)) await askCode('发起人设置了新的编辑口令，请输入后继续。');
    else if (err.status !== 401) { setTimeout(reauthAfterCodeChange, 3000); return; }
    else return;
  }
  connectSync();
}
