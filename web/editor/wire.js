// ---------- 事件：把页面上的按钮、输入框和键盘绑到各模块的函数上 ----------
// 由 main.js 在启动时调一次（模块导入时不碰页面）。

import { addItem, deleteItem, pick, renameStation, search, setStationValue, toggleCar } from './actions.js';
import { backend } from './backend.js';
import { caps } from './caps.js';
import { showConflicts } from './conflict.js';
import { alertDialog, confirmDialog, toast } from './dialogs.js';
import { closeDrawer } from './drawer.js';
import { on } from './events.js';
import { refreshDerived, renderForm, rerenderKeepingFocus } from './form.js';
import { openHistory, previewVersion, restoreVersion } from './history.js';
import { narrow, setPane } from './layout.js';
import { declutter, drawPlan, drawPreview, initMap, view } from './map.js';
import { importConfig, openMenu, refreshMenu } from './menu.js';
import { hideOverlay } from './overlay.js';
import { setPath } from './paths.js';
import { renderTabs, runPlan } from './results.js';
import { isStale, outboundOn, state, sug, trip } from './state.js';
import { drawSugLayer, syncSugLayer } from './sug-layer.js';
import { addSuggested, renderSgPanel, renderSugOut, runSuggest, scheduleSugEstimate, sgChanged, sgRefresh, sgSyncFromCfg, suggestStations } from './suggest.js';
import { markDirty, save, sendFocus } from './sync.js';
import { loadConfig, renderTitle, resetTry } from './trip.js';
import { $ } from './util.js';
import { collectProblems, decorateProblems, problemsDialog } from './validate.js';

