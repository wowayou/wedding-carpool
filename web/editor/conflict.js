// 给人看的字段名，用在冲突提示和改动摘要里；中文名取自 config-fields.json

import { fieldOf } from './fields.js';
import { rerenderKeepingFocus } from './form.js';
import { setPath } from './paths.js';
import { state } from './state.js';
import { markDirty } from './sync.js';
import { $, clone, esc, isPlain } from './util.js';

export function labelOf(path) {
  const k = path.split('.');
  if (path === 'people') return '成员列表';
  if (path === 'stations') return '候选站列表';
  const f = fieldOf(path.split('.').slice(0, k[0] === 'people' || k[0] === 'stations' ? 3 : k[0] === 'options' && k[1] === 'suggest' ? 3 : 2).join('.'));
  const name = f?.label;
  if (k[0] === 'venue') return name || '目的地';
  if (k[0] === 'return') return '返程「' + (name || k[1]) + '」';
  if (k[0] === 'options') return (k[1] === 'suggest' ? '找站设置「' : '选项「') + (name || k.slice(1).join('.')) + '」';
  if (k[0] === 'stations') return `候选站「${state.cfg?.stations?.[k[1]]?.name || Number(k[1]) + 1}」`;
  if (k[0] === 'people') {
    const who = state.cfg?.people?.[k[1]]?.name || `第 ${Number(k[1]) + 1} 位成员`;
    if (k[2] === 'trains') return `${who}到${k.slice(3).join('.')}的车次`;
    if (k[2] === 'rail_min') return `${who}到${k.slice(3).join('.')}的用时`;
    if (k[2] === 'return_trains') return `${who}从${k.slice(3).join('.')}返程的车次`;
    return `${who}的` + (name || k[2] || '信息');
  }
  return path;
}
export function showValue(v) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (Array.isArray(v)) return v.map((x) => x?.name ?? '').filter(Boolean).join('、') || `${v.length} 项`;
  if (isPlain(v)) return v.name || '（一组设置）';
  return String(v);
}

// 同一格都改了：先保留我的，告诉我对方改成了什么，可以一键改用对方的；需要更早的内容去「历史」里找
export function showConflicts(conflicts, who) {
  for (const c of conflicts) {
    const box = document.createElement('div');
    box.className = 'conflict';
    box.innerHTML = `你和 <b>${esc(who)}</b> 同时改了 <b>${esc(labelOf(c.path))}</b>：保留了你的「${esc(showValue(c.mine))}」，${esc(who)} 的是「${esc(showValue(c.theirs))}」。
      <div class="acts"><button class="c-btn c-btn--link" data-use-theirs>改用 ${esc(who)} 的</button><button class="c-btn c-btn--link" data-dismiss>知道了</button></div>`;
    box.querySelector('[data-use-theirs]').onclick = () => {
      if (c.path.includes('.')) setPath(c.path, clone(c.theirs)); else state.cfg[c.path] = clone(c.theirs);
      markDirty();
      rerenderKeepingFocus();
      box.remove();
    };
    box.querySelector('[data-dismiss]').onclick = () => box.remove();
    $('#conflicts').append(box);
    setTimeout(() => box.remove(), 60000);
  }
}

