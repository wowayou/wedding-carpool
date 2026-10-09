// SPDX-License-Identifier: AGPL-3.0-or-later
// 编辑页（ui.html）和管理页（web/admin.html）的静态检查：脚本能解析、没有原生对话框、自动化脚本依赖的 id 和选择器还在。
// 真正的交互在浏览器里验证（见 README 的「测试」），这里只拦住最容易回退的几件事。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ui = readFileSync('ui.html', 'utf8');
const admin = readFileSync('web/admin.html', 'utf8');
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('页面里的内嵌脚本语法正确', () => {
  for (const [name, html] of [['ui.html', ui], ['admin.html', admin]]) {
    const list = scripts(html);
    assert.ok(list.length, `${name} 没有内嵌脚本`);
    for (const code of list) assert.doesNotThrow(() => new vm.Script(code), `${name} 的脚本有语法错误`);
  }
});

test('没有原生 alert / confirm / prompt（统一用页内弹窗和轻提示）', () => {
  for (const [name, html] of [['ui.html', ui], ['admin.html', admin]]) {
    for (const code of scripts(html)) {
      const hit = /(^|[^\w.$])(?:window\.)?(alert|confirm|prompt)\s*\(/.exec(code);
      assert.equal(hit, null, `${name} 还在用原生 ${hit?.[2]}`);
    }
  }
});

test('编辑页保留验收脚本依赖的 id 和 data 属性', () => {
  const ids = ['nameInput', 'nameForm', 'importFile', 'form', 'plan', 'report', 'map', 'sharebtn', 'menuBtn', 'codeBox', 'codeInput', 'codeForm', 'codeErr',
    'denied', 'deniedText', 'expiryChip', 'stale', 'tabs', 'peers'];
  for (const id of ids) assert.match(ui, new RegExp(`id="${id}"`), `缺少 #${id}`);
  // 「更多」里动态生成的元素
  for (const id of ['shareCode', 'shareCodeBtn', 'editCode', 'editCodeBtn', 'rotateBtn', 'deleteBtn']) assert.ok(ui.includes(`id="${id}"`), `缺少 #${id}`);
  for (const attr of ['data-return-toggle', 'data-outbound-toggle', 'data-backtrain', 'data-train', 'data-station=', 'data-share="new-link"', 'data-plan=', 'data-leg=', 'data-bind=']) {
    assert.ok(ui.includes(attr), `缺少 ${attr}`);
  }
  // 弹窗的稳定选择器
  for (const sel of ['data-dialog-ok', 'data-dialog-cancel', 'data-dialog-input', 'data-dialog-error']) assert.ok(ui.includes(sel), `缺少 ${sel}`);
});

test('编辑页引入设计系统，源文件保留 CDN 地址（构建时才改写成 /vendor/）', () => {
  assert.match(ui, /href="\/design\.css"/);
  for (const cdn of ['cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js']) assert.ok(ui.includes(cdn));
  assert.match(ui, /viewport-fit=cover/);
  assert.match(ui, /safe-area-inset-bottom/);
});

// 校验和时区的纯函数：从页面脚本里取出来跑一遍，免得改坏
function load(names) {
  const code = scripts(ui).at(-1);
  const pick = names.map((n) => {
    const m = new RegExp(`(?:function ${n}\\b[\\s\\S]*?\\n\\}\\n|const ${n} = [^\\n]*\\n)`).exec(code);
    assert.ok(m, `找不到 ${n}`);
    return m[0];
  }).join('\n');
  return vm.runInNewContext(`${pick}\n({ ${names.join(', ')} })`, {});
}

test('时区：日期统一按北京时间，不依赖运行环境', () => {
  const src = scripts(ui).at(-1);
  const m = /const BJ_MS[\s\S]*?const bjMonthDayTime[^\n]*\n/.exec(src);
  assert.ok(m);
  const f = vm.runInNewContext(`${m[0]}\n({ bjDate, bjMonthDayTime })`, {});
  const t = Date.UTC(2026, 9, 7, 16, 30); // UTC 10-07 16:30 = 北京时间 10-08 00:30
  assert.equal(f.bjDate(t), '2026-10-08');
  assert.equal(f.bjMonthDayTime(t), '10-8 00:30');
});

test('输入校验：车次、日期、时间', () => {
  const f = load(['isDate', 'isClock', 'trainProblem']);
  assert.ok(f.isDate('2026-10-17'));
  assert.ok(!f.isDate('2026-02-30') && !f.isDate('2026/10/17') && !f.isDate('2026-1-7'));
  assert.ok(f.isClock('08:00') && f.isClock('8:05') && f.isClock('23:59'));
  assert.ok(!f.isClock('24:00') && !f.isClock('8:60') && !f.isClock('0800'));
  assert.equal(f.trainProblem('G7351 上海虹桥08:35→黄山北11:20', false, false), null);
  assert.match(f.trainProblem('G7351 上海虹桥', false, false).msg, /没找到时刻/);
  assert.match(f.trainProblem('G1 25:00→26:10', false, false).msg, /时刻不对/);
  assert.equal(f.trainProblem('G7352 黄山北22:40', true, true), null); // 返程只要发车时刻
  assert.equal(f.trainProblem('G7351 08:35', false, true), null); // 填了分钟数，只有一个时刻也行
  assert.equal(f.trainProblem('G7351 08:35', false, false).soft, true); // 只有一个时刻：提示但不拦
});

// 失焦（change）不能重建整张表单：重建会换掉输入框，用户正按下的那次点击落到旧元素上，点击和输入就丢了
test('表单 change 监听里不重建表单，只调用 refreshDerived', () => {
  const code = scripts(ui).at(-1);
  const m = /\$\('#form'\)\.addEventListener\('change'[\s\S]*?\n\}\);\n/.exec(code);
  assert.ok(m, '找不到表单的 change 监听');
  assert.doesNotMatch(m[0].replace(/\/\/.*$/gm, ''), /rerenderKeepingFocus\(\)/, 'change 里不能整张表单重绘');
  assert.match(m[0], /refreshDerived\(\)/);
  const r = /function renameStation[\s\S]*?\n\}\n/.exec(code); // 改车站名也是原地更新
  assert.ok(r && !/rerenderKeepingFocus|renderForm/.test(r[0]), '改车站名不能重绘表单');
  assert.match(code, /function refreshDerived\(\)/);
});

