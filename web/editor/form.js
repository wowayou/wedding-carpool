// ---------- 表单 ----------

import { caps } from './caps.js';
import { emit } from './events.js';
import { defaultOf, fieldOf, noteOf, placeholderOf } from './fields.js';
import { schedulePreview } from './map.js';
import { elementOf, getPath, pathOf } from './paths.js';
import { markPeers } from './peers.js';
import { link12306 } from './rail12306.js';
import { isStale, outboundOn, state, trip } from './state.js';
import { $, esc } from './util.js';
import { decorateProblems } from './validate.js';

export function field(label, path, { type = 'text', placeholder = placeholderOf(path), min = fieldOf(path)?.min ?? null, readonly = false } = {}) {
  return `<label class="f"><span>${esc(label)}</span><input class="c-input" data-bind="${path}" data-type="${type}"
    type="${type === 'number' ? 'number' : 'text'}"${readonly ? ' readonly' : ''}${min !== null ? ` min="${min}"` : ''}${type === 'number' ? ' inputmode="decimal"' : ''} value="${esc(getPath(path))}" placeholder="${esc(placeholder)}"></label>`;
}

export function locLine(base) {
  const loc = getPath(base + '.location');
  if (caps.fixedSample) return loc ? `<div class="loc">示意坐标 ${esc(loc)}</div>` : ''; // 试玩不能改地点，也就没有「清除」
  return loc
    ? `<div class="loc">已定位 ${esc(loc)}${getPath(base + '.city') ? ' · ' + esc(getPath(base + '.city')) : ''} <button class="c-btn c-btn--link" data-clearloc="${base}">清除</button></div>`
    : `<div class="loc missing">还没定位：点「搜索」选一个；不选的话，计算时会按文字自动定位并记下来</div>`;
}

export function placeField(label, base, textKey, placeholder, hint = '') {
  if (caps.fixedSample) return `<div class="place">${field(label, `${base}.${textKey}`, { placeholder, readonly: true })}</div>${locLine(base)}`; // 试玩：地址只读，没有搜索
  return `<div class="place">${field(label, `${base}.${textKey}`, { placeholder })}
    <button class="c-btn c-btn--sm" data-search="${base}" data-text="${textKey}">搜索</button></div>
    ${hint ? `<div class="place-hint">${esc(hint)}</div>` : ''}${locLine(base)}<div class="cands" data-cands="${base}"></div>`;
}

export function stationRow(s, i) {
  if (caps.fixedSample) return `<div class="station">
    <input class="c-input" data-station-name="${i}" data-old="${esc(s.name)}" value="${esc(s.name)}" aria-label="站名" readonly>
    <input class="c-input" data-bind="stations.${i}.city" value="${esc(s.city)}" aria-label="城市" readonly>
    <button class="c-btn c-btn--link is-danger" data-del="stations.${i}">删除</button>
    ${s.location ? `<div class="loc">示意坐标 ${esc(s.location)}</div>` : ''}
  </div>`;
  return `<div class="station">
    <input class="c-input" data-station-name="${i}" data-old="${esc(s.name)}" value="${esc(s.name)}" placeholder="站名，如 杭州东站" aria-label="站名">
    <input class="c-input" data-bind="stations.${i}.city" value="${esc(s.city)}" placeholder="城市" aria-label="城市">
    <button class="c-btn c-btn--sm" data-search="stations.${i}" data-text="name">搜索</button>
    <button class="c-btn c-btn--link is-danger" data-del="stations.${i}">删除</button>
    ${s.location ? `<div class="loc">已定位 ${esc(s.location)} <button class="c-btn c-btn--link" data-clearloc="stations.${i}">清除</button></div>` : ''}
    <div class="cands" data-cands="stations.${i}"></div>
  </div>`;
}

