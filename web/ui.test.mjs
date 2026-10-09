// SPDX-License-Identifier: AGPL-3.0-or-later
// 编辑页（ui.html + web/editor/*.js 脚本模块）和管理页（web/admin.html）的检查：脚本能解析、没有原生对话框、自动化脚本依赖的 id 和选择器还在，
// 以及直接 import 各个模块来跑的单元测试。模块在导入时不碰页面，所以不需要浏览器；要页面的函数，测试里放一个最小的假 document。
// 真正的交互在浏览器里验证（npm run e2e），这里拦住最容易回退的几件事。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { addItem } from './editor/actions.js';
import { capsFor, createBackend, backend, initBackend } from './editor/backend.js';
import { caps, setCaps } from './editor/caps.js';
import { labelOf } from './editor/conflict.js';
import { closeDrawer } from './editor/drawer.js';
import { clearHandlers, emit } from './editor/events.js';
import { defaultOf, fieldOf, noteOf, placeholderOf, setFields } from './editor/fields.js';
import { locLine, placeField, stationRow } from './editor/form.js';
import { view } from './editor/map.js';
import { importConfig } from './editor/menu.js';
import { planStats } from './editor/results.js';
import { resetState, state, sug } from './editor/state.js';
import * as suggest from './editor/suggest.js';
import { clearSugLayer, initSugLayer, syncSugLayer } from './editor/sug-layer.js';
import { scheduleSync, syncSave } from './editor/sync.js';
import { bjDate, bjMonthDayTime } from './editor/time.js';
import { collectProblems, isClock, isDate, trainProblem } from './editor/validate.js';

const ui = readFileSync('ui.html', 'utf8');
const admin = readFileSync('web/admin.html', 'utf8');
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// 编辑页的脚本模块：按模块名取源码。原来都在 ui.html 里，现在页面（ui.html）和脚本（web/editor/*.js）分开
const EDITOR_DIR = 'web/editor';
const editorFiles = readdirSync(EDITOR_DIR).filter((f) => f.endsWith('.js')).sort();
const src = Object.fromEntries(editorFiles.map((f) => [f.replace(/\.js$/, ''), readFileSync(`${EDITOR_DIR}/${f}`, 'utf8')]));
const editorAll = Object.values(src).join('\n');
const page = `${ui}\n${editorAll}`; // 页面 + 脚本：查「页面里有没有某个东西」时两处都看

test('页面里的内嵌脚本语法正确，编辑页的脚本模块都能通过语法检查', () => {
  for (const [name, html] of [['ui.html', ui], ['admin.html', admin]]) {
    const list = scripts(html);
    assert.ok(list.length, `${name} 没有内嵌脚本`);
    for (const code of list) assert.doesNotThrow(() => new vm.Script(code), `${name} 的脚本有语法错误`);
  }
  assert.ok(editorFiles.length >= 20 && editorFiles.includes('main.js'), `只找到 ${editorFiles.length} 个模块`);
  for (const f of editorFiles) {
    const r = spawnSync(process.execPath, ['--check', `${EDITOR_DIR}/${f}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} 有语法错误：${r.stderr}`);
  }
});

test('没有原生 alert / confirm / prompt（统一用页内弹窗和轻提示）', () => {
  const codes = [...scripts(ui), ...scripts(admin), ...Object.values(src)];
  for (const code of codes) {
    const hit = /(^|[^\w.$])(?:window\.)?(alert|confirm|prompt)\s*\(/.exec(code);
    assert.equal(hit, null, `还在用原生 ${hit?.[2]}`);
  }
});

test('编辑页保留验收脚本依赖的 id 和 data 属性', () => {
  const ids = ['nameInput', 'nameForm', 'importFile', 'form', 'plan', 'report', 'map', 'sharebtn', 'menuBtn', 'codeBox', 'codeInput', 'codeForm', 'codeErr',
    'denied', 'deniedText', 'expiryChip', 'stale', 'tabs', 'peers'];
  for (const id of ids) assert.match(ui, new RegExp(`id="${id}"`), `缺少 #${id}`);
  // 「更多」里动态生成的元素
  for (const id of ['shareCode', 'shareCodeBtn', 'editCode', 'editCodeBtn', 'rotateBtn', 'deleteBtn']) assert.ok(page.includes(`id="${id}"`), `缺少 #${id}`);
  for (const attr of ['data-return-toggle', 'data-outbound-toggle', 'data-backtrain', 'data-train', 'data-station=', 'data-share="new-link"', 'data-plan=', 'data-leg=', 'data-bind=']) {
    assert.ok(page.includes(attr), `缺少 ${attr}`);
  }
  // 弹窗的稳定选择器
  for (const sel of ['data-dialog-ok', 'data-dialog-cancel', 'data-dialog-input', 'data-dialog-error']) assert.ok(page.includes(sel), `缺少 ${sel}`);
});

test('编辑页引入设计系统，源文件保留 CDN 地址（构建时才改写成 /vendor/）', () => {
  assert.match(ui, /href="\/design\.css"/);
  for (const cdn of ['cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js']) assert.ok(ui.includes(cdn));
  assert.match(ui, /viewport-fit=cover/);
  assert.match(ui, /safe-area-inset-bottom/);
});

test('时区：日期统一按北京时间，不依赖运行环境', () => {
  const t = Date.UTC(2026, 9, 7, 16, 30); // UTC 10-07 16:30 = 北京时间 10-08 00:30
  assert.equal(bjDate(t), '2026-10-08');
  assert.equal(bjMonthDayTime(t), '10-8 00:30');
});

test('输入校验：车次、日期、时间', () => {
  assert.ok(isDate('2026-10-17'));
  assert.ok(!isDate('2026-02-30') && !isDate('2026/10/17') && !isDate('2026-1-7'));
  assert.ok(isClock('08:00') && isClock('8:05') && isClock('23:59'));
  assert.ok(!isClock('24:00') && !isClock('8:60') && !isClock('0800'));
  assert.equal(trainProblem('G7351 上海虹桥08:35→黄山北11:20', false, false), null);
  assert.match(trainProblem('G7351 上海虹桥', false, false).msg, /没找到时刻/);
  assert.match(trainProblem('G1 25:00→26:10', false, false).msg, /时刻不对/);
  assert.equal(trainProblem('G7352 黄山北22:40', true, true), null); // 返程只要发车时刻
  assert.equal(trainProblem('G7351 08:35', false, true), null); // 填了分钟数，只有一个时刻也行
  assert.equal(trainProblem('G7351 08:35', false, false).soft, true); // 只有一个时刻：提示但不拦
});

// 失焦（change）不能重建整张表单：重建会换掉输入框，用户正按下的那次点击落到旧元素上，点击和输入就丢了
test('表单 change 监听里不重建表单，只调用 refreshDerived', () => {
  const m = /\$\('#form'\)\.addEventListener\('change'[\s\S]*?\n  \}\);\n/.exec(src.wire);
  assert.ok(m, '找不到表单的 change 监听');
  assert.doesNotMatch(m[0].replace(/\/\/.*$/gm, ''), /rerenderKeepingFocus\(\)/, 'change 里不能整张表单重绘');
  assert.match(m[0], /refreshDerived\(\)/);
  const r = /export function renameStation[\s\S]*?\n\}\n/.exec(src.actions); // 改车站名也是原地更新
  assert.ok(r && !/rerenderKeepingFocus|renderForm/.test(r[0]), '改车站名不能重绘表单');
  assert.match(src.form, /export function refreshDerived\(\)/);
});

