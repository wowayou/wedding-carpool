// ---------- 历史版本（在线版）：列出、对比、恢复 ----------

import { backend } from './backend.js';
import { confirmDialog, toast } from './dialogs.js';
import { closeDrawer, openDrawer } from './drawer.js';
import { renderForm } from './form.js';
import { describeChanges } from './merge.js';
import { updateStale } from './stale.js';
import { me, state } from './state.js';
import { save } from './sync.js';
import { fmtTime } from './time.js';
import { $, clone, esc } from './util.js';

export async function openHistory() {
  openDrawer('历史版本', '<div class="c-empty">加载中…</div>');
  try {
    const { history } = await backend.history();
    $('#drawerBody').innerHTML = `<p class="muted">同一个人 2 分钟内的连续修改合并成一条。恢复会生成一个新版本，之后还能再撤回。</p>` +
      (history.map((h) => `<div class="hist" data-v="${h.version}">
        <div class="meta">版本 ${h.version} · ${esc(h.author || '未署名')} · ${esc(fmtTime(h.at))}${h.version === state.version ? ' · <b>当前</b>' : ''}</div>
        <div class="notes">${esc((h.notes || []).join('；') || (h.restore ? '恢复' : '修改'))}</div>
        ${h.version === state.version ? '' : `<button class="c-btn c-btn--link" data-preview="${h.version}">看看和现在有什么不同</button>`}
        <div class="slot"></div></div>`).join('') || '<div class="c-empty">还没有历史版本。</div>');
  } catch (e) {
    $('#drawerBody').innerHTML = `<div class="c-alert c-alert--danger"><div>${esc(e.message)}</div></div>`;
  }
}

export async function previewVersion(v, slot) {
  slot.innerHTML = '<div class="diff">加载中…</div>';
  const { config } = await backend.historyAt(v);
  const diff = describeChanges(state.cfg, config);
  slot.innerHTML = `<div class="diff">恢复后会：${esc(diff || '和现在一样')}</div>
    <button class="c-btn c-btn--sm" data-restore="${v}">恢复到这个版本</button>`;
}

export async function restoreVersion(v) {
  if (!await confirmDialog('现在的内容会成为一个历史版本，之后可以再恢复回来。', { title: `恢复到版本 ${v}？`, okText: '恢复' })) return;
  if (state.dirty) await save(true);
  const out = await backend.restore(v, { author: me.name, client_id: me.clientId });
  state.cfg = clone(out.config);
  state.synced = clone(out.config);
  state.version = out.version;
  state.dirty = false;
  renderForm();
  updateStale();
  closeDrawer();
  toast(`已恢复到版本 ${v}`);
}