export function personCard(p, i) {
  const base = `people.${i}`;
  const drives = p.car_seats !== undefined;
  const stations = state.cfg.stations || [];
  const rails = p.rail_min || {};
  const trains = p.trains || {};
  const backOn = Boolean(state.cfg.return?.enabled);
  const outOn = outboundOn();
  const backTrains = p.return_trains || {};
  const backPart = !backOn ? '' : `<div class="rail">
      <div class="row">${field('离场时间（返程，可选）', base + '.leave_time', { placeholder: leavePlaceholder() })}</div>
      <div class="sub">离场时间不填就是散场时间。车主走得比你早，就带不了你；你最多等车主 ${esc(state.cfg.return?.max_wait_min ?? defaultOf('return.max_wait_min'))} 分钟。</div>
      <div class="sub">返程：各站坐哪趟车回去，如 <code>G1234 20:30→23:50</code>（第一个时刻是发车时间，用来判断赶不赶得上）。都留空表示返程不坐火车或另行安排。</div>
      ${stations.map((s) => `<div class="rail-row"><span title="${esc(s.name)}">${esc(s.name)}</span>
          <input class="c-input span2" data-backtrain="${i}" data-station="${esc(s.name)}" value="${esc(backTrains[s.name])}" placeholder="车次 发车→到达" aria-label="${esc(s.name)}返程车次">
          ${railLinkHtml(p, i, s.name || '', true)}</div>`).join('')}
    </div>`;
  const riderPart = `
    <div class="row">${field('同行人数（含自己）', base + '.party', { type: 'number' })}
      <label class="toggle" style="flex:2"><input type="checkbox" data-home="${i}" ${p.pickup_at_home === false ? '' : 'checked'}> 顺路的话，车主可以到家附近接</label></div>
    ${!outOn ? '' : `<div class="rail">
      <div class="sub">能去的站填 12306 查到的车次和时刻，如 <code>G1234 08:00→11:30</code>，会自动算用时并对齐接人时间；也可以只填分钟数（含去车站和候车）。都留空表示不去这个站。点「查」打开已填好出发地和日期的 12306。</div>
      ${stations.length ? stations.map((s) => `<div class="rail-row"><span title="${esc(s.name)}">${esc(s.name)}</span>
          <input class="c-input" data-train="${i}" data-station="${esc(s.name)}" value="${esc(trains[s.name])}" placeholder="车次 发车→到站" aria-label="${esc(s.name)}车次">
          <input class="c-input" type="number" min="0" inputmode="numeric" data-rail="${i}" data-station="${esc(s.name)}" value="${esc(rails[s.name])}" placeholder="分钟" aria-label="${esc(s.name)}用时（分钟）">
          ${railLinkHtml(p, i, s.name || '', false)}</div>`).join('') : '<div class="muted">先在上面添加候选车站</div>'}
      ${Object.keys(rails).length || Object.keys(trains).length ? '' : `<div class="hint">${caps.text.noTrainHint(defaultOf('options.station_cost_min'))}</div>`}
    </div>`}${backPart}`;
  const driverPart = `<div class="row">${field('空座', base + '.car_seats', { type: 'number' })}
    ${field('最多绕路（分钟）', base + '.max_detour_min', { type: 'number', placeholder: detourHint() })}</div>
    ${!backOn ? '' : `<div class="row">${field('离场时间（返程，车几点出发）', base + '.leave_time', { placeholder: leavePlaceholder() })}</div>
    <div class="row"><label class="toggle" style="flex:2"><input type="checkbox" data-backdrive="${i}" ${p.return_drives === false ? '' : 'checked'}> 返程也开车，可以顺路送人</label>
      ${p.return_drives === false ? '' : field('返程最多绕路', base + '.return_max_detour_min', { type: 'number', placeholder: noteOf('people[].return_max_detour_min') })}</div>`}`;
  return `<div class="card c-card ${drives ? 'c-card--drive driver' : 'c-card--ride rider'}">
    <div class="row head">${field('名字', base + '.name', { placeholder: '比如 老王' })}
      <label class="toggle"><input type="checkbox" data-car="${i}" ${drives ? 'checked' : ''}> 开车</label>
      <button class="c-btn c-btn--link is-danger" data-del="people.${i}">删除</button></div>
    ${placeField('出发地', base, 'from', '如 浙江省杭州市西湖区某某小区', '不用精确到门牌号，填小区、地标或附近路口就够了；方案页不会显示精确的出发地。')}
    ${drives ? driverPart : riderPart}
    <label class="f"><span>备注</span><textarea class="c-textarea" rows="2" data-bind="${base}.note" style="min-height:64px">${esc(p.note)}</textarea></label>
  </div>`;
}

// 12306 查询链接的 <a>：始终渲染，没有可用地址时只是看不见（占位不变）。href、标题由 refreshDerived() 原地更新
export function railLinkHtml(p, i, stationName, back) {
  return `<a class="c-btn c-btn--sm" data-link12306="${i}" data-station="${esc(stationName)}"${back ? ' data-back' : ''} target="_blank" rel="noopener">查</a>`;
}
export const detourHint = () => '默认 ' + (state.cfg.options?.max_detour_min ?? defaultOf('options.max_detour_min'));
export const leavePlaceholder = () => state.cfg.return?.depart_time || noteOf('people[].leave_time');
export const returnDatePlaceholder = () => (outboundOn() && state.cfg.options?.travel_date) || placeholderOf('return.date');

