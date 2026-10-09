// ---------- 推荐车站 ----------
// 找站设置存在 cfg.options.suggest（只存和默认值不同的项）；中文名、默认值、范围、单位、可选项、说明都取自 config-fields.json

import { applyResolved } from './actions.js';
import { backend } from './backend.js';
import { caps } from './caps.js';
import { toast } from './dialogs.js';
import { openDrawer, sugOpen } from './drawer.js';
import { fieldOf } from './fields.js';
import { showQuota } from './overlay.js';
import { startProgress, stopProgress } from './progress.js';
import { outboundOn, sgSettingsKey, state, sug } from './state.js';
import { syncSugLayer } from './sug-layer.js';
import { markDirty } from './sync.js';
import { fmtMin } from './time.js';
import { $, esc, isQuotaError, same } from './util.js';

export const SG_PREFIX = 'options.suggest.';
export const SG_GROUPS = [
  { title: '在哪找', keys: ['areas', 'dest_radius_km', 'home_radius_km'], quietFirst: true }, // 第一项的名字和分组标题重复：只留给读屏，不显示
  { title: '车主路上', keys: ['route_cover', 'route_step_km', 'route_radius_km', 'drivers', 'route_strategy', 'alt_routes'] },
  { title: '结果怎么排', keys: ['sort', 'over_limit', 'show_count', 'checked_count', 'filter_12306', 'max_searches'] },
];
export const SG_ALONG_ONLY = ['route_step_km', 'route_radius_km', 'alt_routes']; // 只有「沿路线取点」时才有意义
export const SG_ESTIMATE_DELAY = 600; // 改了设置后等这么久再估算（毫秒）
export const sgField = (key) => fieldOf(SG_PREFIX + key);
export const sgKeys = () => SG_GROUPS.flatMap((g) => g.keys);
export const sgStored = (key) => state.cfg?.options?.suggest?.[key];
export const sgVal = (key) => (sgStored(key) === undefined ? sgField(key)?.default : sgStored(key));
export const sgChoiceLabel = (key, value) => sgField(key)?.choices?.find((c) => c.value === value)?.label ?? String(value);
export const sgReasonKey = (reason) => String(reason).split('，')[0].split('（')[0];
export const sgCfgKey = () => JSON.stringify([state.cfg?.options, state.cfg?.venue, (state.cfg?.people || []).map(({ note, ...p }) => p)]);

// 车主名单：开车的成员（只规划返程时，返程不开车的不算）
export function sgDrivers() {
  return (state.cfg.people || []).filter((p) => p.car_seats !== undefined && p.name && (outboundOn() || p.return_drives !== false)).map((p) => p.name);
}
// 实际生效的设置（没存的项取默认值）
export function sgEffective() {
  return Object.fromEntries(sgKeys().map((k) => [k, sgVal(k)]));
}
export function sgDriverCount(S) {
  const all = sgDrivers(), chosen = S.drivers || [];
  return chosen.length ? all.filter((n) => chosen.includes(n)).length : all.length;
}

// 存一项设置：和默认值一样就删掉，全是默认时连 suggest 也不留
export function setSuggest(key, v) {
  const f = sgField(key);
  const canon = (list) => (f.choices || []).map((c) => c.value).filter((x) => list.includes(x));
  const isDefault = v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))
    || (f.type === 'multi' ? same(canon(v), f.default) : f.type === 'list' ? !v.length : v === f.default);
  state.cfg.options ??= {};
  if (isDefault) {
    if (state.cfg.options.suggest) {
      delete state.cfg.options.suggest[key];
      if (!Object.keys(state.cfg.options.suggest).length) delete state.cfg.options.suggest;
    }
  } else {
    state.cfg.options.suggest ??= {};
    state.cfg.options.suggest[key] = f.type === 'multi' ? canon(v) : v;
  }
}