test('整页遮罩都经过 showOverlay / hideOverlay（焦点、inert、还原）', () => {
  for (const id of ['nameBox', 'codeBox', 'denied', 'gone', 'quotaBox']) {
    assert.match(editorAll, new RegExp(`showOverlay\\('${id}'`), `${id} 要用 showOverlay 打开`);
    assert.doesNotMatch(editorAll, new RegExp(`\\$\\('#${id}'\\)\\.hidden = false`), `${id} 不能绕过 showOverlay`);
  }
  assert.match(src.overlay, /\.inert = on/);
  assert.match(src.overlay, /e\.key === 'Escape' && open\.id === 'quotaBox'/); // 只有额度遮罩支持 Esc
});

test('12306 链接始终渲染，由 refreshDerived 更新 href', () => {
  assert.match(src.form, /data-link12306="\$\{i\}"/);
  assert.match(src.form, /a\.href = href/);
});

test('地图提示框里的名字都经过转义（审计 S-13）', () => {
  for (const [name, text] of Object.entries(src)) {
    const raw = [...text.matchAll(/bindTooltip\(`\$\{(?!esc\()[^}]*\}/g)].map((m) => m[0]);
    assert.deepEqual(raw, [], `${name}.js 的提示框有没转义的内容`);
  }
});

test('三处地图（编辑页、方案页模板、示例页）的角标一样，带审图号', () => {
  const attr = (text) => [...text.matchAll(/attribution:\s*'([^']*)'/g)].map((m) => m[1]);
  const found = [['web/editor/map.js', src.map], ['share.py', readFileSync('share.py', 'utf8')], ['web/demo.html', readFileSync('web/demo.html', 'utf8')]].map(([name, text]) => [name, attr(text)]);
  for (const [name, list] of found) assert.equal(list.length, 1, `${name} 里的 attribution 应该正好一处`);
  assert.deepEqual(new Set(found.map(([, list]) => list[0])), new Set(['© 高德地图 GS(2025)5996号']));
});

test('成员的出发地下面有提示，目的地没有', () => {
  assert.match(src.form, /placeField\('出发地', base, 'from', [^\n]*'不用精确到门牌号，填小区、地标或附近路口就够了；方案页不会显示精确的出发地。'\)/);
  assert.match(src.form, /placeField\('地址或店名', 'venue', 'address', '搜索后选一个，坐标最准'\)/);
});

// ---------- 测试里用的小工具 ----------
const fieldsFile = JSON.parse(readFileSync('config-fields.json', 'utf8'));
const plain = (x) => JSON.parse(JSON.stringify(x)); // 换成本域的普通对象
const realFetch = globalThis.fetch;

// 最小的假 document：任何选择器都给一个能读写的元素替身，同一个选择器拿到的是同一个
function installDom() {
  const els = {};
  const el = (sel) => (els[sel] ??= { sel, dataset: {}, hidden: false, innerHTML: '', textContent: '', disabled: false, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false });
  globalThis.document = { activeElement: null, querySelector: el, querySelectorAll: () => [], getElementById: () => null };
  return els;
}
// 每个测试从干净的状态开始：状态、事件订阅、配置项定义、模式（决定能力表）
function fresh(mode = 'online', { cfg = { options: {}, venue: {}, stations: [], people: [] }, fields = fieldsFile.fields } = {}) {
  resetState();
  clearHandlers();
  setFields(fields);
  initBackend(mode);
  state.cfg = cfg;
  view.map = null;
  return installDom();
}
// 假 fetch：记下请求，返回 handler 给的数据
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push([String(url), opts]);
    const body = await handler(String(url), opts);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return calls;
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

// ---------- 试玩模式（/try）：示例行程，不保存、不联网查地点 ----------
test('试玩模式：只在在线站点的 /try 或 /try.html 启用，加载示例文件而不是行程接口', async () => {
  assert.match(src.main, /mode === 'online' && \/\^\\\/try\(\\\.html\)\?\$\/\.test\(location\.pathname\)\) mode = 'try'/);
  const tryTrip = JSON.parse(readFileSync('web/try-trip.json', 'utf8'));
  const calls = stubFetch(() => structuredClone(tryTrip));
  try {
    const loaded = await createBackend('try').loadConfig();
    assert.deepEqual(calls.map((c) => c[0]), ['/try-trip.json']); // 只取示例文件，不碰行程接口
    assert.equal(loaded.version, null);
    assert.ok(loaded.config.options.travel_date, '日期要设成下一个周末');
  } finally { restoreFetch(); }
  // 试玩不连实时同步，也不保存
  assert.equal(capsFor('try').liveSync, false);
  assert.equal(capsFor('try').canSave, false);
  assert.match(src.sync, /export function connectSync\(\) \{\n  if \(!caps\.liveSync/);
  assert.match(src.sync, /export async function save\(quiet\) \{\n  if \(!caps\.canSave\) return;/);
  assert.match(src.backend, /createPy\(\(\) => \(\{ try: true \}\)\)/); // 计算环境用不联网的 TryAmap
});

test('试玩模式：隐藏发布按钮，只留「看示例方案页」', () => {
  assert.match(ui, /body\.try \.local-only, body\.try #sharebtn \{ display: none; \}/);
  assert.match(ui, /id="demoLink" href="\/demo"/);
  assert.match(src.results, /\$\('#sharebtn'\)\.hidden = !caps\.canPublish \|\| !\(state\.result\.plans\.length \|\| state\.result\.back\?\.plans\.length\);/);
});

test('试玩模式：地址只读、没有搜索按钮和清除坐标，车站只能删除', () => {
  fresh('try', { cfg: { people: [{ from: '<示例>', location: '118.0,30.0' }] } });
  const place = placeField('出发地', 'people.0', 'from', '', '提示');
  assert.match(place, /<input[^>]*readonly/);
  assert.doesNotMatch(place, /data-search|data-clearloc|data-cands/);
  assert.match(place, /&lt;示例&gt;/); // 文字照常转义
  assert.match(locLine('people.0'), /示意坐标 118\.0,30\.0/);
  const row = stationRow({ name: '黄山北站', city: '黄山市', location: '118.1,29.8' }, 0);
  assert.doesNotMatch(row, /data-search|data-clearloc/);
  assert.match(row, /data-del="stations\.0"/);
  assert.equal((row.match(/readonly/g) || []).length, 2);
  fresh('online', { cfg: { people: [{ from: '<示例>', location: '118.0,30.0' }] } });
  assert.match(placeField('出发地', 'people.0', 'from', ''), /data-search="people\.0"/);
  assert.match(stationRow({ name: '黄山北站', city: '', location: '' }, 0), /data-search="stations\.0"/);
});

test('试玩模式：不能加成员和车站、不能实际推荐车站（但能打开看设置），横幅有恢复示例和新建行程', async () => {
  fresh('try');
  addItem('driver');
  addItem('station');
  assert.deepEqual(plain(state.cfg.people), [], '试玩不能加成员');
  assert.deepEqual(plain(state.cfg.stations), [], '试玩不能加车站');
  await importConfig({ text: async () => { throw new Error('试玩不能导入，不该去读文件'); } }); // 直接返回，不读文件
  const form = /export function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(src.form)[0];
  assert.match(form, /\$\{fixed \? '' : ' <span class="adders">/g); // 成员和车站的“添加/推荐”按钮在试玩里不渲染
  assert.match(form, /试玩模式：虚构的行程，行车时间按直线距离估算，不保存。想规划你们自己的出行，请新建行程（需要邀请码或高德 Key）。/);
  assert.match(form, /data-try-reset>恢复示例<\/button>/);
  assert.match(form, /href="\/#create">新建行程<\/a>/);
  assert.match(src.wire, /else if \(t\.dataset\.tryReset !== undefined\) resetTry\(\);/);
  assert.doesNotMatch(editorAll, /onclick="/); // 没有内联事件处理器
});

test('按模式显示的类不用 display: revert（a.c-btn 会被退回成行内元素，和按钮对不齐）', () => {
  assert.doesNotMatch(ui, /-only\s*\{\s*display:\s*revert/);
  assert.match(ui, /body:not\(\.try\) \.try-only \{ display: none; \}/);
  assert.match(ui, /body:not\(\.online\) \.online-only \{ display: none; \}/);
});

// ---------- 去程、返程各有开关 ----------
test('表单顶部有「规划哪几段」：去程、返程两个独立开关', () => {
  const form = /export function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(src.form)[0];
  const legs = /<section id="sec-legs">[\s\S]*?<\/section>/.exec(form)[0];
  assert.match(legs, /规划哪几段/);
  assert.match(legs, /data-outbound-toggle/);
  assert.match(legs, /data-return-toggle/);
  assert.ok(form.indexOf('id="sec-legs"') < form.indexOf('id="sec-venue"'), '开关放在目的地之前');
  assert.doesNotMatch(form.slice(form.indexOf('id="sec-return"')), /data-return-toggle/, '返程一节里不再有开关');
  assert.match(page, /去程和返程可以分别选，方案页按你选的组合生成/);
});

test('校验：去程返程至少开一个；只规划返程要有返程日期，并且不再检查去程的日期和车次', () => {
  fresh();
  const run = (cfg) => { state.cfg = cfg; return collectProblems(); };
  const base = { venue: { name: 'v' }, stations: [], people: [{ name: '甲', from: 'x', car_seats: 3 }] };
  const none = run({ ...base, options: { outbound: false }, return: { enabled: false } });
  assert.ok(none.some((p) => p.path === 'sec-legs' && /至少要规划一段/.test(p.msg)));
  assert.ok(!run({ ...base, options: {} }).some((p) => p.path === 'sec-legs'));
  const only = run({ ...base, options: { outbound: false, travel_date: 'bad' }, return: { enabled: true, depart_time: '20:30' } });
  assert.ok(only.some((p) => p.path === 'return.date' && p.required), '只规划返程时返程日期必填');
  assert.ok(!only.some((p) => p.path === 'options.travel_date'), '去程关了，出发日期不检查');
  const ok = run({ ...base, options: { outbound: false }, return: { enabled: true, depart_time: '20:30', date: '2026-10-18' } });
  assert.equal(ok.length, 0);
});

test('只规划返程：隐藏去程的车次、出发日期时间，步骤条不再有「车次」，方案区只有返程一组', () => {
  assert.match(/export function personCard[\s\S]*?\n\}\n/.exec(src.form)[0], /\$\{!outOn \? '' : `<div class="rail">/);
  assert.match(/export function renderForm[\s\S]*?\n\}\n/.exec(src.form)[0], /\$\{outboundOn\(\) \? `<div class="row">\$\{field\('出发日期'/);
  assert.match(/export function renderSteps[\s\S]*?\n\}\n/.exec(src.form)[0], /\.\.\.\(outboundOn\(\) \? \[\['sec-people', '车次'/);
  assert.match(/export function renderTabs[\s\S]*?\n\}\n/.exec(src.results)[0], /\(outOn \? group\('去程'/);
  assert.match(src.wire, /backend\.share\(outOn \? state\.active : -1, state\.activeBack\)/);
});

test('返程：成员卡片有离场时间，返程一节有乘客最多等；离场时间要写成 时:分', () => {
  fresh();
  const card = /export function personCard[\s\S]*?\n\}\n/.exec(src.form)[0];
  assert.equal((card.match(/base \+ '\.leave_time'/g) || []).length, 2, '车主和乘客的卡片里都有离场时间');
  assert.match(card, /placeholder: leavePlaceholder\(\)/);
  assert.match(/export function renderForm[\s\S]*?\n\}\n/.exec(src.form)[0], /'return\.max_wait_min'/);
  const run = (people, R) => { state.cfg = { venue: { name: 'v' }, options: {}, stations: [], people, return: { enabled: true, depart_time: '20:30', ...R } }; return collectProblems(); };
  const bad = run([{ name: '甲', from: 'x', leave_time: '25:00' }], {});
  assert.ok(bad.some((p) => p.path === 'people.0.leave_time' && /时:分/.test(p.msg)));
  assert.equal(run([{ name: '甲', from: 'x', leave_time: '21:30' }], {}).length, 0);
  assert.ok(run([{ name: '甲', from: 'x' }], { max_wait_min: -5 }).some((p) => p.path === 'return.max_wait_min'));
  assert.ok(run([{ name: '甲', from: 'x', rail_min: { 黄山北站: -10 } }], {}).some((p) => p.path === 'people.0.rail_min.黄山北站' && /甲到黄山北站的用时不能小于 0/.test(p.msg)), '各站用时也按定义里的范围校验');
});

test('选项里有打车方式、拼车多花、时间差；方案卡片显示打车几辆', () => {
  fresh();
  const form = /export function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(src.form)[0];
  assert.match(form, /<select class="c-select" data-bind="options\.taxi_mode"/);
  assert.match(form, /<option value="save"[^>]*>尽量拼车省钱<\/option>/);
  assert.match(form, /<option value="fast"[^>]*>各人走自己最快的站<\/option>/);
  assert.match(form, /'options\.taxi_pool_extra_min'/);
  assert.match(form, /'options\.taxi_wait_min'/);
  assert.match(src.results, /打车\$\{st\.cars \? `（\$\{st\.cars\} 辆）` : ''\}/);
  state.cfg = { people: [{ name: '甲', party: 2 }, { name: '乙' }] };
  const stats = planStats({ rides: {}, taxi: { 甲: 'st:a', 乙: 'st:a' }, detour: 0, carried: 0, taxi_cars: 1 });
  assert.equal(stats.cars, 1);
  assert.equal(stats.taxi, 3);
  const run = (O) => { state.cfg = { venue: { name: 'v' }, options: O, stations: [], people: [{ name: '甲', from: 'x' }] }; return collectProblems(); };
  assert.ok(run({ taxi_mode: 'cheap' }).some((p) => p.path === 'options.taxi_mode'));
  assert.ok(run({ taxi_wait_min: -1 }).some((p) => p.path === 'options.taxi_wait_min'));
  assert.equal(run({ taxi_mode: 'fast', taxi_pool_extra_min: 20 }).length, 0);
  assert.match(src.wire, /options\.taxi_mode' && value === 'save' \? ''/); // 默认值不写进配置
});

// ---------- 配置项只定义一处：config-fields.json ----------
test('编辑页的占位文字取自 config-fields.json，改定义就跟着变', () => {
  setFields(fieldsFile.fields);
  for (const f of fieldsFile.fields.filter((x) => x.rules_table && typeof x.default === 'number')) assert.equal(placeholderOf(f.path), String(f.default), f.path);
  assert.equal(placeholderOf('people.3.party'), '1'); // 成员字段：people.N.x 对应 people[].x
  assert.equal(placeholderOf('return.depart_time'), '20:30'); // 没有默认值的用写明的示例
  assert.equal(noteOf('people.0.leave_time'), '同散场时间');
  assert.ok(fieldOf('people.3.max_detour_min'));
  try {
    setFields(fieldsFile.fields.map((f) => (f.path === 'options.max_stops' ? { ...f, default: 7 } : f)));
    assert.equal(placeholderOf('options.max_stops'), '7');
    assert.equal(defaultOf('options.max_stops'), 7);
  } finally { setFields(fieldsFile.fields); }
});

test('编辑页不再写死默认值，用到的配置路径在 config-fields.json 里都有定义', () => {
  assert.doesNotMatch(editorAll, /DEFAULTS_STATION_COST/);
  assert.doesNotMatch(editorAll, /placeholder: '\d/); // 占位里写死的 30、2、40、60、15、45……
  assert.doesNotMatch(editorAll, /\?\? \d+\)/); // detourHint 里的 ?? 30 之类
  const defined = new Set(fieldsFile.fields.map((f) => f.path));
  const used = new Set([...page.matchAll(/['"`]((?:options|return|venue)\.[a-z_]+(?:\.[a-z_0-9]+)?)['"`]/g)].map((m) => m[1]));
  assert.ok(used.has('options.max_detour_min') && used.has('return.security_min'));
  assert.deepEqual([...used].filter((p) => !defined.has(p)), []);
  const personKeys = [...src.form.matchAll(/base \+ '\.([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(personKeys.includes('max_detour_min'));
  assert.deepEqual(personKeys.filter((k) => !defined.has(`people[].${k}`) && !defined.has(`stations[].${k}`)), []);
});

test('冲突提示里的中文名取自定义（含找站设置）', () => {
  const run = (fields) => { fresh('online', { fields, cfg: { people: [{ name: '老王' }], stations: [{ name: '黄山北站' }] } }); return labelOf; };
  const label = run(fieldsFile.fields);
  assert.equal(label('options.taxi_pool_extra_min'), '选项「拼车最多多花」');
  assert.equal(label('return.security_min'), '返程「发车前多久到站」');
  assert.equal(label('people.0.max_detour_min'), '老王的最多绕路');
  assert.equal(label('options.suggest.max_searches'), '找站设置「每次最多搜索几次」');
  assert.equal(label('venue.address'), '目的地地址');
  const renamed = run(fieldsFile.fields.map((f) => (f.path === 'options.max_stops' ? { ...f, label: '改名后' } : f)));
  assert.equal(renamed('options.max_stops'), '选项「改名后」');
});

// ---------- 推荐车站：找站设置、先估算、把过程摊开（v3.8 切片 C） ----------
// 载入「推荐车站」那个模块，页面元素用最小的替身；返回元素替身表
function sugBox({ fields = fieldsFile.fields, cfg = { options: {}, venue: {}, stations: [], people: [] }, mode = 'online' } = {}) {
  const els = fresh(mode, { fields, cfg });
  return { els };
}
const suggestFields = fieldsFile.fields.filter((f) => f.path.startsWith('options.suggest.'));

test('找站设置的中文名、默认值、可选项、说明都取自 config-fields.json，页面里没有副本，改定义界面就跟着变', () => {
  sugBox();
  assert.deepEqual(suggest.sgKeys().sort(), suggestFields.map((f) => f.path.slice('options.suggest.'.length)).sort(), '设置面板的分组要把定义里的每一项都列出来');
  // 页面源码里不能再写一份定义里的文字
  for (const f of suggestFields) {
    assert.ok(!page.includes(f.label), `页面里写死了「${f.label}」`);
    for (const c of (f.choices || []).filter((x) => x.label.length >= 8)) assert.ok(!page.includes(c.label), `页面里写死了选项「${c.label}」`);
    if (f.hint) assert.ok(!page.includes(f.hint), `页面里写死了说明「${f.hint}」`);
  }
  const radius = suggest.sgFieldHtml('dest_radius_km');
  assert.match(radius, /目的地周边多大范围/);
  assert.match(radius, /placeholder="90"/);
  assert.match(radius, /min="30" max="150"/);
  assert.match(radius, /c-unit-input__unit" aria-hidden="true">公里</);
  assert.match(suggest.sgFieldHtml('route_strategy'), /<option value="12">躲避拥堵<\/option>/);
  assert.match(suggest.sgFieldHtml('route_cover'), /绕路上限内全覆盖/);
  assert.match(suggest.sgFieldHtml('route_cover'), /全覆盖按每位车主的绕路上限圈出范围/); // 说明
  const defaults = suggest.sgSummary(suggest.sgEffective(), 2);
  assert.equal(defaults, '目的地周边 90 公里 · 车主出发地附近 30 公里 · 沿 2 位车主的路线每 30 公里搜 25 公里 · 按车主最少绕路');
  // 改定义：名字、默认值、范围、单位、选项、说明都跟着变
  const changed = fieldsFile.fields.map((f) => {
    if (f.path === 'options.suggest.dest_radius_km') return { ...f, label: '改了名的范围', default: 77, min: 11, max: 222, unit: '里' };
    if (f.path === 'options.suggest.route_strategy') return { ...f, choices: [...f.choices, { value: 99, label: '新加的走法' }] };
    if (f.path === 'options.suggest.alt_routes') return { ...f, hint: '改过的说明' };
    return f;
  });
  sugBox({ fields: changed });
  const r2 = suggest.sgFieldHtml('dest_radius_km');
  assert.match(r2, /改了名的范围/);
  assert.match(r2, /placeholder="77"/);
  assert.match(r2, /min="11" max="222"/);
  assert.match(r2, /c-unit-input__unit" aria-hidden="true">里</);
  assert.match(suggest.sgFieldHtml('route_strategy'), /<option value="99">新加的走法<\/option>/);
  assert.match(suggest.sgFieldHtml('alt_routes'), /改过的说明/);
  // 一行摘要里的名字也取自定义
  const fixed = suggest.sgSummary({ areas: ['dest', 'owner_route'], dest_radius_km: 90, route_cover: 'along', route_step_km: 30, route_radius_km: 25, sort: 'detour' }, 2);
  assert.equal(fixed, '目的地周边 90 里 · 沿 2 位车主的路线每 30 公里搜 25 公里 · 按车主最少绕路');
  setFields(fieldsFile.fields);
});

test('找站设置只存和默认值不同的项，全是默认时不留 suggest', () => {
  const cfg = { options: { max_detour_min: 30 }, venue: {}, stations: [], people: [] };
  sugBox({ cfg });
  suggest.setSuggest('dest_radius_km', 60);
  assert.deepEqual(plain(cfg.options.suggest), { dest_radius_km: 60 });
  suggest.setSuggest('dest_radius_km', 90); // 改回默认：删掉
  assert.equal(cfg.options.suggest, undefined);
  assert.equal(cfg.options.max_detour_min, 30); // 别的选项不动
  suggest.setSuggest('filter_12306', false);
  suggest.setSuggest('filter_12306', true);
  suggest.setSuggest('route_cover', 'detour');
  suggest.setSuggest('areas', ['owner_route', 'dest', 'owner_home']); // 和默认一样，只是顺序不同
  suggest.setSuggest('drivers', ['老王']);
  assert.deepEqual(plain(cfg.options.suggest), { route_cover: 'detour', drivers: ['老王'] });
  suggest.setSuggest('areas', ['rider_home', 'dest']);
  assert.deepEqual(plain(cfg.options.suggest.areas), ['dest', 'rider_home']); // 按定义里的顺序存
  suggest.setSuggest('drivers', []); // 空名单就是全部车主，是默认
  suggest.setSuggest('areas', ['dest', 'owner_home', 'owner_route']);
  suggest.setSuggest('route_cover', 'along');
  assert.equal(cfg.options.suggest, undefined);
  suggest.setSuggest('max_searches', ''); // 清空输入框：回到默认
  assert.equal(cfg.options.suggest, undefined);
  assert.match(src.suggest, /markDirty\(\);\n  sgRefresh\(\);/); // 改了设置要 markDirty，一起编辑的人才看得到
});

test('超出范围的输入就地提示，并说清楚会按什么算', () => {
  const cfg = { options: { suggest: { dest_radius_km: 500, max_searches: 3.5, show_count: 10, checked_count: 12, route_step_km: 60 } }, venue: {}, stations: [], people: [] };
  sugBox({ cfg });
  const problems = plain(suggest.sgProblems());
  assert.match(problems.dest_radius_km, /30 到 150 公里之间.*按 150 算/);
  assert.match(problems.max_searches, /要填整数/);
  assert.match(problems.checked_count, /比显示个数（10）还多，现在会按 10 算/);
  assert.match(problems.route_radius_km, /要大于 30 公里/); // 间隔 60、范围默认 25：两圈连不上
  sugBox();
  assert.deepEqual(plain(suggest.sgProblems()), {});
  assert.match(src.suggest, /class="c-field c-settings__field/); // 就地提示用 c-field 的错误样式
  assert.match(src.suggest, /class="c-field__error" id="\$\{id\}-err"/);
});

test('三种模式都把 plan_only 传给后端', async () => {
  state.tripId = 'x';
  class FakeWorker { // 在线和试玩的计算在 Worker 里：记下发给它的消息，立刻回一个空结果
    constructor() { FakeWorker.sent = []; }
    postMessage(m) { FakeWorker.sent.push(m); if (m.method !== 'init') queueMicrotask(() => this.onmessage({ data: { id: m.id, result: {} } })); }
    terminate() {}
  }
  const realWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  const run = async (mode, planOnly) => {
    const calls = stubFetch((url) => (url === '/stations12306.json' ? { stations: { 黄山北: 1 }, cities: {} } : {}));
    try {
      await createBackend(mode).suggest({ options: {} }, planOnly);
      const call = calls.find((c) => c[0] !== '/stations12306.json');
      return { call, worker: FakeWorker.sent?.find((m) => m.method === 'suggest') };
    } finally { restoreFetch(); }
  };
  try {
    for (const planOnly of [true, false]) {
      const { call } = await run('local', planOnly);
      assert.equal(call[0], '/api/suggest');
      assert.deepEqual(plain(JSON.parse(call[1].body)), { config: { options: {} }, plan_only: planOnly });
    }
    for (const mode of ['online', 'try']) {
      const { worker } = await run(mode, true);
      assert.equal(worker.args.plan_only, true);
      assert.deepEqual([...worker.args.valid_names], ['黄山北']);
      assert.equal((await run(mode, false)).worker.args.plan_only, false);
    }
  } finally { globalThis.Worker = realWorker; }
});

test('试玩模式：能估算，但「开始找」不能点，并写明原因；点了也不会调用后端搜索', async () => {
  const box = sugBox({ mode: 'try' });
  backend.suggest = async () => { throw new Error('试玩不应该搜索'); };
  sug.est = { estimate: { searches_min: 7, searches_max: 21, routes: 2, over_cap: false, may_exceed: false }, settings: { max_searches: 80 }, notes: [], trace: { circles: [] } };
  suggest.renderSugEst();
  assert.equal(box.els['#sgGo'].disabled, true);
  assert.match(box.els['#sgWhy'].textContent, /试玩不能实际搜索，新建行程后就能用/);
  assert.equal(box.els['#sgWhy'].hidden, false);
  assert.match(box.els['#sgEst'].innerHTML, /这次大约要 7–21 次地点搜索（单次上限 80），另查 2 条车主路线/);
  await suggest.runSuggest(); // 试玩直接返回，backend 里的 throw 不会触发
  assert.equal(sug.running, false);
  assert.equal(sug.error, null);
  // 在线模式同样的估算，按钮可以点
  const est = sug.est;
  const on = sugBox({ mode: 'online' });
  sug.est = est;
  suggest.renderSugEst();
  assert.equal(on.els['#sgGo'].disabled, false);
  assert.equal(on.els['#sgGo'].textContent, '开始找');
  assert.equal(on.els['#sgWhy'].hidden, true);
  // 打开推荐车站的入口在试玩里没有被挡住
  assert.doesNotMatch(/export function suggestStations\(\) \{[\s\S]*?\n\}\n/.exec(src.suggest)[0], /canSearch\) return|fixedSample\) return/);
});

test('估算超过单次上限：「开始找」不能点，用 c-alert--warn 写明原因；可能到上限只提醒', () => {
  const trace = { circles: [{ kind: 'dest' }, { kind: 'dest' }, { kind: 'detour' }] };
  const est = (over) => ({ estimate: { searches_min: 90, searches_max: 270, routes: 1, over_cap: over, may_exceed: true }, settings: { max_searches: 80 }, notes: ['这次至少要 90 次地点搜索，超过单次上限 80 次；把范围调小，或者调高上限'], trace });
  const box = sugBox();
  sug.est = est(true);
  suggest.renderSugEst();
  assert.equal(box.els['#sgGo'].disabled, true);
  assert.match(box.els['#sgEst'].innerHTML, /c-alert c-alert--warn/);
  assert.match(box.els['#sgEst'].innerHTML, /超过单次上限 80 次（目的地周边 2 个圈，绕路上限内全覆盖 1 个圈）/);
  assert.match(box.els['#sgWhy'].textContent, /超过单次上限/);
  sug.est = est(false);
  suggest.renderSugEst();
  assert.equal(box.els['#sgGo'].disabled, false);
  assert.doesNotMatch(box.els['#sgEst'].innerHTML, /c-alert--warn/);
  assert.match(box.els['#sgEst'].innerHTML, /翻页多的话，可能会到上限 80 次，到了就停/);
  // 估算失败：显示原因和重试，不卡住，仍可以点开始找
  sug.est = null;
  sug.estErr = '高德接口报错：额度用完';
  suggest.renderSugEst();
  assert.match(box.els['#sgEst'].innerHTML, /估算没成功：高德接口报错：额度用完/);
  assert.match(box.els['#sgEst'].innerHTML, /data-sg-retry-est/);
  assert.equal(box.els['#sgGo'].disabled, false);
  assert.match(src.suggest, /id="sgEst" aria-live="polite"/); // 估算放在 aria-live 区域里
});

test('抽屉里不再有和实现不符的那句话，换成如实的说明', () => {
  assert.doesNotMatch(page, /不会\$\{outboundOn\(\) \? '去接' : '去送'\}/);
  assert.doesNotMatch(page, /绕路超过各自上限的车主不会/);
  assert.match(src.suggest, /超过各自上限的标灰，默认不勾选。勾上的会加入候选站，算方案时再按各自的上限决定谁去/);
});

test('结果里每位车主各绕多少：超过上限标灰并写明，最顺路的突出，所有车主都超过的写「车主都要绕很远」', () => {
  sugBox();
  const row = { name: '泾县站', where: '老张路上', to_venue: 106, checked: true, over_all: false,
    detours: [{ driver: '老王', minutes: 12, limit: 30, over: false }, { driver: '老张', minutes: 25, limit: 20, over: true }, { driver: '小赵', minutes: 18, limit: 30, over: false }] };
  const html = suggest.sgTags(row);
  assert.match(html, /c-tag--accent c-tag--best" title="[^"]*">老王 \+12 分</); // 最顺路
  assert.match(html, /c-tag--ok" title="[^"]*">小赵 \+18 分</);
  assert.match(html, /c-tag c-tag--over" title="[^"]*">老张 \+25 分 · 超过上限</);
  assert.doesNotMatch(html, /车主都要绕很远/);
  const all = suggest.sgTags({ ...row, over_all: true, detours: [{ driver: '老张', minutes: 70, limit: 20, over: true }] });
  assert.match(all, /车主都要绕很远/);
  assert.match(all, /老张 \+[^<]*· 超过上限/);
  // 「没列出的站」折叠，按原因分组；有坐标的能加入，没有坐标的提示手动添加
  assert.match(src.suggest, /<details class="c-fold"><summary>没列出的站/);
  assert.match(src.suggest, /data-sg-more="\$\{j\}">加入<\/button>/);
  assert.match(src.suggest, /要用的话，点「\+ 手动添加」搜站名/);
});

// 找站过程图层：用假的地图和 Leaflet 图层组，数一数清了几次、拿掉几次
function layerBox({ panel = 'suggest', layerOn = true } = {}) {
  const box = sugBox();
  const log = { removed: [], cleared: 0, panes: [] };
  globalThis.L = { layerGroup: () => ({ clearLayers: () => { log.cleared += 1; } }) };
  const map = { createPane: (name) => { log.panes.push(name); return { style: {} }; }, removeLayer: (l) => log.removed.push(l), hasLayer: () => true };
  view.map = map;
  initSugLayer(); // 订阅「地图建好」和「抽屉开关」
  emit('map', map);
  box.els['#drawer'] = { dataset: { panel }, hidden: panel === '' };
  sug.layerOn = layerOn;
  return { box, log };
}

test('「找站过程」图层：重新计算方案时清掉，关抽屉时隐藏', () => {
  assert.match(/export async function runPlan\(\) \{[\s\S]*?\n\}\n/.exec(src.results)[0], /clearSugLayer\(\);/);
  try {
    const { log } = layerBox();
    assert.deepEqual(log.panes, ['sugPane']); // 建地图时一起建好图层的 pane
    sug.peek = true;
    clearSugLayer();
    assert.equal(log.cleared, 1);
    assert.equal(log.removed.length, 1);
    assert.equal(sug.peek, false);
    // 抽屉不在「推荐车站」上，或者开关关了：图层从地图上拿掉
    const hide = (panel, layerOn) => {
      const b = layerBox({ panel, layerOn });
      syncSugLayer();
      return b.log.removed.length;
    };
    assert.equal(hide('', true), 1); // 抽屉关了
    assert.equal(hide('history', true), 1); // 开着别的面板
    assert.equal(hide('suggest', false), 1); // 开关关了
    // 关抽屉（closeDrawer 发出抽屉事件）：图层隐藏；手机上点「去地图上看」（keepSug）则留着
    const closing = layerBox();
    closeDrawer();
    assert.equal(closing.log.removed.length, 1);
    assert.equal(sug.peek, false);
    const peek = layerBox();
    closeDrawer(true);
    assert.equal(peek.log.removed.length, 0);
    assert.equal(sug.peek, true);
  } finally { delete globalThis.L; view.map = null; }
  assert.match(src.suggest, /data-sg-layer\$\{sug\.layerOn \? ' checked' : ''\}/); // 开关，打开抽屉时默认开
  assert.match(page, /在地图上显示找站过程/);
});

test('推荐车站的样式：通用的在 design.css（c- 组件），页面里只剩专用的小样式；颜色只用语义变量', () => {
  const css = readFileSync('web/design.css', 'utf8');
  assert.doesNotMatch(page, /定稿后移到/, '「定稿后移到 design.css」的注释要去掉');
  const style = /<style>([\s\S]*?)<\/style>/.exec(ui)[1];
  const left = [...new Set([...style.matchAll(/\.(sg-[\w-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(left, ['sg-line', 'sg-names', 'sg-peek'], '页面里只保留推荐车站专用的 sg- 样式');
  assert.match(style, /@media \(min-width: 960px\) \{ \.sg-peek \{ display: none; \} \}/);
  // 新样式（设置面板、估算、结果列表、地图）不写死颜色
  const mine = css.slice(css.indexOf('/* ---------- 12. 设置面板'), css.indexOf('/* ---------- 14. 打印'));
  assert.ok(mine.length > 500);
  assert.doesNotMatch(mine, /#[0-9a-fA-F]{3,8}\b/, '样式里不能写死颜色');
  assert.doesNotMatch(mine, /rgba?\(|hsla?\(/);
  // 可交互元素有焦点样式
  assert.match(mine, /\.c-pick-row:has\(input:focus-visible\)/);
  assert.match(mine, /\.c-fold > summary:focus-visible/);
  // 自建 Leaflet pane 里的 svg：全局的 svg { max-width: 100% } 会把它压成 0 宽
  assert.match(css, /\nimg, svg \{ max-width: 100%; \}/);
  assert.match(css, /\.leaflet-pane svg \{ max-width: none !important; max-height: none !important; \}/);
  assert.doesNotMatch(page, /\.leaflet-sug-pane/);
});

// 页面里用到的 c- 类，design.css 里都要有定义（只看 class 属性和拼进 class 的字符串，不会把 id 里的 sec-legs 当成类）
const cssFile = readFileSync('web/design.css', 'utf8');
const definedClasses = new Set([...cssFile.matchAll(/\.(c-[a-z0-9_-]+)/g)].map((m) => m[1]));
const usedClasses = (html) => {
  const used = new Set();
  for (const m of html.matchAll(/class(?:Name)?=(?:"([^"]*)"|'([^']*)')|classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
    for (const t of (m[1] ?? m[2] ?? m[3]).matchAll(/(?<![\w-])c-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?/g)) used.add(t[0]);
  }
  // 脚本里拼出来的 class 字符串，如 'c-choices c-choices--stack'
  for (const t of html.matchAll(/'((?:c-[a-z0-9_-]+ ?)+)'/g)) for (const c of t[1].trim().split(' ')) used.add(c);
  return used;
};

test('编辑页用到的每个 c- 类，design.css 里都有定义', () => {
  const used = usedClasses(page);
  assert.ok(used.size > 40, `只找到 ${used.size} 个，提取可能坏了`);
  for (const c of ['c-settings', 'c-unit-input', 'c-choices', 'c-estimate', 'c-pick-row', 'c-tags', 'c-fold', 'c-tag--over', 'c-tag--best', 'c-why--info']) assert.ok(used.has(c), `编辑页应该用到 ${c}`);
  const missing = [...used].filter((c) => !definedClasses.has(c));
  assert.deepEqual(missing, [], `design.css 里没有定义：${missing.join('、')}`);
});

test('设置面板、估算、结果列表的组件都在 /design 样式指南里有示例，写进了设计规范的组件清单', () => {
  const guide = readFileSync('web/pages/design.html', 'utf8');
  const doc = readFileSync('docs/design-system.md', 'utf8');
  const section = cssFile.slice(cssFile.indexOf('/* ---------- 12. 设置面板'), cssFile.indexOf('/* ---------- 13. 地图'));
  const parts = [...new Set([...section.matchAll(/\.(c-[a-z0-9_-]+)/g)].map((m) => m[1]))];
  assert.ok(parts.length >= 25, `只找到 ${parts.length} 个组件类`);
  for (const c of parts) {
    assert.match(guide, new RegExp(`(?<![\\w-])${c}(?![\\w-])`), `/design 里没有 ${c} 的示例`);
    assert.ok(doc.includes(c.replace(/(__|--).*/, "")) && doc.includes(/(__|--).*/.exec(c)?.[0] ?? c), `设计规范里没提到 ${c}`);
  }
  assert.match(guide, /id="suggest-parts"/);
});

test('设计规范的「交互规范」里点名的函数、类名、属性在代码里真实存在', () => {
  const doc = readFileSync('docs/design-system.md', 'utf8');
  const start = doc.indexOf('\n## 交互规范');
  assert.ok(start > 0, '缺少「交互规范」一节');
  const spec = doc.slice(start, doc.indexOf('\n## ', start + 5));
  assert.match(doc, /定稿的界面改动，先改这份规范，再改页面/);
  // 规范点名的东西现在在 ui.html（页面）和 web/editor/*.js（脚本模块）里找
  const sources = [page, cssFile, readFileSync('web/admin.html', 'utf8'), readFileSync('web/pages/design.html', 'utf8'), readFileSync('config-fields.json', 'utf8')].join('\n');
  const named = [...new Set([...spec.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((t) => /^\.?[A-Za-z_][\w-]*(\(\))?$/.test(t)))];
  assert.ok(named.length > 60, `只找到 ${named.length} 个点名的名字，提取可能坏了`);
  const missing = named.filter((t) => !sources.includes(t.replace(/^\./, '').replace(/\(\)$/, '')));
  assert.deepEqual(missing, [], `规范里点名但代码里找不到：${missing.join('、')}`);
  // 关键的几个：规范里要写到，代码里要有定义
  for (const fn of ['openDrawer', 'closeDrawer', 'openDialog', 'confirmDialog', 'promptDialog', 'alertDialog', 'toast', 'sgFieldHtml', 'sgSummary', 'sgProblems', 'setSuggest',
    'scheduleSugEstimate', 'runSugEstimate', 'startProgress', 'updateProgress', 'stopProgress', 'syncSugLayer', 'drawSugLayer', 'clearSugLayer', 'sgTags', 'sgGroupBy',
    'isStale', 'updateStale', 'reportError', 'showQuota', 'decorateSoon', 'problemsDialog', 'jumpTo', 'setPane', 'themeVar', 'sugOpen', 'sgSyncFromCfg', 'updatePlanDot', 'renderEmptyPlan']) {
    assert.ok(spec.includes(fn), `规范里应该写到 ${fn}`);
    assert.match(editorAll, new RegExp(`(?:function ${fn}\\b|const ${fn} = )`), `代码里没有 ${fn} 的定义`);
  }
  assert.match(editorAll, /map\.createPane\('sugPane'\)\.style\.zIndex = 350/);
});

test('推荐车站设置：分组标题和第一项的名字重复时，只显示一个，名字留给读屏', () => {
  sugBox();
  const quiet = suggest.sgFieldHtml('areas', true);
  assert.match(quiet, /<span class="c-field__label c-sr-only" id="sg-areas-l">在哪些地方找<\/span>/);
  assert.match(quiet, /role="group" aria-labelledby="sg-areas-l"/); // 无障碍名称还在
  assert.doesNotMatch(suggest.sgFieldHtml('areas'), /c-sr-only/);
  const panel = suggest.SG_GROUPS.map((g) => g.keys.map((k, i) => suggest.sgFieldHtml(k, Boolean(g.quietFirst) && i === 0)).join('')).join('');
  assert.equal((panel.match(/c-sr-only/g) || []).length, 1, '只有「在哪找」的第一项把名字藏起来');
  assert.match(src.suggest, /title: '在哪找', keys: \['areas'/);
});

test('在线保存：改动已经存好时，定时器触发的保存也会把状态栏从「同步中…」改回来', async () => {
  const els = fresh('online');
  const writes = [];
  els['#status'] = { get textContent() { return ''; }, set textContent(v) { writes.push(v); } };
  state.dirty = false;
  scheduleSync(60000); // 排上定时器（状态栏变成「同步中…」）
  writes.length = 0;
  await syncSave(); // 定时器被清掉，改动已经存好：状态栏要刷新一次
  assert.equal(writes.length, 1);
});

// ---------- 模块拆分（v3.10 B）：依赖单向、模式分支集中、导入时不碰页面、三种模式同一个接口 ----------
const importsOf = (text) => [...text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)\.js'/gm)].map((m) => ({ from: m[2], names: m[1].split(',').map((x) => x.trim()).filter(Boolean) }));

test('模块之间单向依赖：没有环，导入的名字对方都导出了', () => {
  const exportsOf = (name) => new Set([...src[name].matchAll(/^export\s+(?:async function|function|const|let)\s+([\w$]+)/gm)].map((m) => m[1]));
  const deps = {};
  for (const name of Object.keys(src)) {
    deps[name] = importsOf(src[name]).map((i) => i.from);
    for (const imp of importsOf(src[name])) {
      assert.ok(src[imp.from] !== undefined, `${name}.js 导入了不存在的模块 ${imp.from}`);
      for (const n of imp.names) assert.ok(exportsOf(imp.from).has(n), `${name}.js 导入了 ${imp.from}.js 没有导出的 ${n}`);
    }
  }
  const done = new Set();
  const visit = (name, path) => {
    assert.ok(!path.includes(name), `模块成环：${[...path, name].join(' -> ')}`);
    if (done.has(name)) return;
    for (const d of deps[name]) visit(d, [...path, name]);
    done.add(name);
  };
  for (const name of Object.keys(src)) visit(name, []);
  for (const name of Object.keys(src)) if (name !== 'main') assert.ok(!deps[name].includes('main') && !deps[name].includes('wire') || name === 'main', `${name}.js 不能依赖入口`);
});

test('「现在是哪种模式」只在后端模块和启动入口里判断，其他模块问能力表', () => {
  for (const [name, text] of Object.entries(src)) {
    if (name === 'backend' || name === 'main') continue;
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /(?<![\w.])mode\s*[!=]==?/, `${name}.js 不能判断 mode（用 caps）`);
    assert.doesNotMatch(code, /\bisTry\b/, `${name}.js 不能用 isTry（用 caps.fixedSample）`);
    assert.doesNotMatch(code, /[!=]==\s*'(?:online|try|local)'/, `${name}.js 不能拿模式名比较`);
    assert.doesNotMatch(code, /(?<![\w.])mode\b/, `${name}.js 里不该再有 mode 变量`);
  }
  assert.match(src.backend, /mode === 'online'/); // 判断确实集中在这里
  assert.match(src.main, /mode === 'online'/);
});

test('模块在导入时不碰页面：没有 document、window、location 的环境里能导入全部模块（入口除外）', () => {
  const code = `import { readdirSync } from 'node:fs';
    for (const f of readdirSync('web/editor').filter((x) => x.endsWith('.js') && x !== 'main.js')) await import('./web/editor/' + f);
    for (const g of ['document', 'window', 'location', 'localStorage']) if (g in globalThis) throw new Error('测试环境里不该有 ' + g);
    console.log('ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

test('能力表：三种模式能做什么、文案怎么写', () => {
  const flags = ['canSave', 'liveSync', 'hasHistory', 'hasTrip', 'canSearch', 'canImport', 'canPublish', 'fixedSample', 'quota', 'computeInBrowser'];
  const want = {
    local: [true, false, false, false, true, true, true, false, false, false],
    online: [true, true, true, true, true, true, true, false, true, true],
    try: [false, false, false, false, false, false, false, true, false, true],
  };
  for (const [mode, values] of Object.entries(want)) {
    const c = capsFor(mode);
    assert.deepEqual(flags.map((f) => c[f]), values, mode);
    assert.deepEqual(Object.keys(c).sort(), [...flags, 'text'].sort(), `${mode} 的能力表字段要和别的模式一样`);
  }
  assert.deepEqual(Object.keys(capsFor('local').text).sort(), Object.keys(capsFor('try').text).sort());
  assert.equal(capsFor('online').text.publishLabel, '发布方案页');
  assert.equal(capsFor('local').text.publishLabel, '生成方案页');
  assert.equal(capsFor('try').text.status({}), '试玩 · 改动不保存，刷新后回到示例');
  assert.equal(capsFor('local').text.status({ file: 'trip.toml' }), '本地 · trip.toml');
  assert.equal(capsFor('local').text.status({}), '本地');
  assert.equal(capsFor('online').text.status({}), null); // 在线版的状态要看连接和同步
  assert.equal(capsFor('online').text.title({ name: '周末' }), '周末');
  assert.equal(capsFor('online').text.title({}), '未命名行程');
  assert.equal(capsFor('try').text.title({}), '试玩：拼车出行规划');
  assert.match(capsFor('try').text.noTrainHint(30), /默认的 30 分钟/);
  assert.match(capsFor('local').text.noTrainHint(30), /改用高德估算/);
  // 启动时按模式填一次，别的模块读 caps
  initBackend('try');
  assert.equal(caps.fixedSample, true);
  initBackend('online');
  assert.equal(caps.liveSync, true);
  setCaps(capsFor('local'));
  assert.equal(caps.canSave, true);
});

test('三种模式是同一个后端接口的三个实现：方法一样，没有的功能调用时报错', async () => {
  const names = (b) => Object.keys(b).sort();
  const local = createBackend('local'), online = createBackend('online'), tryB = createBackend('try');
  assert.deepEqual(names(local), names(online));
  assert.deepEqual(names(tryB), names(online));
  for (const m of ['loadConfig', 'saveConfig', 'plan', 'search', 'suggest', 'share']) for (const b of [local, online, tryB]) assert.equal(typeof b[m], 'function', m);
  for (const m of ['history', 'historyAt', 'restore', 'shareSettings', 'setEditCode', 'rotateKey', 'rename', 'deleteTrip', 'setOwnKey', 'session']) {
    await assert.rejects(local[m](), /只在在线版可用/, `local.${m}`);
    await assert.rejects(tryB[m](), /只在在线版可用/, `try.${m}`);
  }
  await assert.rejects(tryB.saveConfig({}), /试玩里没有这个功能/);
  await assert.rejects(tryB.share(0, 0), /试玩里没有这个功能/);
});

test('本地版 ui.py 用 text/javascript 提供 /editor/*.js，只开放这个目录下现有的文件，路径穿越拿不到东西', () => {
  const py = `
import json, pathlib, sys, threading, urllib.error, urllib.request
sys.path.insert(0, '.')
import ui
app = ui.App(pathlib.Path('/nonexistent/trip.toml'), None)
srv = ui.ThreadingHTTPServer(('127.0.0.1', 0), ui.make_handler(app))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_port}'
def get(path):
    try:
        r = urllib.request.urlopen(base + path)
        return [r.status, r.headers['Content-Type'], len(r.read())]
    except urllib.error.HTTPError as e:
        return [e.code, e.headers['Content-Type'], 0]
print(json.dumps({
    'keys': sorted(k for k in ui.STATIC_FILES if k.startswith('/editor/')),
    'main': get('/editor/main.js'),
    'evil': [get('/editor/../ui.py'), get('/editor/%2e%2e/ui.py'), get('/editor/..%2fui.py'), get('/editor/'), get('/editor/nope.js'), get('/editor/main.js/../../ui.py')],
}))`;
  const r = spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.keys, editorFiles.map((f) => `/editor/${f}`));
  assert.equal(out.main[0], 200);
  assert.match(out.main[1], /^text\/javascript/);
  assert.ok(out.main[2] > 100);
  for (const [status] of out.evil) assert.equal(status, 404);
});

test('模块加载失败时不白屏：页面里留一段小的兜底脚本，主模块跑起来后取消提示', () => {
  const inline = scripts(ui);
  assert.equal(inline.length, 1, '编辑页只留一段内嵌脚本（兜底）');
  const guard = inline[0];
  assert.ok(guard.length < 2000, '兜底脚本要很小');
  assert.match(guard, /页面没加载出来，可能是网络不好，刷新试试；你填的内容不会丢。/);
  assert.match(guard, /c-alert c-alert--danger/); // 用设计系统的提示条
  assert.match(guard, /window\.__editorReady = /);
  assert.match(src.main, /window\.__editorReady\?\.\(\)/); // 主模块启动后通知
  // 模块脚本在两个全局库（Leaflet、marked）之后，且是同源的 ES 模块
  const mod = ui.indexOf('<script type="module" src="/editor/main.js"></script>');
  assert.ok(mod > ui.indexOf('marked.min.js') && mod > ui.indexOf('leaflet.min.js'), '模块脚本要在 Leaflet 和 marked 之后');
  assert.equal([...ui.matchAll(/<script\b/g)].length, 4);
});

// 模拟浏览器里的兜底脚本：到点没报到就出提示，报到了就取消
test('兜底脚本：到点没报到就在表单里显示提示，主模块报到后取消', () => {
  const guard = scripts(ui)[0];
  const run = (ready) => {
    const added = [];
    const form = { prepend: (b) => added.push(b) };
    let fire = null;
    const win = {};
    const ctx = vm.createContext({
      window: win,
      document: { getElementById: (id) => (id === 'form' ? form : null), createElement: () => ({ style: {}, setAttribute() {}, remove() { added.length = 0; } }) },
      setTimeout: (fn) => { fire = fn; return 1; },
      clearTimeout: () => { fire = null; },
    });
    vm.runInContext(guard, ctx);
    if (ready) win.__editorReady();
    fire?.();
    return added.length;
  };
  assert.equal(run(false), 1);
  assert.equal(run(true), 0);
});