// 字段失焦（change）时只更新由字段值推出来的内容，不重建表单。
// 重建会换掉所有输入框：用户按下鼠标时正好触发失焦，那一下点击会落在被换掉的元素上，点击和输入就丢了。
// 范围：12306 链接的地址和标题、「默认 N」「返程日期」这类占位文字、步骤条、校验提示。（保留期提示只随行程数据变，过期方案提示在每次输入时由 markDirty 更新。）
// 结构变化（加删成员或车站、开车、返程开关、导入、恢复历史、远端合并）才整体重绘 renderForm()。
export function refreshDerived() {
  for (const a of document.querySelectorAll('#form a[data-link12306]')) {
    const p = state.cfg.people[Number(a.dataset.link12306)];
    const back = a.hasAttribute('data-back');
    const href = p ? link12306(p, a.dataset.station, back) : '';
    if (href) {
      a.href = href;
      a.title = back ? `在 12306 查从 ${a.dataset.station} 回去的车次` : `在 12306 查 ${p.name || ''} 到 ${a.dataset.station} 的车次`;
      a.style.visibility = '';
    } else {
      a.removeAttribute('href');
      a.removeAttribute('title');
      a.style.visibility = 'hidden';
    }
  }
  for (const el of document.querySelectorAll('#form [data-bind$=".max_detour_min"]')) {
    if (/^people\.\d+\.max_detour_min$/.test(el.dataset.bind)) el.placeholder = detourHint();
  }
  const back = document.querySelector('#form [data-bind="return.date"]');
  if (back) back.placeholder = returnDatePlaceholder();
  for (const el of document.querySelectorAll('#form [data-bind$=".leave_time"]')) el.placeholder = leavePlaceholder();
  renderSteps();
  decorateProblems();
}

export function renderForm() {
  state.cfg.venue ??= {}; state.cfg.options ??= {}; state.cfg.stations ??= []; state.cfg.people ??= [];
  const left = trip.expiresAt ? Math.ceil((trip.expiresAt - Date.now()) / 864e5) : Infinity;
  const fixed = caps.fixedSample; // 固定示例（试玩）：没有加成员、加车站和搜索
  $('#form').innerHTML = `${fixed ? `<div class="c-alert c-alert--info try-banner" id="tryBanner"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>试玩模式：虚构的行程，行车时间按直线距离估算，不保存。想规划你们自己的出行，请新建行程（需要邀请码或高德 Key）。<div class="row"><button class="c-btn c-btn--sm" data-try-reset>恢复示例</button><a class="c-btn c-btn--sm c-btn--primary" href="/#create">新建行程</a></div></div></div>` : ''}${left <= 7 ? `<div class="c-alert c-alert--warn" style="margin:var(--sp-3) var(--sp-4) 0"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>这个行程 ${left <= 0 ? '即将' : `${left} 天后`}自动删除（出行日期过后 60 天、或 180 天没人编辑）。需要留存的话，在「更多」里导出配置。</div></div>` : ''}
    <section id="sec-legs"><h2>规划哪几段</h2>
      <div><label class="toggle"><input type="checkbox" data-outbound-toggle ${outboundOn() ? 'checked' : ''}> 去程：从各自的出发地到目的地</label></div>
      <div><label class="toggle"><input type="checkbox" data-return-toggle ${state.cfg.return?.enabled ? 'checked' : ''}> 返程：散场后谁顺路把谁送到车站</label></div>
      <div class="muted">两段分开算，至少选一段。算完后去程方案和返程方案可以分别选，同一个人去程和返程坐谁的车互不影响。</div>
    </section>
    <section id="sec-venue"><h2>① 目的地</h2>
      ${field('名称', 'venue.name', { placeholder: '如 某某大酒店' })}
      ${placeField('地址或店名', 'venue', 'address', '搜索后选一个，坐标最准')}
    </section>
    <section id="sec-people"><h2>② 成员${fixed ? '' : ' <span class="adders"><button class="c-btn c-btn--link" data-add="driver">+ 开车的</button><button class="c-btn c-btn--link" data-add="rider">+ 不开车的</button></span>'}</h2>
      ${state.cfg.people.map(personCard).join('') || '<div class="muted">先加几位成员：开车的填空座，不开车的之后填车次。</div>'}
    </section>
    <section id="sec-stations"><h2>③ 候选车站 <span class="adders"><button class="c-btn c-btn--link" data-suggest>推荐车站</button>${fixed ? '' : '<button class="c-btn c-btn--link" data-add="station">+ 手动添加</button>'}</span></h2>
      ${state.cfg.stations.map(stationRow).join('') || (fixed ? '<div class="muted">候选站都删光了：点上面的「恢复示例」。</div>' : '<div class="muted">点「推荐车站」：在目的地周边、车主出发地附近和沿途找火车站，按顺路程度排好。</div>')}
      ${fixed ? '<div class="muted">试玩里的候选站是固定的，只能删除。「推荐车站」可以打开看看设置、估算和地图上的搜索范围，但试玩不能实际搜索；自己的行程可以用它在目的地周边和车主沿途找火车站，按顺路程度排好。</div>' : ''}
    </section>
    ${state.cfg.return?.enabled ? `<section id="sec-return"><h2>④ 返程</h2>
      <div class="row">${field('散场后几点出发', 'return.depart_time')}
        ${field('发车前多久到站（分钟）', 'return.security_min', { type: 'number' })}
        ${field(outboundOn() ? '返程日期' : '返程日期（必填）', 'return.date', { placeholder: returnDatePlaceholder() })}</div>
      <div class="row">${field('乘客最多等车主（分钟）', 'return.max_wait_min', { type: 'number' })}</div>
      <div class="muted">每个人可以在自己的卡片里填离场时间，不填就是上面的散场时间：车主几点走，车就几点走；乘客准备好后最多等这么久，车主走得比乘客早就带不了。不开车的人填返程车次；车主可以设返程是否开车送人。</div>
    </section>` : ''}
    <section id="sec-options"><h2>选项</h2>
      <div class="row">${field('默认最多绕路（分钟）', 'options.max_detour_min', { type: 'number' })}
        ${field('每车最多停几次', 'options.max_stops', { type: 'number' })}</div>
      ${outboundOn() ? `<div class="row">${field('出发日期', 'options.travel_date')}
        ${field('出发时间', 'options.travel_time')}</div>` : ''}
      <div class="row">${outboundOn() ? field('下车到上车（分钟）', 'options.exit_buffer_min', { type: 'number' }) : ''}
        ${field('去车站+候车（分钟）', 'options.station_access_min', { type: 'number' })}</div>
      <label class="f"><span>没搭上车的人怎么打车</span><select class="c-select" data-bind="options.taxi_mode" data-type="text">
        <option value="save"${state.cfg.options.taxi_mode === 'fast' ? '' : ' selected'}>尽量拼车省钱</option>
        <option value="fast"${state.cfg.options.taxi_mode === 'fast' ? ' selected' : ''}>各人走自己最快的站</option></select></label>
      <div class="row">${field('拼车最多多花（分钟）', 'options.taxi_pool_extra_min', { type: 'number' })}
        ${field('拼一辆的时间差（分钟）', 'options.taxi_wait_min', { type: 'number' })}</div>
      <div class="muted">省钱：每个人最多比自己最快的走法多花这么久，让打车费最少。时间差：到站（返程是离场）相差不超过这么久的，才拼一辆，一辆最多 4 人。</div>
    </section>`;
  markPeers();
  refreshDerived();
  schedulePreview();
  emit('rendered');
}

