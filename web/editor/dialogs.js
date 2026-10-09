// ---------- 轻提示和弹窗：替代原生 alert / confirm / prompt ----------

import { $, esc } from './util.js';

export function toast(msg, ms = 2600, kind = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `c-toast${kind ? ` c-toast--${kind}` : ''}`;
  el.textContent = msg;
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'danger' ? Math.max(ms, 5000) : ms);
}

// 通用弹窗（<dialog>）：返回 Promise<{ ok, value?, pick? }>。
// 选择器约定（自动化脚本用）：确认 [data-dialog-ok]，取消 [data-dialog-cancel]，输入框 [data-dialog-input]，错误提示 [data-dialog-error]
export function openDialog({ title, message = '', html = '', input = null, okText = '确定', cancelText = '取消', danger = false, validate = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'c-modal';
    dlg.innerHTML = `<form method="dialog" novalidate>
      <div class="c-modal__body"><h2 class="c-modal__title">${esc(title)}</h2>
        ${message ? `<p class="c-muted" style="margin:0">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}${html}
        ${input ? `<label class="c-field"><span class="c-field__label">${esc(input.label || '')}</span>
          <input class="c-input" data-dialog-input autocomplete="off" maxlength="${input.maxlength || 60}" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}"></label>` : ''}
        <div class="c-field__error" data-dialog-error role="alert"></div></div>
      <div class="c-modal__actions">${cancelText ? `<button type="button" class="c-btn" data-dialog-cancel>${esc(cancelText)}</button>` : ''}
        <button class="c-btn ${danger ? 'c-btn--danger c-btn--solid' : 'c-btn--primary'}" data-dialog-ok>${esc(okText)}</button></div></form>`;
    document.body.append(dlg);
    let done = false;
    const finish = (r) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(r); };
    const field = dlg.querySelector('[data-dialog-input]');
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish({ ok: false }); }); // Esc
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-dialog-cancel]')) return finish({ ok: false });
      const pick = e.target.closest('[data-dialog-pick]');
      if (pick) finish({ ok: false, pick: pick.dataset.dialogPick });
    });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = field ? field.value : undefined;
      const err = validate ? validate(value) : '';
      if (err) { dlg.querySelector('[data-dialog-error]').textContent = err; field?.focus(); return; }
      finish({ ok: true, value });
    });
    dlg.showModal();
    (field || dlg.querySelector(danger && cancelText ? '[data-dialog-cancel]' : '[data-dialog-ok]')).focus();
  });
}
export const confirmDialog = (message, { title = '确认一下', okText = '确定', danger = false } = {}) =>
  openDialog({ title, message, okText, danger }).then((r) => r.ok);
export const alertDialog = (message, { title = '出错了' } = {}) => openDialog({ title, message, cancelText: null, okText: '知道了' });
// 要求输入文字确认（比如删除行程时输入名称）；取消返回 null
export const promptDialog = ({ title, message, label, placeholder = '', value = '', okText = '确定', danger = false, validate = null }) =>
  openDialog({ title, message, input: { label, placeholder, value }, okText, danger, validate }).then((r) => (r.ok ? r.value : null));