// 一行摘要：这次会在哪些地方、按什么方式找
export function sgSummary(S, nDrivers) {
  const unit = (k) => sgField(k)?.unit || '';
  const parts = [];
  for (const a of S.areas || []) {
    if (a === 'dest') parts.push(`${sgChoiceLabel('areas', a)} ${S.dest_radius_km} ${unit('dest_radius_km')}`);
    else if (a === 'owner_home' || a === 'rider_home') parts.push(`${sgChoiceLabel('areas', a)} ${S.home_radius_km} ${unit('home_radius_km')}`);
    else if (a === 'owner_route') {
      parts.push(S.route_cover === 'detour' ? `${nDrivers} 位车主：${sgChoiceLabel('route_cover', 'detour')}`
        : `沿 ${nDrivers} 位车主的路线每 ${S.route_step_km} ${unit('route_step_km')}搜 ${S.route_radius_km} ${unit('route_radius_km')}`);
    }
  }
  if (!parts.length) parts.push('没选任何地方');
  parts.push(`按${sgChoiceLabel('sort', S.sort)}`);
  return parts.join(' · ');
}

// 就地提示：超出范围的输入、两项之间对不上的组合。后端会夹紧，这里说清楚会按什么算
export function sgProblems() {
  const out = {};
  const eff = sgEffective();
  for (const key of sgKeys()) {
    const f = sgField(key), v = sgStored(key);
    if (!f || v === undefined || (f.type !== 'number' && f.type !== 'integer')) continue;
    if (!Number.isFinite(v)) { out[key] = '请填数字'; continue; }
    if (f.type === 'integer' && !Number.isInteger(v)) { out[key] = '要填整数'; continue; }
    if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
      out[key] = `要在 ${f.min} 到 ${f.max}${f.unit ? ` ${f.unit}` : ''}之间，现在会按 ${Math.min(Math.max(v, f.min ?? -Infinity), f.max ?? Infinity)} 算`;
    }
  }
  const radius = sgField('route_radius_km'), g = radius?.greater_than;
  if (g && !out.route_radius_km && eff.route_cover === 'along' && eff.areas.includes('owner_route')) {
    const need = eff[g.path.slice(SG_PREFIX.length)] * g.factor;
    if (!(eff.route_radius_km > need)) out.route_radius_km = `要大于 ${need} ${radius.unit}（间隔的一半），不然两圈之间连不上；现在会自动加大`;
  }
  if (!out.checked_count && eff.checked_count > eff.show_count) out.checked_count = `比显示个数（${eff.show_count}）还多，现在会按 ${eff.show_count} 算`;
  return out;
}