// 重画表单但保持正在输入的那一格的焦点和光标
export function rerenderKeepingFocus() {
  const el = document.activeElement;
  const path = el && el.closest && el.closest('#form') ? pathOf(el) : null;
  const pos = path && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;
  renderForm();
  const again = path && elementOf(path);
  if (again) {
    again.focus();
    try { if (pos) again.setSelectionRange(...pos); } catch { /* 数字框不支持选区 */ }
  }
}

// ---------- 进度 ----------
export function renderSteps() {
  const people = state.cfg.people || [], riders = people.filter((p) => p.car_seats === undefined);
  const located = (x) => Boolean(x && x.location);
  const venueOk = located(state.cfg.venue);
  const unlocated = people.filter((p) => !located(p)).length;
  const withTrains = riders.filter((p) => Object.keys(p.trains || {}).length || Object.keys(p.rail_min || {}).length).length;
  const steps = [
    ['sec-venue', '目的地', venueOk ? '已定位' : state.cfg.venue.address || state.cfg.venue.name ? '待定位' : '未填', venueOk],
    ['sec-people', '成员', people.length ? `${people.length} 人${unlocated ? `，${unlocated} 人未定位` : ''}` : '未填', people.length > 0],
    ['sec-stations', '车站', state.cfg.stations.length ? `${state.cfg.stations.length} 个` : '未选', state.cfg.stations.length > 0],
    ...(outboundOn() ? [['sec-people', '车次', riders.length ? `${withTrains}/${riders.length}` : '无需', riders.length === withTrains]] : []),
    ...(state.cfg.return?.enabled ? [['sec-return', '返程', state.cfg.return.depart_time
      ? `${riders.filter((p) => Object.keys(p.return_trains || {}).length).length}/${riders.length} 人填了车次` : '没填出发时间',
      Boolean(state.cfg.return.depart_time) && riders.every((p) => Object.keys(p.return_trains || {}).length)]] : []),
    ['plan', '方案', state.result ? (isStale() ? '需重算' : '已算好') : '未计算', Boolean(state.result) && !isStale()],
  ];
  $('#steps').innerHTML = steps.map(([target, name, text, ok]) =>
    `<button class="step ${ok ? 'done' : 'todo'}" data-goto="${target}"><b>${name}</b> ${esc(text)}</button>`).join('');
}