export function bindEvents() {
  // 下层模块发出的事件（见 events.js）
  on('rendered', sgSyncFromCfg); // 表单重画完：推荐车站的抽屉开着时，同步设置面板
  on('conflicts', showConflicts); // 合并时同一格两边都改了
  on('meta', renderTitle); // 别人改了行程名称
  on('share', refreshMenu); // 方案页的发布状态变了
  on('reload', () => loadConfig(true)); // 断线期间别人改过：重新载入

  $('#quotaClose').addEventListener('click', () => hideOverlay('quotaBox'));
  $('#quotaKeyBtn').addEventListener('click', async () => {
    const btn = $('#quotaKeyBtn');
    btn.disabled = true;
    $('#quotaErr').textContent = '正在验证…';
    try {
      await backend.setOwnKey($('#quotaKey').value.trim());
      trip.mode = 'own';
      hideOverlay('quotaBox');
      toast('已改用你的高德 Key，可以接着算了', 4000);
    } catch (e) {
      $('#quotaErr').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#mapRetry').addEventListener('click', () => {
    const old = document.querySelector('script[data-lib=leaflet]');
    const script = document.createElement('script');
    script.src = old.src; script.integrity = old.integrity; script.crossOrigin = 'anonymous';
    script.onload = () => { if (initMap()) { state.fitted = false; sug.fitted = false; if (state.cfg) drawPreview(); if (state.result) drawPlan(true); syncSugLayer(true); } };
    script.onerror = () => toast('地图还是没加载出来，稍后再试', 3000, 'danger');
    document.head.append(script);
  });

  $('#form').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.bind) {
      const emptySeats = /^people\.\d+\.car_seats$/.test(t.dataset.bind); // 空座清空不能删掉这个字段，否则这位车主会变成「不开车」
      const value = t.dataset.type === 'number' ? (t.value === '' ? (emptySeats ? 0 : '') : Number(t.value)) : t.value;
      setPath(t.dataset.bind, t.dataset.bind === 'options.taxi_mode' && value === 'save' ? '' : value); // 默认的「省钱」不写进配置
      markDirty();
    } else if (t.dataset.stationName !== undefined) {
      state.cfg.stations[Number(t.dataset.stationName)].name = t.value.trim();
      markDirty();
    } else if (t.dataset.rail !== undefined) {
      setStationValue(Number(t.dataset.rail), 'rail_min', t.dataset.station, t.value === '' ? '' : Number(t.value));
    } else if (t.dataset.backtrain !== undefined) {
      setStationValue(Number(t.dataset.backtrain), 'return_trains', t.dataset.station, t.value.trim());
    } else if (t.dataset.train !== undefined) {
      setStationValue(Number(t.dataset.train), 'trains', t.dataset.station, t.value.trim());
    }
  });

  $('#form').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.stationName !== undefined) renameStation(Number(t.dataset.stationName), t);
    else if (t.dataset.car !== undefined) toggleCar(Number(t.dataset.car), t.checked);
    else if (t.dataset.returnToggle !== undefined) {
      if (!t.checked && !outboundOn()) { t.checked = true; toast('去程已经关了，返程要留着：至少规划一段'); return; }
      state.cfg.return ??= {};
      state.cfg.return.enabled = t.checked;
      markDirty();
      renderForm();
    } else if (t.dataset.outboundToggle !== undefined) {
      if (!t.checked && !state.cfg.return?.enabled) { t.checked = true; toast('返程没开，去程要留着：至少规划一段'); return; }
      if (t.checked) delete state.cfg.options.outbound; else state.cfg.options.outbound = false;
      markDirty();
      renderForm();
    } else if (t.dataset.backdrive !== undefined) {
      const p = state.cfg.people[Number(t.dataset.backdrive)];
      if (t.checked) delete p.return_drives; else { p.return_drives = false; delete p.return_max_detour_min; }
      markDirty();
      renderForm();
    } else if (t.dataset.home !== undefined) {
      const p = state.cfg.people[Number(t.dataset.home)];
      if (t.checked) delete p.pickup_at_home; else p.pickup_at_home = false;
      markDirty();
    } else if (t.dataset.bind && /^(options\.|return\.(date|depart_time)$|people\.\d+\.(name|from)$)/.test(t.dataset.bind)) {
      refreshDerived(); // 默认值提示、12306 链接、步骤条、校验提示：只更新受影响的部分，不重建表单（否则会吞掉紧接着的点击）
    }
  });

  $('#form').addEventListener('keydown', (e) => {
    // 地址框里按回车直接搜索
    if (e.key !== 'Enter' || !e.target.dataset.bind) return;
    const m = e.target.dataset.bind.match(/^(venue|people\.\d+)\.(address|from)$/);
    if (m) { e.preventDefault(); search(m[1], m[2]); }
  });

  $('#form').addEventListener('focusin', sendFocus);
  $('#form').addEventListener('focusout', sendFocus);

  $('#form').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.search) search(t.dataset.search, t.dataset.text);
    else if (t.dataset.pick) pick(t.dataset.pick, Number(t.dataset.k));
    else if (t.dataset.clearloc) { setPath(t.dataset.clearloc + '.location', ''); markDirty(); rerenderKeepingFocus(); }
    else if (t.dataset.add) addItem(t.dataset.add);
    else if (t.dataset.del) deleteItem(t.dataset.del);
    else if (t.dataset.suggest !== undefined) suggestStations();
    else if (t.dataset.tryReset !== undefined) resetTry();
  });

  $('#steps').addEventListener('click', (e) => {
    const t = e.target.closest('[data-goto]');
    if (!t) return;
    if (t.dataset.goto === 'plan') { if (!state.result || isStale()) runPlan(); else { setPane('plan'); $('#panePlan').scrollIntoView({ behavior: 'smooth' }); } }
    else { setPane('fill'); document.getElementById(t.dataset.goto)?.scrollIntoView({ behavior: 'smooth' }); }
  });

  document.querySelector('.ed-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pane]');
    if (b) setPane(b.dataset.pane);
  });
  narrow().addEventListener('change', () => setTimeout(() => { if (view.map) { view.map.invalidateSize(); declutter(); } }, 80));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { drawPreview(); if (state.result) drawPlan(false); drawSugLayer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden && !document.querySelector('dialog[open]')) closeDrawer(); });
  $('#staleBtn').addEventListener('click', runPlan);


  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-plan]');
    if (!t) return;
    state.viewLeg = t.dataset.leg;
    if (state.viewLeg === 'back') state.activeBack = Number(t.dataset.plan); else state.active = Number(t.dataset.plan);
    renderTabs();
    drawPlan(false);
  });

  $('#drawer').addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-close-drawer]');
    if (!t) return;
    try {
      if (t.dataset.closeDrawer !== undefined) closeDrawer();
      else if (t.dataset.sgToggle !== undefined) { sug.settingsOpen = !sug.settingsOpen; sgRefresh(); if (sug.settingsOpen) $('#sgPanel').querySelector('input, select')?.focus(); }
      else if (t.dataset.sgReset !== undefined) { if (state.cfg.options.suggest) { delete state.cfg.options.suggest; markDirty(); } renderSgPanel(); scheduleSugEstimate(); }
      else if (t.dataset.sgGo !== undefined) runSuggest();
      else if (t.dataset.sgRetryEst !== undefined) scheduleSugEstimate(0);
      else if (t.dataset.sgMap !== undefined) {
        closeDrawer(true);
        setPane('map');
        sug.fitted = false;
        setTimeout(() => { if (view.map) view.map.invalidateSize(); syncSugLayer(true); }, 80);
        toast('找站过程在地图上。想回到推荐车站，点「填写」里的「推荐车站」', 4000);
      } else if (t.dataset.sgAdd !== undefined) {
        const picked = [...document.querySelectorAll('[data-sug]:checked')].map((el) => sug.result.stations[Number(el.dataset.sug)]);
        if (!picked.length) { toast('先勾选要加入的车站'); return; }
        const n = addSuggested(picked);
        closeDrawer();
        markDirty();
        renderForm();
        toast(`加了 ${n} 个车站，接下来给不开车的人填车次`);
      } else if (t.dataset.sgMore !== undefined) {
        const added = addSuggested([sug.result.more[Number(t.dataset.sgMore)]]);
        if (added) { markDirty(); renderForm(); renderSugOut(); toast('加了 1 个车站，接下来给不开车的人填车次'); }
      } else if (t.dataset.preview) await previewVersion(Number(t.dataset.preview), t.closest('.hist').querySelector('.slot'));
      else if (t.dataset.restore) await restoreVersion(Number(t.dataset.restore));
      else if (t.dataset.copy !== undefined) { await navigator.clipboard.writeText(t.dataset.copy); toast('已复制'); }
    } catch (err) {
      toast(err.message);
    }
  });

  // 找站设置和结果里的勾选：用 input 事件，复选框、单选框、下拉框、数字框都会触发
  $('#drawerBody').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.sg) sgChanged(t);
    else if (t.dataset.sug !== undefined) sug.checked[sug.result.stations[Number(t.dataset.sug)].name] = t.checked;
    else if (t.dataset.sgLayer !== undefined) { sug.layerOn = t.checked; syncSugLayer(true); }
  });

  $('#historyBtn').addEventListener('click', openHistory);
  $('#menuBtn').addEventListener('click', openMenu);
  $('#expiryChip').addEventListener('click', openMenu);
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ''; });
  $('#save').addEventListener('click', async () => {
    const blocking = collectProblems().filter((p) => p.blocksSave);
    if (blocking.length) { state.showRequired = true; decorateProblems(); await problemsDialog(blocking); return; }
    save().catch((e) => alertDialog(e.message, { title: '保存失败' }));
  });
  $('#plan').addEventListener('click', runPlan);
  $('#sharebtn').addEventListener('click', async () => {
    if (isStale() && !await confirmDialog('配置改过了，当前方案可能过期。', { title: '仍然发布这个方案？', okText: '仍然发布' })) return;
    const win = window.open('', '_blank'); // 先开窗口，避免异步之后被拦截
    try {
      const outOn = state.result?.outbound !== false;
      const r = await backend.share(outOn ? state.active : -1, state.activeBack); // 只规划返程时没有去程方案可选
      const combo = [outOn ? `去程方案 ${state.active + 1}` : '', state.result?.back ? `返程方案 ${state.activeBack + 1}` : ''].filter(Boolean).join(' + ');
      const link = new URL(r.url, location.href).href;
      if (r.share) { // 发布到服务器的：记下发布状态，把链接复制给用户
        trip.share = r.share;
        navigator.clipboard?.writeText(link).catch(() => {});
      }
      toast(caps.text.published(combo, r), r.share ? 4000 : undefined);
      if (win) win.location = link; else location.href = link;
    } catch (e) {
      if (win) win.close();
      alertDialog(e.message, { title: '发布失败' });
    }
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
}