// 从 FIELDS 生成一项设置的控件
export function sgFieldHtml(key, quiet = false) {
  const f = sgField(key);
  if (!f) return '';
  const id = `sg-${key}`, val = sgVal(key), stored = sgStored(key);
  const hint = f.hint ? `<span class="c-field__hint" id="${id}-hint">${esc(f.hint)}</span>` : '';
  const err = `<span class="c-field__error" id="${id}-err" data-sg-err="${key}" hidden></span>`;
  const desc = `${f.hint ? `${id}-hint ` : ''}${id}-err`;
  const wrap = (inner, wide) => `<div class="c-field c-settings__field${wide ? ' c-settings__field--wide' : ''}" data-sg-wrap="${key}">${inner}${hint}${err}</div>`;
  const label = esc(f.label);
  const lc = `c-field__label${quiet ? ' c-sr-only' : ''}`; // quiet：名字不显示，读屏照读
  if (f.type === 'number' || f.type === 'integer') {
    return wrap(`<label class="${lc}" for="${id}">${label}</label>
      <div class="c-unit-input"><input class="c-input" id="${id}" type="number" inputmode="${f.type === 'integer' ? 'numeric' : 'decimal'}" data-sg="${key}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''} step="${f.type === 'integer' ? 1 : 'any'}"
        placeholder="${esc(f.default)}" value="${esc(stored ?? '')}" aria-describedby="${desc}">${f.unit ? `<span class="c-unit-input__unit" aria-hidden="true">${esc(f.unit)}</span>` : ''}</div>`);
  }
  if (f.type === 'choice' && f.choices.length > 2) {
    return wrap(`<label class="${lc}" for="${id}">${label}</label>
      <select class="c-select" id="${id}" data-sg="${key}" aria-describedby="${desc}">${f.choices.map((c) => `<option value="${esc(c.value)}"${c.value === val ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`);
  }
  if (f.type === 'choice') {
    const pill = f.choices.every((c) => c.label.length <= 10);
    return wrap(`<span class="${lc}" id="${id}-l">${label}</span>
      <div class="${pill ? 'c-choices' : 'c-choices c-choices--stack'}" role="radiogroup" aria-labelledby="${id}-l" aria-describedby="${desc}">${f.choices.map((c) => `<label class="c-check${pill ? ' c-check--pill' : ''}"><input type="radio" name="${id}" value="${esc(c.value)}" data-sg="${key}"${c.value === val ? ' checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>`, true);
  }
  if (f.type === 'multi') {
    return wrap(`<span class="${lc}" id="${id}-l">${label}</span>
      <div class="c-choices" role="group" aria-labelledby="${id}-l" aria-describedby="${desc}">${f.choices.map((c) => `<label class="c-check c-check--pill"><input type="checkbox" value="${esc(c.value)}" data-sg="${key}"${val.includes(c.value) ? ' checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>`, true);
  }
  if (f.type === 'boolean') {
    return wrap(`<label class="c-switch"><input type="checkbox" role="switch" id="${id}" data-sg="${key}"${val ? ' checked' : ''} aria-describedby="${desc}"><span class="c-switch__track"></span>${esc(f.label)}</label>`, true);
  }
  // list：按名字勾选车主；一个都不勾和全勾一样，都是用全部车主
  const names = sgDrivers(), chosen = stored || [];
  return wrap(`<span class="${lc}" id="${id}-l">${label}</span>
    ${names.length ? `<div class="c-choices" role="group" aria-labelledby="${id}-l" aria-describedby="${desc}">${names.map((n) => `<label class="c-check c-check--pill"><input type="checkbox" value="${esc(n)}" data-sg="${key}"${!chosen.length || chosen.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>`
      : '<div class="muted">还没有开车的成员</div>'}
    <span class="c-field__hint">${esc(f.default_note || '')}${f.default_note ? '。' : ''}取消勾选的车主，不沿他的路线找站</span>`, true);
}

export function sgReadControl(t) {
  const key = t.dataset.sg, f = sgField(key);
  const panel = $('#sgPanel');
  const checked = () => [...panel.querySelectorAll(`[data-sg="${key}"]:checked`)].map((el) => el.value);
  if (f.type === 'number' || f.type === 'integer') return t.value === '' ? undefined : Number(t.value);
  if (f.type === 'boolean') return t.checked;
  if (f.type === 'multi') return f.choices.map((c) => c.value).filter((v) => checked().includes(String(v)));
  if (f.type === 'list') {
    const names = checked(), all = sgDrivers();
    return names.length === all.length ? [] : names;
  }
  return f.choices.find((c) => String(c.value) === t.value)?.value;
}

export function renderSgPanel() {
  const panel = $('#sgPanel');
  if (!panel) return;
  panel.innerHTML = SG_GROUPS.map((g) => `<fieldset class="c-settings__group"><legend>${esc(g.title)}</legend><div class="c-settings__grid">${g.keys.map((k, i) => sgFieldHtml(k, Boolean(g.quietFirst) && i === 0)).join('')}</div></fieldset>`).join('')
    + '<button class="c-btn c-btn--sm" data-sg-reset>恢复默认</button>';
  sgRefresh();
}

// 改了设置后更新：摘要、哪些项显示、就地提示、「恢复默认」是否可点
export function sgRefresh() {
  const S = sgEffective();
  const changed = Object.keys(state.cfg?.options?.suggest || {}).length;
  const sum = $('#sgSummary');
  if (!sum) return;
  sum.innerHTML = `${esc(sgSummary(S, sgDriverCount(S)))}${changed ? ` <span class="c-tag c-tag--accent">改了 ${changed} 项</span>` : ''}`;
  $('#sgToggle').textContent = sug.settingsOpen ? '收起设置' : '改设置';
  $('#sgToggle').setAttribute('aria-expanded', String(sug.settingsOpen));
  $('#sgPanel').hidden = !sug.settingsOpen;
  $('#sgRoot').classList.toggle('is-editing', sug.settingsOpen); // 设置展开时，估算和「开始找」贴在抽屉底部，改一项就能看到估算怎么变
  const panel = $('#sgPanel');
  for (const key of SG_ALONG_ONLY) {
    const w = panel.querySelector(`[data-sg-wrap="${key}"]`);
    if (w) w.hidden = S.route_cover !== 'along';
  }
  const rider = panel.querySelector('#sg-sort option[value="rider_home"]');
  if (rider) rider.disabled = !S.areas.includes('rider_home');
  const problems = sgProblems();
  for (const key of sgKeys()) {
    const w = panel.querySelector(`[data-sg-wrap="${key}"]`), e = panel.querySelector(`[data-sg-err="${key}"]`);
    if (!w || !e) continue;
    e.textContent = problems[key] || '';
    e.hidden = !problems[key];
    w.classList.toggle('has-error', Boolean(problems[key]));
    w.querySelector('input.c-input')?.setAttribute('aria-invalid', String(Boolean(problems[key])));
  }
  const reset = panel.querySelector('[data-sg-reset]');
  if (reset) reset.disabled = !changed;
  renderSugOut();
}

export function sgChanged(t) {
  const key = t.dataset.sg;
  if (key === 'drivers' && !$('#sgPanel').querySelector('[data-sg="drivers"]:checked')) {
    t.checked = true;
    toast('至少留一位车主；想用全部车主，就都勾上');
    return;
  }
  const v = sgReadControl(t);
  setSuggest(key, v);
  if (key === 'areas' && sgVal('sort') === 'rider_home' && !sgVal('areas').includes('rider_home')) {
    setSuggest('sort', 'detour'); // 没找乘客出发地附近时，「离乘客家最近」没有意义
    const sel = $('#sg-sort');
    if (sel) sel.value = 'detour';
  }
  markDirty();
  sgRefresh();
  scheduleSugEstimate();
}

// ---------- 先估算 ----------
export function sgEstimateText(est, S) {
  const n = est.searches_min === est.searches_max ? `${est.searches_min}` : `${est.searches_min}–${est.searches_max}`;
  return `这次大约要 ${n} 次地点搜索（单次上限 ${S.max_searches}）${est.routes ? `，另查 ${est.routes} 条车主路线` : ''}`;
}
export function sgCircleKinds(trace) {
  const label = { dest: sgChoiceLabel('areas', 'dest'), home: sgChoiceLabel('areas', 'owner_home'), route: sgChoiceLabel('areas', 'owner_route'),
    detour: sgChoiceLabel('route_cover', 'detour'), rider: sgChoiceLabel('areas', 'rider_home') };
  const n = {};
  for (const c of trace?.circles || []) n[c.kind] = (n[c.kind] || 0) + 1;
  return Object.entries(n).map(([k, c]) => `${label[k] || k} ${c} 个圈`).join('，');
}

export function renderSugEst() {
  const box = $('#sgEst');
  if (!box) return;
  const noSearch = !caps.canSearch; // 不能实际搜索（试玩）：只估算，「开始找」不能点
  const out = sug.est, est = out?.estimate;
  const waiting = sug.estBusy || sug.pending;
  let html = '', notesHtml = '';
  let why = '';
  if (waiting) html = '<p class="c-estimate muted">正在估算要搜多少次…</p>';
  else if (sug.estErr) {
    html = `<div class="c-alert c-alert--danger"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div><p>估算没成功：${esc(sug.estErr)}</p><p><button class="c-btn c-btn--sm" data-sg-retry-est>重试估算</button></p></div></div>`;
  } else if (est) {
    const S = out.settings, cap = S.max_searches;
    html = `<p class="c-estimate"><b>${esc(sgEstimateText(est, S))}</b></p>`;
    if (est.over_cap) {
      html += `<div class="c-alert c-alert--warn"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>这次至少要 ${est.searches_min} 次地点搜索，超过单次上限 ${cap} 次（${esc(sgCircleKinds(out.trace))}）。把范围调小，或者把「${esc(sgField('max_searches').label)}」调高（最多 ${sgField('max_searches').max} ${esc(sgField('max_searches').unit)}）。</div></div>`;
    } else if (est.may_exceed) {
      html += `<p class="c-estimate muted">翻页多的话，可能会到上限 ${cap} 次，到了就停，结果里会写明。</p>`;
    }
    const notes = (out.notes || []).filter((x) => !/^这次至少要/.test(x));
    if (notes.length && !sug.result) { // 找过以后，说明放在结果里
      notesHtml = `<div class="c-callout"><ul class="c-callout__list">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    }
    if (est.over_cap) why = '估算超过单次上限，先把范围调小，或者调高上限。';
  }
  if (noSearch) why = caps.text.noSearchWhy;
  else if (waiting && !why) why = '正在估算，估完才能开始。';
  box.innerHTML = html;
  $('#sgNotes').innerHTML = notesHtml;
  const go = $('#sgGo');
  go.disabled = Boolean(why) || sug.running;
  go.textContent = sug.running ? '正在找…' : sug.result ? '重新找' : '开始找';
  go.classList.toggle('is-loading', sug.running);
  $('#sgWhy').textContent = why;
  $('#sgWhy').hidden = !why;
  $('#sgWhy').classList.toggle('c-why--info', noSearch);
}

export function scheduleSugEstimate(delay = SG_ESTIMATE_DELAY) {
  clearTimeout(sug.timer);
  sug.pending = true;
  renderSugEst();
  sug.timer = setTimeout(runSugEstimate, delay);
}

export async function runSugEstimate() {
  clearTimeout(sug.timer);
  sug.pending = false;
  if (!sugOpen()) return;
  if (sug.running) { sug.pending = true; return; } // 正在找：找完再估
  const seq = ++sug.seq;
  sug.estBusy = true;
  sug.estErr = null;
  renderSugEst();
  try {
    const out = await backend.suggest(state.cfg, true);
    if (seq !== sug.seq) return;
    applyResolved(out.resolved);
    sug.est = out;
    sug.estKey = sgCfgKey();
    sug.trace = out.trace;
    sug.estBusy = false;
    renderSugEst();
    renderSugOut();
    syncSugLayer(true);
  } catch (e) {
    if (seq !== sug.seq) return;
    sug.estBusy = false;
    sug.est = null;
    sug.estErr = e.message;
    renderSugEst();
    if (caps.quota && isQuotaError(e.message)) showQuota(e.message);
  }
}

// ---------- 结果 ----------
export const sgMin = (m) => (m < 60 ? `${m} 分` : fmtMin(m));
export function sgTags(r) {
  const best = Math.min(...r.detours.filter((d) => d.minutes != null && !d.over).map((d) => d.minutes));
  const tags = r.detours.map((d) => {
    const title = d.minutes == null ? `${d.driver}：量不出绕路` : `${d.driver}：${outboundOn() ? '家 → 站 → 目的地' : '目的地 → 站 → 家'}比直达多 ${d.minutes} 分钟，上限 ${d.limit} 分钟`;
    if (d.minutes == null) return `<span class="c-tag" title="${esc(title)}">${esc(d.driver)} 量不出</span>`;
    if (d.over) return `<span class="c-tag c-tag--over" title="${esc(title)}">${esc(d.driver)} +${sgMin(d.minutes)} · 超过上限</span>`;
    return `<span class="c-tag ${d.minutes === best ? 'c-tag--accent c-tag--best' : 'c-tag--ok'}" title="${esc(title)}">${esc(d.driver)} +${sgMin(d.minutes)}</span>`;
  });
  if (r.over_all) tags.push('<span class="c-tag c-tag--danger">车主都要绕很远</span>');
  return tags.length ? `<span class="c-tags">${tags.join('')}</span>` : '';
}
export function sgRowHtml(r, i, have) {
  const inList = have.has(r.name);
  const on = inList ? false : sug.checked[r.name] ?? r.checked;
  return `<label class="c-pick-row${r.over_all ? ' is-off' : ''}"><input type="checkbox" data-sug="${i}"${on ? ' checked' : ''}${inList ? ' disabled' : ''}>
    <span><b>${esc(r.name)}</b> <span class="muted">${esc(r.where)}</span>${inList ? ' <span class="c-tag c-tag--info">已在候选站</span>' : ''}
      <small>${outboundOn() ? '到目的地约' : '从目的地到站约'} ${r.to_venue == null ? '?' : fmtMin(r.to_venue)}</small>${sgTags(r)}</span></label>`;
}
// 分组标题只取原因的前半句，括号里的补充说明写在标题下面
export const sgReasonNote = (key, list) => { const detail = list[0].reason.slice(key.length).replace(/^[（(]|[）)]$/g, ''); return detail ? `<p class="muted sg-line">${esc(detail)}</p>` : ''; };
export function sgGroupBy(list) {
  const m = new Map();
  for (const x of list) { const k = sgReasonKey(x.reason); m.set(k, [...(m.get(k) || []), x]); }
  return [...m];
}

export function renderSugOut() {
  const box = $('#sgOut');
  if (!box) return;
  if (sug.running) {
    box.innerHTML = '<div class="c-empty">正在找：先查车主路线，再逐个圈搜火车站。要查几十个点，第一次可能要一两分钟，之后会快很多。<div id="drawerProgress" class="muted"></div></div>';
    return;
  }
  if (sug.error) {
    box.innerHTML = `<div class="c-alert c-alert--danger"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div><p>${esc(sug.error.message)}</p>${sug.error.envFail ? '<p>可能是网络不太好，已填的内容都还在。</p><p><button class="c-btn c-btn--sm" data-sg-go>重试</button></p>' : ''}</div></div>`;
    return;
  }
  const out = sug.result;
  if (!out) { box.innerHTML = ''; return; }
  const have = new Set(state.cfg.stations.map((s) => s.name));
  const dropped = out.dropped.filter((d) => d.where !== '车主路线'); // 车主路线查不到的，下面单独说
  const searched = out.trace.circles.filter((c) => c.searched).length;
  const dropText = dropped.length ? `；去掉 ${dropped.length} 个：${sgGroupBy(dropped).map(([k, v]) => `${k} ${v.length} 个`).join('，')}` : '';
  const moreText = out.more.length ? `；另有 ${out.more.length} 个没列出` : '';
  const stale = sug.resultKey !== sgSettingsKey();
  const S = out.settings;
  let html = '';
  if (stale) html += '<div class="c-alert c-alert--info" role="status"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-info"/></svg><div>设置改过了，点「重新找」更新。下面还是上一次的结果。</div></div>';
  html += `<p class="sg-line"><b>搜了 ${searched} 个圈（地点搜索 ${out.summary.searches} 次），找到 ${out.summary.found} 个可用的站${esc(dropText)}${moreText}。</b></p>
    <p class="muted sg-line">这次的设置：${esc(sgSummary(S, sgDriverCount(S)))}</p>`;
  for (const d of out.summary.skipped_drivers) html += `<div class="c-alert c-alert--warn"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>${esc(d.driver)}：${esc(d.reason)}</div></div>`;
  if (out.notes.length) html += `<div class="c-callout"><ul class="c-callout__list">${out.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  if (out.stations.length) {
    html += `<p class="muted sg-line">按「${esc(sgChoiceLabel('sort', S.sort))}」排序。标签是每位车主${outboundOn() ? '「家 → 站 → 目的地」' : '「目的地 → 站 → 家」'}比直达多绕的时间；超过各自上限的标灰，默认不勾选。勾上的会加入候选站，算方案时再按各自的上限决定谁去${outboundOn() ? '接' : '送'}。${outboundOn() ? '' : '只规划返程，顺路是指「目的地 → 站 → 车主家」。'}</p>
      ${out.stations.map((r, i) => sgRowHtml(r, i, have)).join('')}
      <button class="c-btn c-btn--primary" data-sg-add style="margin-top:12px">加入选中的车站</button>`;
  } else {
    html += '<div class="c-empty">附近没找到可用的火车站，可以手动添加，或者看下面没列出的站。</div>';
  }
  if (out.more.length || dropped.length) {
    html += `<details class="c-fold"><summary>没列出的站（${out.more.length + dropped.length} 个）</summary>`;
    for (const [reason, list] of sgGroupBy(out.more)) {
      html += `<h4 class="c-fold__title">${esc(reason)}（${list.length} 个）</h4>${sgReasonNote(reason, list)}${list.map((r) => {
        const j = out.more.indexOf(r);
        return `<div class="c-fold__row"><span><b>${esc(r.name)}</b> <span class="muted">${esc(r.where)}</span>
          <small>${outboundOn() ? '到目的地约' : '从目的地到站约'} ${r.to_venue == null ? '?' : fmtMin(r.to_venue)}</small>${sgTags(r)}</span>
          ${have.has(r.name) ? '<span class="c-tag c-tag--info">已在候选站</span>' : `<button class="c-btn c-btn--sm" data-sg-more="${j}">加入</button>`}</div>`;
      }).join('')}`;
    }
    if (dropped.length) {
      html += '<p class="muted sg-line">下面这些没有坐标，只列名字和原因。要用的话，点「+ 手动添加」搜站名。</p>';
      for (const [reason, list] of sgGroupBy(dropped)) {
        html += `<h4 class="c-fold__title">${esc(reason)}（${list.length} 个）</h4>${sgReasonNote(reason, list)}<p class="sg-names">${list.map((d) => `${esc(d.name)}<span class="muted">（${esc(d.where)}）</span>`).join('、')}</p>`;
      }
    }
    html += '</details>';
  }
  box.innerHTML = html;
}

export async function runSuggest() {
  if (!caps.canSearch || sug.running || sug.est?.estimate?.over_cap) return;
  clearTimeout(sug.timer);
  sug.pending = false;
  sug.seq += 1; // 让还在路上的估算作废
  sug.estBusy = false;
  sug.running = true;
  sug.error = null;
  const key = sgSettingsKey();
  renderSugEst();
  renderSugOut();
  startProgress('推荐车站');
  try {
    const out = await backend.suggest(state.cfg, false);
    stopProgress();
    sug.running = false;
    applyResolved(out.resolved);
    sug.result = out;
    sug.resultKey = key;
    sug.checked = {};
    sug.trace = out.trace;
    sug.est = out;
    sug.estKey = sgCfgKey();
    sug.fitted = false; // 找完再缩放一次，让找到的站都在视野里
  } catch (e) {
    stopProgress();
    sug.running = false;
    sug.error = e;
    if (caps.quota && isQuotaError(e.message)) showQuota(e.message);
  }
  if (!sugOpen()) { syncSugLayer(true); return; }
  renderSugEst();
  renderSugOut();
  syncSugLayer(true);
  if (sug.pending) scheduleSugEstimate(); // 找的时候改过设置
}

export function addSuggested(list) {
  let n = 0;
  for (const s of list) {
    if (state.cfg.stations.some((x) => x.name === s.name)) continue;
    state.cfg.stations.push({ name: s.name, city: s.city || undefined, location: s.location });
    n += 1;
  }
  return n;
}

// 入口：打开抽屉，设置折叠成一行摘要，同时估算
export function suggestStations() {
  if (!caps.fixedSample && !state.cfg.people.some((p) => p.car_seats !== undefined) && !state.cfg.venue.location && !state.cfg.venue.address) {
    toast('先填目的地和开车的成员，推荐才有依据');
    return;
  }
  openDrawer('推荐车站', sgShellHtml(), 'suggest');
  sug.fitted = false;
  sug.error = null;
  renderSgPanel();
  renderSugEst();
  renderSugOut();
  if (sug.est && sug.estKey === sgCfgKey() && !sug.estErr) { syncSugLayer(true); return; } // 填的内容没变：沿用上次的估算
  scheduleSugEstimate(0);
}
export function sgShellHtml() {
  return `<div class="c-settings" id="sgRoot">
    <section class="sg-set" aria-label="找站设置">
      <div class="c-settings__bar"><p class="c-settings__sum" id="sgSummary"></p><button class="c-btn c-btn--sm" id="sgToggle" data-sg-toggle aria-expanded="false" aria-controls="sgPanel">改设置</button></div>
      <div class="c-settings__panel" id="sgPanel" hidden></div>
    </section>
    <div class="c-settings__foot">
      <div id="sgEst" aria-live="polite"></div>
      <div class="c-settings__actions">
        <button class="c-btn c-btn--primary" id="sgGo" data-sg-go>开始找</button>
        <label class="c-switch"><input type="checkbox" role="switch" data-sg-layer${sug.layerOn ? ' checked' : ''}><span class="c-switch__track"></span>在地图上显示找站过程</label>
        <button class="c-btn c-btn--sm sg-peek" data-sg-map>去地图上看</button>
      </div>
      <p class="c-field__hint c-why" id="sgWhy" hidden></p>
    </div>
    <div id="sgNotes"></div>
    <div id="sgOut"></div>
  </div>`;
}
// 别处（一起编辑的人、导入、恢复历史）改了设置：抽屉开着时同步一下，正在输入的那一格不动
export function sgSyncFromCfg() {
  if (!sugOpen() || !$('#sgPanel') || $('#drawer').contains(document.activeElement)) return;
  renderSgPanel();
  if (sug.estKey !== sgCfgKey() && !sug.running && !sug.estBusy) scheduleSugEstimate();
}

