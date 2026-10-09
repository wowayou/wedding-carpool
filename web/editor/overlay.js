// ---------- 整页遮罩的焦点管理：取名、编辑口令、打不开、已删除、额度 ----------
// 打开：记住原来的焦点，把焦点放到第一个输入框或主按钮，背景（主区域、侧边面板、冲突提示）设 inert，Tab 键只在遮罩里循环。
// 关闭：恢复 inert，焦点还给原来的元素。只有额度遮罩可以关闭，支持 Esc；取名和口令必须完成，不支持 Esc。

import { me } from './state.js';
import { $, store } from './util.js';

export const OVERLAY_IDS = ['nameBox', 'codeBox', 'denied', 'gone', 'quotaBox'];
export const openOverlays = () => OVERLAY_IDS.map((id) => $(`#${id}`)).filter((el) => !el.hidden);
let overlayReturn = null;
export function syncInert() {
  const on = openOverlays().length > 0;
  for (const sel of ['#app', '#drawer', '#conflicts']) $(sel).inert = on;
}
export function showOverlay(id, focusSel) {
  if (!openOverlays().length) overlayReturn = document.activeElement;
  const el = $(`#${id}`);
  el.hidden = false;
  syncInert();
  (focusSel ? el.querySelector(focusSel) : el.querySelector('input, button, a[href]'))?.focus();
}
export function hideOverlay(id) {
  $(`#${id}`).hidden = true;
  syncInert();
  if (openOverlays().length) return;
  const back = overlayReturn;
  overlayReturn = null;
  if (back && back !== document.body && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
}

// 弹窗（<dialog>）和整页遮罩里，Tab 键只在里面循环；Esc 只关额度遮罩（页内弹窗的 Esc 由弹窗自己处理）。由 main.js 在启动时装上
export function installOverlayKeys() {
  document.addEventListener('keydown', (e) => {
    const open = [...document.querySelectorAll('dialog[open]')].at(-1) || openOverlays().at(-1); // 页内弹窗（<dialog>）也让 Tab 在里面循环，Esc 由弹窗自己处理
    if (!open) return;
    if (e.key === 'Escape' && open.id === 'quotaBox') { e.preventDefault(); hideOverlay('quotaBox'); return; }
    if (e.key !== 'Tab') return;
    const items = [...open.querySelectorAll('input, button, a[href], textarea, select, [tabindex]')].filter((x) => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items.at(-1);
    if (!open.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

export function deny(text) {
  $('#deniedText').textContent = `${text}。编辑链接只发给一起规划的人；如果你是发起人，可以在首页「我打开过的行程」里找到它。`;
  showOverlay('denied', 'a[href]');
}

export function askName() {
  return new Promise((resolve) => {
    $('#nameInput').value = me.name;
    showOverlay('nameBox', '#nameInput');
    $('#nameForm').onsubmit = (e) => {
      e.preventDefault();
      me.name = $('#nameInput').value.trim().slice(0, 20);
      if (!me.name) return;
      store.set('carpool_name', me.name);
      hideOverlay('nameBox');
      resolve();
    };
  });
}

export function showQuota(message, proactive = false) {
  $('#quotaTitle').textContent = proactive ? '改用自己的高德 Key' : '今天的高德额度用完了';
  $('#quotaText').textContent = proactive
    ? '换成你自己的 Key 后，这个行程的高德调用都算在你的额度里，不再占用站点的公共额度。'
    : `${message} 已经停下，没有继续调用。`;
  $('#quotaErr').textContent = '';
  $('#quotaKey').value = '';
  showOverlay('quotaBox', '#quotaKey');
}