test('整页遮罩都经过 showOverlay / hideOverlay（焦点、inert、还原）', () => {
  const code = scripts(ui).at(-1);
  for (const id of ['nameBox', 'codeBox', 'denied', 'gone', 'quotaBox']) {
    assert.match(code, new RegExp(`showOverlay\\('${id}'`), `${id} 要用 showOverlay 打开`);
    assert.doesNotMatch(code, new RegExp(`\\$\\('#${id}'\\)\\.hidden = false`), `${id} 不能绕过 showOverlay`);
  }
  assert.match(code, /\.inert = on/);
  assert.match(code, /e\.key === 'Escape' && open\.id === 'quotaBox'/); // 只有额度遮罩支持 Esc
});

test('12306 链接始终渲染，由 refreshDerived 更新 href', () => {
  assert.match(ui, /data-link12306="\$\{i\}"/);
  assert.match(ui, /a\.href = href/);
});

test('地图提示框里的名字都经过转义（审计 S-13）', () => {
  const html = readFileSync(new URL('../ui.html', import.meta.url), 'utf8');
  const raw = [...html.matchAll(/bindTooltip\(`\$\{(?!esc\()[^}]*\}/g)].map((m) => m[0]);
  assert.deepEqual(raw, []);
});

test('三处地图（编辑页、方案页模板、示例页）的角标一样，带审图号', () => {
  const attr = (text) => [...text.matchAll(/attribution:\s*'([^']*)'/g)].map((m) => m[1]);
  const found = [['ui.html', ui], ['share.py', readFileSync('share.py', 'utf8')], ['web/demo.html', readFileSync('web/demo.html', 'utf8')]].map(([name, text]) => [name, attr(text)]);
  for (const [name, list] of found) assert.equal(list.length, 1, `${name} 里的 attribution 应该正好一处`);
  assert.deepEqual(new Set(found.map(([, list]) => list[0])), new Set(['© 高德地图 GS(2025)5996号']));
});

test('成员的出发地下面有提示，目的地没有', () => {
  assert.match(ui, /placeField\('出发地', base, 'from', [^\n]*'不用精确到门牌号，填小区、地标或附近路口就够了；方案页不会显示精确的出发地。'\)/);
  assert.match(ui, /placeField\('地址或店名', 'venue', 'address', '搜索后选一个，坐标最准'\)/);
});

// ---------- 试玩模式（/try）：示例行程，不保存、不联网查地点 ----------
test('试玩模式：只在在线站点的 /try 或 /try.html 启用，加载示例文件而不是行程接口', () => {
  const code = scripts(ui).at(-1);
  assert.match(code, /mode === 'online' && \/\^\\\/try\(\\\.html\)\?\$\/\.test\(location\.pathname\)\) mode = 'try'/);
  const load = /async function loadTryTrip\(\) \{[\s\S]*?\n\}\n/.exec(code);
  assert.ok(load);
  assert.match(load[0], /api\('\/try-trip\.json'\)/);
  assert.doesNotMatch(load[0], /API|\/api\/t\//);
  assert.match(code, /mode === 'try' \? await loadTryTrip\(\)/);
  // 试玩不连实时同步，也不保存
  assert.match(code, /function connectSync\(\) \{\n  if \(mode !== 'online'/);
  assert.match(code, /async function save\(quiet\) \{\n  if \(mode === 'try'\) return;/);
  assert.match(code, /args: mode === 'try' \? \{ try: true \}/);
});

test('试玩模式：隐藏发布按钮，只留「看示例方案页」', () => {
  assert.match(ui, /body\.try \.local-only, body\.try #sharebtn \{ display: none; \}/);
  assert.match(ui, /id="demoLink" href="\/demo"/);
  assert.match(ui, /\$\('#sharebtn'\)\.hidden = mode === 'try' \|\| !\(result\.plans\.length \|\| result\.back\?\.plans\.length\);/);
});

function loadWith(names, ctx) {
  const code = scripts(ui).at(-1);
  const pick = names.map((n) => {
    const m = new RegExp(`function ${n}\\b[\\s\\S]*?\\n\\}\\n`).exec(code); // 只取 function，避免和同名的局部 const 混淆
    assert.ok(m, `找不到 ${n}`);
    return m[0];
  }).join('\n');
  return vm.runInNewContext(`${fieldsPrelude()}\n${pick}\n({ ${names.join(', ')} })`, ctx);
}

test('试玩模式：地址只读、没有搜索按钮和清除坐标，车站只能删除', () => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = (mode) => ({ mode, esc, getPath: (p) => (p.endsWith('location') ? '118.0,30.0' : '<示例>') });
  const names = ['field', 'locLine', 'placeField', 'stationRow'];
  const on = loadWith(names, ctx('try'));
  const place = on.placeField('出发地', 'people.0', 'from', '', '提示');
  assert.match(place, /<input[^>]*readonly/);
  assert.doesNotMatch(place, /data-search|data-clearloc|data-cands/);
  assert.match(place, /&lt;示例&gt;/); // 文字照常转义
  const row = on.stationRow({ name: '黄山北站', city: '黄山市', location: '118.1,29.8' }, 0);
  assert.doesNotMatch(row, /data-search|data-clearloc/);
  assert.match(row, /data-del="stations\.0"/);
  assert.equal((row.match(/readonly/g) || []).length, 2);
  const off = loadWith(names, ctx('online'));
  assert.match(off.placeField('出发地', 'people.0', 'from', ''), /data-search="people\.0"/);
  assert.match(off.stationRow({ name: '黄山北站', city: '', location: '' }, 0), /data-search="stations\.0"/);
});

test('试玩模式：不能加成员和车站、不能推荐车站，横幅有恢复示例和新建行程', () => {
  const code = scripts(ui).at(-1);
  for (const guard of ['function addItem(kind) {\n  if (mode === \'try\') return;', 'async function suggestStations() {\n  if (mode === \'try\') return;', 'async function importConfig(file) {\n  if (mode === \'try\') return;']) {
    assert.ok(code.includes(guard), `缺少试玩守卫：${guard.split('\n')[0]}`);
  }
  const form = /function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(code)[0];
  assert.match(form, /\$\{isTry \? '' : ' <span class="adders">/g); // 成员和车站的“添加/推荐”按钮在试玩里不渲染
  assert.match(form, /试玩模式：虚构的行程，行车时间按直线距离估算，不保存。想规划你们自己的出行，请新建行程（需要邀请码或高德 Key）。/);
  assert.match(form, /data-try-reset>恢复示例<\/button>/);
  assert.match(form, /href="\/#create">新建行程<\/a>/);
  assert.match(code, /else if \(t\.dataset\.tryReset !== undefined\) resetTry\(\);/);
  assert.doesNotMatch(code, /onclick="/); // 没有内联事件处理器
});

test('按模式显示的类不用 display: revert（a.c-btn 会被退回成行内元素，和按钮对不齐）', () => {
  assert.doesNotMatch(ui, /-only\s*\{\s*display:\s*revert/);
  assert.match(ui, /body:not\(\.try\) \.try-only \{ display: none; \}/);
  assert.match(ui, /body:not\(\.online\) \.online-only \{ display: none; \}/);
});

// ---------- 去程、返程各有开关 ----------
// 取出页面脚本里的函数或 const 一行定义，放进沙箱里跑
function pick(names, ctx) {
  const code = scripts(ui).at(-1);
  const src = names.map((n) => {
    const m = new RegExp(`(?:function ${n}\\b[\\s\\S]*?\\n\\}\\n|const ${n} = [^\\n]*\\n)`).exec(code);
    assert.ok(m, `找不到 ${n}`);
    return m[0];
  }).join('\n');
  return vm.runInNewContext(`${fieldsPrelude()}\n${src}\n({ ${names.join(', ')} })`, ctx);
}

test('表单顶部有「规划哪几段」：去程、返程两个独立开关', () => {
  const form = /function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(scripts(ui).at(-1))[0];
  const legs = /<section id="sec-legs">[\s\S]*?<\/section>/.exec(form)[0];
  assert.match(legs, /规划哪几段/);
  assert.match(legs, /data-outbound-toggle/);
  assert.match(legs, /data-return-toggle/);
  assert.ok(form.indexOf('id="sec-legs"') < form.indexOf('id="sec-venue"'), '开关放在目的地之前');
  assert.doesNotMatch(form.slice(form.indexOf('id="sec-return"')), /data-return-toggle/, '返程一节里不再有开关');
  assert.match(ui, /去程和返程可以分别选，方案页按你选的组合生成/);
});

test('校验：去程返程至少开一个；只规划返程要有返程日期，并且不再检查去程的日期和车次', () => {
  const run = (cfg) => pick(['isDate', 'isClock', 'trainProblem', 'collectProblems'], { cfg }).collectProblems();
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
  const code = scripts(ui).at(-1);
  assert.match(/function personCard[\s\S]*?\n\}\n/.exec(code)[0], /\$\{!outOn \? '' : `<div class="rail">/);
  assert.match(/function renderForm[\s\S]*?\n\}\n/.exec(code)[0], /\$\{outboundOn\(\) \? `<div class="row">\$\{field\('出发日期'/);
  assert.match(/function renderSteps[\s\S]*?\n\}\n/.exec(code)[0], /\.\.\.\(outboundOn\(\) \? \[\['sec-people', '车次'/);
  assert.match(/function renderTabs[\s\S]*?\n\}\n/.exec(code)[0], /\(outOn \? group\('去程'/);
  assert.match(code, /backend\.share\(outOn \? active : -1, activeBack\)/);
});

test('返程：成员卡片有离场时间，返程一节有乘客最多等；离场时间要写成 时:分', () => {
  const code = scripts(ui).at(-1);
  const card = /function personCard[\s\S]*?\n\}\n/.exec(code)[0];
  assert.equal((card.match(/base \+ '\.leave_time'/g) || []).length, 2, '车主和乘客的卡片里都有离场时间');
  assert.match(card, /placeholder: leavePlaceholder\(\)/);
  assert.match(/function renderForm[\s\S]*?\n\}\n/.exec(code)[0], /'return\.max_wait_min'/);
  const run = (people, R) => pick(['isDate', 'isClock', 'trainProblem', 'collectProblems'], { cfg: { venue: { name: 'v' }, options: {}, stations: [], people, return: { enabled: true, depart_time: '20:30', ...R } } }).collectProblems();
  const bad = run([{ name: '甲', from: 'x', leave_time: '25:00' }], {});
  assert.ok(bad.some((p) => p.path === 'people.0.leave_time' && /时:分/.test(p.msg)));
  assert.equal(run([{ name: '甲', from: 'x', leave_time: '21:30' }], {}).length, 0);
  assert.ok(run([{ name: '甲', from: 'x' }], { max_wait_min: -5 }).some((p) => p.path === 'return.max_wait_min'));
  assert.ok(run([{ name: '甲', from: 'x', rail_min: { 黄山北站: -10 } }], {}).some((p) => p.path === 'people.0.rail_min.黄山北站' && /甲到黄山北站的用时不能小于 0/.test(p.msg)), '各站用时也按定义里的范围校验');
});

test('选项里有打车方式、拼车多花、时间差；方案卡片显示打车几辆', () => {
  const code = scripts(ui).at(-1);
  const form = /function renderForm\(\) \{[\s\S]*?\n\}\n/.exec(code)[0];
  assert.match(form, /<select class="c-select" data-bind="options\.taxi_mode"/);
  assert.match(form, /<option value="save"[^>]*>尽量拼车省钱<\/option>/);
  assert.match(form, /<option value="fast"[^>]*>各人走自己最快的站<\/option>/);
  assert.match(form, /'options\.taxi_pool_extra_min'/);
  assert.match(form, /'options\.taxi_wait_min'/);
  assert.match(code, /打车\$\{st\.cars \? `（\$\{st\.cars\} 辆）` : ''\}/);
  const stats = pick(['planStats'], { cfg: { people: [{ name: '甲', party: 2 }, { name: '乙' }] } }).planStats({ rides: {}, taxi: { 甲: 'st:a', 乙: 'st:a' }, detour: 0, carried: 0, taxi_cars: 1 });
  assert.equal(stats.cars, 1);
  assert.equal(stats.taxi, 3);
  const run = (O) => pick(['isDate', 'isClock', 'trainProblem', 'collectProblems'], { cfg: { venue: { name: 'v' }, options: O, stations: [], people: [{ name: '甲', from: 'x' }] } }).collectProblems();
  assert.ok(run({ taxi_mode: 'cheap' }).some((p) => p.path === 'options.taxi_mode'));
  assert.ok(run({ taxi_wait_min: -1 }).some((p) => p.path === 'options.taxi_wait_min'));
  assert.equal(run({ taxi_mode: 'fast', taxi_pool_extra_min: 20 }).length, 0);
  assert.match(code, /options\.taxi_mode' && value === 'save' \? ''/); // 默认值不写进配置
});

// ---------- 配置项只定义一处：config-fields.json ----------
const fieldsFile = JSON.parse(readFileSync('config-fields.json', 'utf8'));

// 从页面脚本里取出「读定义」的几个函数（不含 fetch 的 loadFields），用给定的定义跑
const fieldsPrelude = (fields = fieldsFile.fields) => `${fieldsCode()}
FIELDS = Object.fromEntries(${JSON.stringify(fields)}.map((f) => [f.path, f]));`;
const fieldsCode = () => {
  const m = /let FIELDS = \{\};[\s\S]*?const placeholderOf = [^\n]*\n/.exec(scripts(ui).at(-1));
  assert.ok(m, '找不到 config-fields.json 的读取代码');
  return m[0].replace(/async function loadFields[\s\S]*?\n\}\n/, '');
};
const withFields = (fields, body) => vm.runInNewContext(`${fieldsPrelude(fields)}\n${body}`, {});

test('编辑页的占位文字取自 config-fields.json，改定义就跟着变', () => {
  const h = withFields(fieldsFile.fields, '({ fieldOf, defaultOf, noteOf, placeholderOf })');
  for (const f of fieldsFile.fields.filter((x) => x.rules_table && typeof x.default === 'number')) assert.equal(h.placeholderOf(f.path), String(f.default), f.path);
  assert.equal(h.placeholderOf('people.3.party'), '1'); // 成员字段：people.N.x 对应 people[].x
  assert.equal(h.placeholderOf('return.depart_time'), '20:30'); // 没有默认值的用写明的示例
  assert.equal(h.noteOf('people.0.leave_time'), '同散场时间');
  const changed = fieldsFile.fields.map((f) => (f.path === 'options.max_stops' ? { ...f, default: 7 } : f));
  const h2 = withFields(changed, '({ defaultOf, placeholderOf })');
  assert.equal(h2.placeholderOf('options.max_stops'), '7');
  assert.equal(h2.defaultOf('options.max_stops'), 7);
});

test('编辑页不再写死默认值，用到的配置路径在 config-fields.json 里都有定义', () => {
  const code = scripts(ui).at(-1);
  assert.doesNotMatch(code, /DEFAULTS_STATION_COST/);
  assert.doesNotMatch(code, /placeholder: '\d/); // 占位里写死的 30、2、40、60、15、45……
  assert.doesNotMatch(code, /\?\? \d+\)/); // detourHint 里的 ?? 30 之类
  const defined = new Set(fieldsFile.fields.map((f) => f.path));
  const used = new Set([...ui.matchAll(/['"`]((?:options|return|venue)\.[a-z_]+(?:\.[a-z_0-9]+)?)['"`]/g)].map((m) => m[1]));
  assert.ok(used.has('options.max_detour_min') && used.has('return.security_min'));
  assert.deepEqual([...used].filter((p) => !defined.has(p)), []);
  const personKeys = [...ui.matchAll(/base \+ '\.([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(personKeys.includes('max_detour_min'));
  assert.deepEqual(personKeys.filter((k) => !defined.has(`people[].${k}`) && !defined.has(`stations[].${k}`)), []);
});

test('冲突提示里的中文名取自定义（含找站设置）', () => {
  const fn = /function labelOf\(path\) \{[\s\S]*?\n\}\n/.exec(scripts(ui).at(-1));
  assert.ok(fn);
  const run = (fields) => withFields(fields, `const cfg = { people: [{ name: '老王' }], stations: [{ name: '黄山北站' }] };\n${fn[0]}\nlabelOf`);
  const labelOf = run(fieldsFile.fields);
  assert.equal(labelOf('options.taxi_pool_extra_min'), '选项「拼车最多多花」');
  assert.equal(labelOf('return.security_min'), '返程「发车前多久到站」');
  assert.equal(labelOf('people.0.max_detour_min'), '老王的最多绕路');
  assert.equal(labelOf('options.suggest.max_searches'), '找站设置「每次最多搜索几次」');
  assert.equal(labelOf('venue.address'), '目的地地址');
  const renamed = run(fieldsFile.fields.map((f) => (f.path === 'options.max_stops' ? { ...f, label: '改名后' } : f)));
  assert.equal(renamed('options.max_stops'), '选项「改名后」');
});
