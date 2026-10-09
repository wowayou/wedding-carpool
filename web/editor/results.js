// ---------- 计算方案和方案结果：校验、算、方案卡片、报告、空状态 ----------

import { applyResolved } from './actions.js';
import { backend } from './backend.js';
import { caps } from './caps.js';
import { alertDialog, confirmDialog, toast } from './dialogs.js';
import { renderSteps } from './form.js';
import { narrow, setPane } from './layout.js';
import { drawPlan } from './map.js';
import { showQuota } from './overlay.js';
import { startProgress, stopProgress } from './progress.js';
import { updateStale } from './stale.js';
import { configHash, state } from './state.js';
import { clearSugLayer } from './sug-layer.js';
import { save } from './sync.js';
import { fmtMin } from './time.js';
import { $, esc, isQuotaError } from './util.js';
import { decorateProblems, problemsDialog, validate } from './validate.js';

// 报告是 Markdown，里面有成员名字等用户输入：HTML 一律当文本输出，链接只放行 http(s)，不渲染图片，防止脚本注入。
// marked 是页面上先加载的全局脚本；没加载出来时报告退化成纯文本。由 main.js 在启动时调用
export function setupMarked() {
  if (typeof marked === 'undefined') return;
  marked.use({
    renderer: {
      html(token) { return esc(typeof token === 'string' ? token : token.text); },
      link(href, title, text) {
        const h = typeof href === 'object' ? href.href : href;
        const t = typeof href === 'object' ? href.text : text;
        return /^https?:\/\//i.test(h || '') ? `<a href="${esc(h)}">${t}</a>` : esc(t);
      },
      image(href, title, text) { return esc(typeof href === 'object' ? href.text : text); },
    },
  });
}

export async function reportError(action, e) {
  if (caps.quota && isQuotaError(e.message)) { showQuota(e.message); return false; }
  if (e.envFail) {
    return confirmDialog(`${e.message}\n可能是网络不太好，或者浏览器拦住了计算环境的文件。你填的内容都还在，不会丢。`, { title: '计算环境没加载出来', okText: '重试' });
  }
  await alertDialog(e.message, { title: `${action}失败` });
  return false;
}

export async function runPlan() {
  const problems = validate();
  if (problems.length) { state.showRequired = true; decorateProblems(); await problemsDialog(problems); return; }
  const btn = $('#plan');
  let retry = false;
  btn.disabled = true;
  btn.textContent = '计算中…';
  clearSugLayer(); // 找站过程的圈和路线清掉，免得和方案的路线混在一起
  startProgress('计算方案');
  try {
    if (state.dirty) await save(true);
    const hash = configHash();
    state.result = await backend.plan(state.cfg);
    state.resultHash = hash;
    state.active = 0;
    const saved = applyResolved(state.result.resolved);
    if (saved) state.resultHash = configHash(); // 写回坐标不算改了方案
    renderResults(true);
    if (narrow().matches) setPane('plan'); // 手机上算完自动切到「方案」
    toast(saved ? `算好了。顺便记下了 ${saved} 个地点的坐标，下次不用再查` : '算好了');
  } catch (e) {
    retry = await reportError('计算', e);
  } finally {
    stopProgress();
    btn.disabled = false;
    btn.textContent = '计算方案';
    renderSteps();
  }
  if (retry) runPlan();
}

export function planStats(p) {
  const party = Object.fromEntries((state.cfg.people || []).map((x) => [x.name, Number(x.party) || 1]));
  return { carried: p.carried ?? Object.keys(p.rides).length, detour: p.detour, cars: p.taxi_cars || 0,
    taxi: Object.keys(p.taxi || {}).reduce((n, name) => n + (party[name] || 1), 0) };
}

// 每个方案一张卡片，关键数字放在前面：搭车人数、车主多绕、打车人数；去程和返程分开
export function renderTabs() {
  const tab = (p, i, leg, on) => {
    const departs = p.routes.filter((r) => r.depart && (leg === 'back' ? r.stops.length : true)).map((r) => `${r.driver} ${r.depart} 出发`).join('；');
    const st = planStats(p);
    return `<button class="tab ${on ? 'on' : ''}" data-plan="${i}" data-leg="${leg}" title="${esc(departs)}" aria-pressed="${on}">
      <span class="name">${leg === 'back' ? '返程' : '去程'}方案 ${i + 1}</span>
      <span class="stats">
        <span class="stat"><b>${st.carried}<small>人</small></b><span>搭车</span></span>
        <span class="stat"><b>${fmtMin(st.detour)}</b><span>车主多绕</span></span>
        <span class="stat"><b>${st.taxi}<small>人</small></b><span>打车${st.cars ? `（${st.cars} 辆）` : ''}</span></span>
      </span></button>`;
  };
  const group = (title, html) => `<div class="tabs-leg"><h3>${title}</h3><div class="tabs-grid">${html}</div></div>`;
  const outOn = state.result.outbound !== false;
  $('#tabs').innerHTML = (outOn && state.result.back ? '<p class="muted tabs-note">去程和返程可以分别选，方案页按你选的组合生成。</p>' : '')
    + (outOn ? group('去程', state.result.plans.map((p, i) => tab(p, i, 'out', state.viewLeg === 'out' && i === state.active)).join('')) : '')
    + (state.result.back ? group('返程', state.result.back.plans.map((p, i) => tab(p, i, 'back', state.viewLeg === 'back' && i === state.activeBack)).join('')) : '');
}

export function renderResults(fit) {
  if (!state.result.back) { state.viewLeg = 'out'; state.activeBack = 0; }
  if (state.result.outbound === false) { state.viewLeg = 'back'; state.active = 0; }
  renderTabs();
  $('#sharebtn').hidden = !caps.canPublish || !(state.result.plans.length || state.result.back?.plans.length);
  $('#warn').innerHTML = state.result.warnings.map((w) => `<div class="c-alert c-alert--warn"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>${esc(w)}</div></div>`).join('');
  $('#report').innerHTML = typeof marked !== 'undefined' ? marked.parse(state.result.report) : `<pre class="plain">${esc(state.result.report)}</pre>`; // marked 没加载出来：退化成纯文本
  $('#report').querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  drawPlan(fit);
  updateStale();
}

// 还没有方案时的空状态：说明下一步做什么
export const EMPTY_PLAN = `<div class="c-empty">
  <svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-car"/></svg>
  <h3>还没有方案</h3>
  <p>先在「填写」里填好目的地、成员和候选车站，给不开车的人填上车次，然后点「计算方案」。<br>填好的地点会马上出现在地图上；算出方案后可以发布一页方案，发给大家。</p>
  <button class="c-btn c-btn--primary" id="toFill">去填写</button>
</div>`;
export function renderEmptyPlan() {
  $('#report').innerHTML = EMPTY_PLAN;
  $('#toFill').addEventListener('click', () => setPane('fill'));
}

