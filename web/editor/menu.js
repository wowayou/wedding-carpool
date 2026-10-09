// ---------- 「更多」：行程设置、分享、口令、备份（导出和导入）、删除 ----------

import { backend } from './backend.js';
import { caps } from './caps.js';
import { alertDialog, confirmDialog, promptDialog, toast } from './dialogs.js';
import { closeDrawer, openDrawer } from './drawer.js';
import { renderForm } from './form.js';
import { showQuota } from './overlay.js';
import { me, state, trip } from './state.js';
import { markDirty } from './sync.js';
import { fmtDate, fmtTime } from './time.js';
import { rememberTrip, renderTitle } from './trip.js';
import { $, esc, isPlain, store } from './util.js';

export function openMenu() {
  const editLink = caps.hasTrip ? `${location.origin}/t/${state.tripId}#k=${store.get('carpool_trips', []).find((t) => t.id === state.tripId)?.key || ''}` : '';
  const share = trip.share || {};
  const shareLink = share.url ? location.origin + share.url : '';
  const expires = trip.expiresAt ? new Date(trip.expiresAt) : null;
  openDrawer('更多', `
    ${caps.hasTrip ? `
    <div class="kv"><span>行程名称</span><span class="row"><input class="c-input" id="tripName" value="${esc(trip.name)}"><button class="c-btn c-btn--sm" id="renameBtn">改名</button></span>
      <span>邀请编辑</span><span><span class="row"><input class="c-input" readonly value="${esc(editLink)}" aria-label="编辑链接"><button class="c-btn c-btn--sm" data-copy="${esc(editLink)}">复制</button></span>
        <button class="c-btn c-btn--link" id="rotateBtn">重置编辑链接</button> <span class="muted">链接外传了就重置，旧链接立即失效</span></span>
      <span>方案页</span><span>${share.url ? `<a href="${esc(share.url)}" target="_blank" rel="noopener">${esc(shareLink)}</a> <button class="c-btn c-btn--link" data-copy="${esc(shareLink)}">复制</button><br>
        <span class="muted">${esc(fmtTime(share.at))}发布；重新发布会更新这个链接</span><br>
        <button class="c-btn c-btn--link" data-share="new-link">换一个链接</button> <button class="c-btn c-btn--link" data-share="stop">停止分享</button>`
        : '<span class="muted">还没发布：算出方案后点「发布方案页」</span>'}</span>
      <span>访问口令</span><span><span class="row"><input class="c-input" id="shareCode" value="${esc(share.code)}" maxlength="20" placeholder="不设"><button class="c-btn c-btn--sm" id="shareCodeBtn">保存</button></span>
        <span class="muted">设了口令，看方案页要先输入；方案页本来就不含精确出发地和家庭位置</span></span>
      <span>编辑口令</span><span><span class="row"><input class="c-input" id="editCode" maxlength="20" autocomplete="off" placeholder="${trip.editCode ? '已设置；输入新口令可更换' : '不设'}"><button class="c-btn c-btn--sm" id="editCodeBtn">${trip.editCode ? '更换' : '设置'}</button></span>
        ${trip.editCode ? '<button class="c-btn c-btn--link" id="editCodeClear">清除编辑口令</button> ' : ''}<span class="muted">4 到 20 个字符。设了以后，新设备打开编辑链接要先输口令，正在编辑的其他人会被请出、重新输入。和方案页的访问口令是两回事</span></span>
      <span>保留到</span><span class="muted">${expires ? fmtDate(trip.expiresAt) : '—'}：出行日期过后 60 天、或连续 180 天没人编辑，自动删除（取较晚的）</span>
      <span>高德额度</span><span class="muted">${trip.mode === 'own' ? '用你自己的高德 Key' : '用站点的公共额度'}，今天已用 ${trip.usage || 0} 次；到上限会停下提示，不会继续调用${trip.mode === 'own' ? '' : '<br><button class="c-btn c-btn--link" id="ownKeyBtn">改用自己的高德 Key</button>'}</span>
    </div>
    <p class="muted">编辑链接等于编辑权限，只发给一起规划的人。要给大家看结果，发「方案页」链接就行，不用发编辑链接。<a href="/privacy" target="_blank" rel="noopener">数据存了什么、存多久、可能的费用</a></p>` : ''}
    <h3 class="sec">关于</h3>
    <p class="muted">这个工具是非商业的个人项目，免费、无广告。作者主页：<a href="https://eigentime.org/" target="_blank" rel="noopener">eigentime.org</a></p>
    <h3 class="sec">备份</h3>
    ${!caps.canImport ? `<div class="row"><button class="c-btn" id="exportBtn">导出配置（JSON）</button></div>
    <p class="muted">试玩里的内容不保存、不能导入。想规划自己的出行，<a href="/#create">新建行程</a>。</p>` : `<div class="row"><button class="c-btn" id="exportBtn">导出配置（JSON）</button><button class="c-btn" id="importBtn">导入配置</button></div>
    <p class="muted">导入会替换现在的配置${caps.text.importNote}。</p>`}
    ${caps.hasTrip ? `<p><a href="/">← 回首页（新建或切换行程）</a></p>
    <h3 class="sec" style="color:var(--danger)">删除行程</h3>
    <p class="muted">配置、历史版本和方案页都会删掉，所有人的编辑链接和方案页链接都会失效，不能恢复。</p>
    <button class="c-btn c-btn--danger" id="deleteBtn">删除这个行程</button>` : ''}`);
  $('#exportBtn').onclick = exportConfig;
  if ($('#ownKeyBtn')) $('#ownKeyBtn').onclick = () => { closeDrawer(); showQuota('', true); };
  if ($('#shareCodeBtn')) {
    $('#shareCodeBtn').onclick = async () => {
      const { share: next } = await backend.shareSettings({ action: 'code', code: $('#shareCode').value });
      trip.share = next;
      toast(next.code ? '已设置访问口令，告诉要看方案的人' : '已取消访问口令');
    };
  }
  document.querySelectorAll('[data-share]').forEach((b) => {
    b.onclick = async () => {
      const action = b.dataset.share;
      const ok = await confirmDialog(action === 'stop' ? '方案页链接会立即失效，之后可以重新发布。' : '旧链接会立即失效，新链接会复制到剪贴板。',
        { title: action === 'stop' ? '停止分享？' : '换一个方案页链接？', okText: action === 'stop' ? '停止分享' : '换链接', danger: true });
      if (!ok) return;
      try {
      const { share: next } = await backend.shareSettings({ action });
      trip.share = next;
      if (next.url) navigator.clipboard?.writeText(location.origin + next.url).catch(() => {});
      toast(action === 'stop' ? '已停止分享' : '已换成新链接，新链接已复制');
      openMenu();
      } catch (err) { toast(err.message, 3000, 'danger'); }
    };
  });
  const setEditCode = async (code, done) => {
    try {
      await backend.setEditCode(code, me.clientId);
      trip.editCode = Boolean(code);
      toast(done, 4000);
      openMenu();
    } catch (e) { toast(e.message, 3000, 'danger'); }
  };
  if ($('#editCodeBtn')) {
    $('#editCodeBtn').onclick = async () => {
      const code = $('#editCode').value.trim();
      if (code.length < 4 || code.length > 20) { toast('编辑口令要 4 到 20 个字符', 2600, 'danger'); return; }
      if (!await confirmDialog('正在编辑的其他人会被请出，要输入口令才能回来；以后新设备打开编辑链接也要输口令。记得把口令告诉一起编辑的人。', { title: '设置编辑口令？', okText: '设置' })) return;
      setEditCode(code, '已设置编辑口令，告诉一起编辑的人');
    };
  }
  if ($('#editCodeClear')) {
    $('#editCodeClear').onclick = async () => {
      if (await confirmDialog('之后只凭编辑链接就能打开。', { title: '清除编辑口令？', okText: '清除' })) setEditCode('', '已清除编辑口令');
    };
  }
  if ($('#rotateBtn')) {
    $('#rotateBtn').onclick = async () => {
      if (!await confirmDialog('所有人手里的旧链接立即失效，正在编辑的其他人会被请出。新链接只发给需要编辑的人。', { title: '重置编辑链接？', okText: '重置', danger: true })) return;
      const { key, url } = await backend.rotateKey(me.clientId);
      rememberTrip(key);
      history.replaceState(null, '', url);
      navigator.clipboard?.writeText(location.origin + url).catch(() => {});
      toast('已重置，新编辑链接已复制', 4000);
      openMenu();
    };
  }
  if ($('#deleteBtn')) {
    $('#deleteBtn').onclick = async () => {
      const typed = await promptDialog({
        title: '删除这个行程？', message: '配置、历史版本和方案页都会删掉，所有人的编辑链接和方案页链接都会失效，不能恢复。',
        label: `请输入行程名称「${trip.name || ''}」确认`, placeholder: trip.name || '', okText: '删除行程', danger: true,
        validate: (v) => (v.trim() === (trip.name || '') ? '' : '名称不对，没有删除'),
      });
      if (typed === null) return;
      await backend.deleteTrip();
      store.set('carpool_trips', store.get('carpool_trips', []).filter((t) => t.id !== state.tripId));
      state.dirty = false;
      location.href = '/';
    };
  }
  if ($('#importBtn')) $('#importBtn').onclick = () => $('#importFile').click();
  if ($('#renameBtn')) {
    $('#renameBtn').onclick = async () => {
      const { name } = await backend.rename($('#tripName').value);
      trip.name = name;
      renderTitle();
      rememberTrip();
      toast('已改名');
    };
  }
}

export function exportConfig() {
  const blob = new Blob([JSON.stringify({ name: trip.name || '', config: state.cfg }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `拼车-${(trip.name || state.cfg.venue?.name || '行程').replace(/[\\/:*?"<>|]/g, '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importConfig(file) {
  if (!caps.canImport) return;
  try {
    const data = JSON.parse(await file.text());
    const next = data.config || data;
    if (!isPlain(next) || !Array.isArray(next.people || []) || !isPlain(next.venue || {})) throw new Error('不是这个工具导出的配置');
    if (!await confirmDialog(caps.text.importConfirm, { title: '用导入的配置替换现在的内容？', okText: '替换' })) return;
    state.cfg = { venue: {}, options: {}, stations: [], people: [], ...next };
    markDirty();
    renderForm();
    closeDrawer();
    toast('已导入');
  } catch (e) {
    alertDialog(e.message, { title: '导入失败' });
  }
}


// 「更多」开着时刷新一下（比如别人发布了方案页）
export function refreshMenu() {
  if (!$('#drawer').hidden && $('#drawerTitle').textContent === '更多') openMenu();
}
