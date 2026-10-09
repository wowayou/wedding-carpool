// ---------- 校验 ----------
// 格式问题（车次、时间、日期、数字范围、重名）随时在输入框旁提示；缺少的内容（没填名字、出发地等）在点「计算方案」失败后再标出来

import { openDialog } from './dialogs.js';
import { fieldOf } from './fields.js';
import { setPane } from './layout.js';
import { elementOf } from './paths.js';
import { state } from './state.js';
import { $, esc } from './util.js';

export function isDate(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(`${t}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}
export const isClock = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
// 车次：计算内核（carpool.train_times）认的是文字里的 H:MM 时刻；返程只需要发车时刻，去程最好有发车和到站两个
export function trainProblem(text, back, hasMinutes) {
  const times = [...String(text).matchAll(/(\d{1,2}):(\d{2})/g)];
  if (!times.length) return { msg: '没找到时刻。写成「G1234 08:00→11:30」（车次 发车时刻→到站时刻）' };
  if (times.some((m) => Number(m[1]) > 23 || Number(m[2]) > 59)) return { msg: '时刻不对：小时要在 0 到 23，分钟要在 0 到 59' };
  if (!back && times.length < 2 && !hasMinutes) return { msg: '只有一个时刻，算不出用时：补上到站时刻，或在旁边填分钟数', soft: true };
  return null;
}

// 返回问题列表：{ path 对应输入框的配置路径（或区块 id）, msg, required?, soft?, blocksSave?, also? }。soft 只提示，不拦计算
export function collectProblems() {
  const out = [];
  const add = (path, msg, o = {}) => out.push({ path, msg, ...o });
  const O = state.cfg.options || {}, V = state.cfg.venue || {}, R = state.cfg.return || {};
  // 数值范围取自 config-fields.json 的 min / max；label 默认是定义里的中文名，成员的字段前面加人名
  const ranged = (path, v, label = fieldOf(path)?.label) => {
    const f = fieldOf(path);
    if (v === undefined || v === '' || !f) return;
    if (f.min !== undefined && !(Number(v) >= f.min)) add(path, `${label}不能小于 ${f.min}`);
    else if (f.max !== undefined && !(Number(v) <= f.max)) add(path, `${label}不能大于 ${f.max}`);
  };
  if (!V.location && !V.address && !V.name) add('venue.address', '还没填目的地', { required: true });
  if (!state.cfg.people.length) add('sec-people', '至少要有一位成员', { required: true });
  const outOn = O.outbound !== false;
  if (!outOn && !R.enabled) add('sec-legs', '去程和返程至少要规划一段：勾上返程，或把去程勾回来');
  const firstSeen = new Map();
  state.cfg.people.forEach((p, i) => {
    const n = (p.name || '').trim(), base = `people.${i}`, who = n || `第 ${i + 1} 位成员`;
    if (!n) add(`${base}.name`, `第 ${i + 1} 位成员没填名字`, { required: true });
    else if (firstSeen.has(n)) {
      const j = firstSeen.get(n);
      add(`${base}.name`, `「${n}」重名了：第 ${j + 1} 位和第 ${i + 1} 位成员都叫这个名字，计算时按名字区分人，请改成不同的名字`, { blocksSave: true, also: [`people.${j}.name`] });
    } else firstSeen.set(n, i);
    if (!p.from && !p.location) add(`${base}.from`, `${who}没填出发地`, { required: true });
    if (p.car_seats !== undefined && !(Number.isInteger(Number(p.car_seats)) && Number(p.car_seats) >= 1)) add(`${base}.car_seats`, `${who}的空座要是不小于 1 的整数`);
    if (p.party !== undefined && !(Number.isInteger(Number(p.party)) && Number(p.party) >= 1)) add(`${base}.party`, `${who}的同行人数要是不小于 1 的整数`);
    ranged(`${base}.max_detour_min`, p.max_detour_min, `${who}的${fieldOf(base + '.max_detour_min').label}`);
    ranged(`${base}.return_max_detour_min`, p.return_max_detour_min, `${who}的${fieldOf(base + '.return_max_detour_min').label}`);
    for (const [st, mins] of Object.entries(p.rail_min || {})) ranged(`${base}.rail_min.${st}`, mins, `${who}到${st}的用时`);
    for (const [st, text] of outOn ? Object.entries(p.trains || {}) : []) {
      const bad = trainProblem(text, false, (p.rail_min || {})[st] !== undefined);
      if (bad) add(`${base}.trains.${st}`, `${who}到${st}的车次：${bad.msg}`, { soft: bad.soft });
    }
    if (R.enabled) {
      if (p.leave_time !== undefined && !isClock(String(p.leave_time))) add(`${base}.leave_time`, `${who}的离场时间要写成 时:分（24 小时制），如 21:30`);
      for (const [st, text] of Object.entries(p.return_trains || {})) {
        const bad = trainProblem(text, true, true);
        if (bad) add(`${base}.return_trains.${st}`, `${who}从${st}返程的车次：${bad.msg}`);
      }
    }
  });
  state.cfg.stations.forEach((s, i) => { if (!(s.name || '').trim()) add(`stations.${i}.name`, `第 ${i + 1} 个候选站没填站名`, { required: true }); });
  if (outOn && O.travel_date !== undefined && !isDate(String(O.travel_date))) add('options.travel_date', '出发日期要写成 年-月-日，如 2026-10-17');
  if (outOn && O.travel_time !== undefined && !isClock(String(O.travel_time))) add('options.travel_time', '出发时间要写成 时:分（24 小时制），如 08:00');
  for (const key of ['max_detour_min', 'max_stops', 'station_access_min', 'taxi_pool_extra_min', 'taxi_wait_min']) ranged(`options.${key}`, O[key]);
  if (outOn) ranged('options.exit_buffer_min', O.exit_buffer_min);
  if (O.taxi_mode !== undefined && !['save', 'fast'].includes(O.taxi_mode)) add('options.taxi_mode', '打车方式只能选「尽量拼车省钱」或「各人走自己最快的站」');
  if (R.enabled) {
    if (!R.depart_time) add('return.depart_time', '开了返程，还没填散场后几点出发（如 20:30）', { required: true });
    else if (!isClock(String(R.depart_time))) add('return.depart_time', '散场后出发的时间要写成 时:分（24 小时制），如 20:30');
    ranged('return.security_min', R.security_min);
    ranged('return.max_wait_min', R.max_wait_min);
    if (R.date !== undefined && !isDate(String(R.date))) add('return.date', '返程日期要写成 年-月-日，如 2026-10-18');
    else if (!outOn && R.date === undefined) add('return.date', '只规划返程时要填返程日期（如 2026-10-18）', { required: true });
  }
  return out;
}
export const validate = () => collectProblems().filter((p) => !p.soft);

// 在输入框旁标出问题（红框加一行说明）。重画表单后、改动后（稍等片刻免得边打字边报错）都会调用
export function decorateProblems() {
  document.querySelectorAll('#form .ed-err').forEach((e) => e.remove());
  document.querySelectorAll('#form .has-error').forEach((e) => e.classList.remove('has-error'));
  for (const p of collectProblems()) {
    if (p.required && !state.showRequired) continue;
    for (const path of [p.path, ...(p.also || [])]) {
      const el = elementOf(path);
      const box = el && (el.closest('.rail-row, .f, .station') || el.parentElement);
      if (!box || box.querySelector(':scope > .ed-err')) continue;
      box.classList.add('has-error');
      const note = document.createElement('span');
      note.className = 'c-field__error ed-err';
      note.textContent = p.msg;
      box.append(note);
    }
  }
}
let decorateTimer = null;
export const decorateSoon = () => { clearTimeout(decorateTimer); decorateTimer = setTimeout(decorateProblems, 450); };

// 跳到某个字段：手机上先切到「填写」，滚到中间、聚焦并闪一下
export function jumpTo(path) {
  setPane('fill');
  const el = elementOf(path) || document.getElementById(path);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => el.focus?.({ preventScroll: true }), 300);
  const box = el.closest('.f, .rail-row, .station, section') || el;
  box.classList.add('ed-flash');
  setTimeout(() => box.classList.remove('ed-flash'), 1600);
}

// 计算（或保存）前有问题：弹出可点击的清单，点一条跳到对应的输入框
export async function problemsDialog(list) {
  const html = `<ul class="dlg-list">${list.map((p) => `<li><button type="button" data-dialog-pick="${esc(p.path)}"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><span>${esc(p.msg)}</span></button></li>`).join('')}</ul>`;
  const r = await openDialog({ title: `还有 ${list.length} 处要先改一下`, message: '点一条，跳到对应的输入框。', html, cancelText: null, okText: '知道了' });
  if (r.pick) jumpTo(r.pick);
}

