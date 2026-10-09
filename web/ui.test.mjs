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

test('试玩模式：不能加成员和车站、不能实际推荐车站（但能打开看设置），横幅有恢复示例和新建行程', () => {
  const code = scripts(ui).at(-1);
  for (const guard of ['function addItem(kind) {\n  if (mode === \'try\') return;', 'async function importConfig(file) {\n  if (mode === \'try\') return;']) {
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

// ---------- 推荐车站：找站设置、先估算、把过程摊开（v3.8 切片 C） ----------
// 把「推荐车站」那一整段脚本放进沙箱，页面元素用最小的替身
function sugSandbox({ fields = fieldsFile.fields, cfg = { options: {}, venue: {}, stations: [], people: [] }, mode = 'online', backend = {} } = {}) {
  const code = scripts(ui).at(-1);
  const section = /\/\/ ---------- 推荐车站 ----------[\s\S]*?(?=\/\/ ---------- 计算方案 ----------)/.exec(code);
  assert.ok(section, '找不到推荐车站那一段脚本');
  const els = {};
  const el = (sel) => (els[sel] ??= { sel, dataset: {}, hidden: false, innerHTML: '', textContent: '', disabled: false, classList: { toggle() {}, add() {} }, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = vm.createContext({ cfg, mode, $: el, esc, same: (a, b) => JSON.stringify(a) === JSON.stringify(b), fmtMin: (m) => `${m}分钟`, outboundOn: () => true,
    parseLoc: () => null, backend, toast() {}, markDirty() {}, openDrawer() {}, startProgress() {}, stopProgress() {}, applyResolved() {}, isQuotaError: () => false,
    showQuota() {}, themeVar: () => '#000', map: null, L: undefined, document: { activeElement: null, querySelector: () => null }, setTimeout, clearTimeout });
  vm.runInContext(`${fieldsPrelude(fields)}\n${section[0]}`, ctx);
  return { ctx, els, run: (expr) => vm.runInContext(expr, ctx) };
}
const suggestFields = fieldsFile.fields.filter((f) => f.path.startsWith('options.suggest.'));
const plain = (x) => JSON.parse(JSON.stringify(x)); // 沙箱里造出来的对象换成本域的

test('找站设置的中文名、默认值、可选项、说明都取自 config-fields.json，页面里没有副本，改定义界面就跟着变', () => {
  assert.deepEqual(plain(sugSandbox().run('sgKeys()')).sort(), suggestFields.map((f) => f.path.slice('options.suggest.'.length)).sort(), '设置面板的分组要把定义里的每一项都列出来');
  // 页面源码里不能再写一份定义里的文字
  for (const f of suggestFields) {
    assert.ok(!ui.includes(f.label), `页面里写死了「${f.label}」`);
    for (const c of (f.choices || []).filter((x) => x.label.length >= 8)) assert.ok(!ui.includes(c.label), `页面里写死了选项「${c.label}」`);
    if (f.hint) assert.ok(!ui.includes(f.hint), `页面里写死了说明「${f.hint}」`);
  }
  const base = sugSandbox();
  const html = (box, key) => box.run(`sgFieldHtml('${key}')`);
  const radius = html(base, 'dest_radius_km');
  assert.match(radius, /目的地周边多大范围/);
  assert.match(radius, /placeholder="90"/);
  assert.match(radius, /min="30" max="150"/);
  assert.match(radius, /c-unit-input__unit" aria-hidden="true">公里</);
  assert.match(html(base, 'route_strategy'), /<option value="12">躲避拥堵<\/option>/);
  assert.match(html(base, 'route_cover'), /绕路上限内全覆盖/);
  assert.match(html(base, 'route_cover'), /全覆盖按每位车主的绕路上限圈出范围/); // 说明
  // 改定义：名字、默认值、范围、单位、选项、说明都跟着变
  const changed = fieldsFile.fields.map((f) => {
    if (f.path === 'options.suggest.dest_radius_km') return { ...f, label: '改了名的范围', default: 77, min: 11, max: 222, unit: '里' };
    if (f.path === 'options.suggest.route_strategy') return { ...f, choices: [...f.choices, { value: 99, label: '新加的走法' }] };
    if (f.path === 'options.suggest.alt_routes') return { ...f, hint: '改过的说明' };
    return f;
  });
  const box = sugSandbox({ fields: changed });
  const r2 = html(box, 'dest_radius_km');
  assert.match(r2, /改了名的范围/);
  assert.match(r2, /placeholder="77"/);
  assert.match(r2, /min="11" max="222"/);
  assert.match(r2, /c-unit-input__unit" aria-hidden="true">里</);
  assert.match(html(box, 'route_strategy'), /<option value="99">新加的走法<\/option>/);
  assert.match(html(box, 'alt_routes'), /改过的说明/);
  // 一行摘要里的名字也取自定义
  const fixed = box.run(`sgSummary({ areas: ['dest', 'owner_route'], dest_radius_km: 90, route_cover: 'along', route_step_km: 30, route_radius_km: 25, sort: 'detour' }, 2)`);
  assert.equal(fixed, '目的地周边 90 里 · 沿 2 位车主的路线每 30 公里搜 25 公里 · 按车主最少绕路');
  const defaults = base.run('sgSummary(sgEffective(), 2)');
  assert.equal(defaults, '目的地周边 90 公里 · 车主出发地附近 30 公里 · 沿 2 位车主的路线每 30 公里搜 25 公里 · 按车主最少绕路');
});

test('找站设置只存和默认值不同的项，全是默认时不留 suggest', () => {
  const cfg = { options: { max_detour_min: 30 }, venue: {}, stations: [], people: [] };
  const box = sugSandbox({ cfg });
  box.run(`setSuggest('dest_radius_km', 60)`);
  assert.deepEqual(plain(cfg.options.suggest), { dest_radius_km: 60 });
  box.run(`setSuggest('dest_radius_km', 90)`); // 改回默认：删掉
  assert.equal(cfg.options.suggest, undefined);
  assert.equal(cfg.options.max_detour_min, 30); // 别的选项不动
  box.run(`setSuggest('filter_12306', false)`);
  box.run(`setSuggest('filter_12306', true)`);
  box.run(`setSuggest('route_cover', 'detour')`);
  box.run(`setSuggest('areas', ['owner_route', 'dest', 'owner_home'])`); // 和默认一样，只是顺序不同
  box.run(`setSuggest('drivers', ['老王'])`);
  assert.deepEqual(plain(cfg.options.suggest), { route_cover: 'detour', drivers: ['老王'] });
  box.run(`setSuggest('areas', ['rider_home', 'dest'])`);
  assert.deepEqual(plain(cfg.options.suggest.areas), ['dest', 'rider_home']); // 按定义里的顺序存
  box.run(`setSuggest('drivers', [])`); // 空名单就是全部车主，是默认
  box.run(`setSuggest('areas', ['dest', 'owner_home', 'owner_route'])`);
  box.run(`setSuggest('route_cover', 'along')`);
  assert.equal(cfg.options.suggest, undefined);
  box.run(`setSuggest('max_searches', '')`); // 清空输入框：回到默认
  assert.equal(cfg.options.suggest, undefined);
  assert.match(scripts(ui).at(-1), /markDirty\(\);\n  sgRefresh\(\);/); // 改了设置要 markDirty，一起编辑的人才看得到
});

test('超出范围的输入就地提示，并说清楚会按什么算', () => {
  const cfg = { options: { suggest: { dest_radius_km: 500, max_searches: 3.5, show_count: 10, checked_count: 12, route_step_km: 60 } }, venue: {}, stations: [], people: [] };
  const problems = plain(sugSandbox({ cfg }).run('sgProblems()'));
  assert.match(problems.dest_radius_km, /30 到 150 公里之间.*按 150 算/);
  assert.match(problems.max_searches, /要填整数/);
  assert.match(problems.checked_count, /比显示个数（10）还多，现在会按 10 算/);
  assert.match(problems.route_radius_km, /要大于 30 公里/); // 间隔 60、范围默认 25：两圈连不上
  assert.deepEqual(plain(sugSandbox().run('sgProblems()')), {});
  assert.match(ui, /class="c-field c-settings__field/); // 就地提示用 c-field 的错误样式
  assert.match(ui, /class="c-field__error" id="\$\{id\}-err"/);
});

test('三种模式都把 plan_only 传给后端', async () => {
  const code = scripts(ui).at(-1);
  const m = /const backend = \{[\s\S]*?\n\};\n/.exec(code);
  assert.ok(m);
  const run = async (mode, planOnly) => {
    const sent = [];
    const ctx = { mode, API: '/api/t/x', api: async (path, body) => { sent.push(['api', path, body]); return {}; }, py: async (method, args) => { sent.push(['py', method, args]); return {}; },
      load12306: async () => ({ stations: { 黄山北: 1 } }), URLSearchParams };
    const b = vm.runInNewContext(`${m[0]}\nbackend`, ctx);
    await b.suggest({ options: {} }, planOnly);
    return sent[0];
  };
  assert.deepEqual(plain(await run('local', true)), ['api', '/api/suggest', { config: { options: {} }, plan_only: true }]);
  assert.deepEqual(plain(await run('local', false)), ['api', '/api/suggest', { config: { options: {} }, plan_only: false }]);
  for (const mode of ['online', 'try']) {
    const [kind, method, args] = await run(mode, true);
    assert.equal(kind + method, 'pysuggest');
    assert.equal(args.plan_only, true);
    assert.deepEqual([...args.valid_names], ['黄山北']);
    assert.equal((await run(mode, false))[2].plan_only, false);
  }
});

test('试玩模式：能估算，但「开始找」不能点，并写明原因；点了也不会调用后端搜索', async () => {
  const box = sugSandbox({ mode: 'try', backend: { suggest: async () => { throw new Error('试玩不应该搜索'); } } });
  box.run('sug').est = { estimate: { searches_min: 7, searches_max: 21, routes: 2, over_cap: false, may_exceed: false }, settings: { max_searches: 80 }, notes: [], trace: { circles: [] } };
  box.run('renderSugEst()');
  assert.equal(box.els['#sgGo'].disabled, true);
  assert.match(box.els['#sgWhy'].textContent, /试玩不能实际搜索，新建行程后就能用/);
  assert.equal(box.els['#sgWhy'].hidden, false);
  assert.match(box.els['#sgEst'].innerHTML, /这次大约要 7–21 次地点搜索（单次上限 80），另查 2 条车主路线/);
  await box.run('runSuggest()'); // 试玩直接返回，backend 里的 throw 不会触发
  assert.equal(box.run('sug').running, false);
  assert.equal(box.run('sug').error, null);
  // 在线模式同样的估算，按钮可以点
  const on = sugSandbox({ mode: 'online' });
  on.run('sug').est = box.run('sug').est;
  on.run('renderSugEst()');
  assert.equal(on.els['#sgGo'].disabled, false);
  assert.equal(on.els['#sgGo'].textContent, '开始找');
  assert.equal(on.els['#sgWhy'].hidden, true);
  // 打开推荐车站的入口在试玩里没有被挡住
  assert.doesNotMatch(/function suggestStations\(\) \{[\s\S]*?\n\}\n/.exec(scripts(ui).at(-1))[0], /mode === 'try'\) return/);
});

test('估算超过单次上限：「开始找」不能点，用 c-alert--warn 写明原因；可能到上限只提醒', () => {
  const trace = { circles: [{ kind: 'dest' }, { kind: 'dest' }, { kind: 'detour' }] };
  const est = (over) => ({ estimate: { searches_min: 90, searches_max: 270, routes: 1, over_cap: over, may_exceed: true }, settings: { max_searches: 80 }, notes: ['这次至少要 90 次地点搜索，超过单次上限 80 次；把范围调小，或者调高上限'], trace });
  const box = sugSandbox();
  box.run('sug').est = est(true);
  box.run('renderSugEst()');
  assert.equal(box.els['#sgGo'].disabled, true);
  assert.match(box.els['#sgEst'].innerHTML, /c-alert c-alert--warn/);
  assert.match(box.els['#sgEst'].innerHTML, /超过单次上限 80 次（目的地周边 2 个圈，绕路上限内全覆盖 1 个圈）/);
  assert.match(box.els['#sgWhy'].textContent, /超过单次上限/);
  box.run('sug').est = est(false);
  box.run('renderSugEst()');
  assert.equal(box.els['#sgGo'].disabled, false);
  assert.doesNotMatch(box.els['#sgEst'].innerHTML, /c-alert--warn/);
  assert.match(box.els['#sgEst'].innerHTML, /翻页多的话，可能会到上限 80 次，到了就停/);
  // 估算失败：显示原因和重试，不卡住，仍可以点开始找
  box.run('sug').est = null;
  box.run('sug').estErr = '高德接口报错：额度用完';
  box.run('renderSugEst()');
  assert.match(box.els['#sgEst'].innerHTML, /估算没成功：高德接口报错：额度用完/);
  assert.match(box.els['#sgEst'].innerHTML, /data-sg-retry-est/);
  assert.equal(box.els['#sgGo'].disabled, false);
  assert.match(ui, /id="sgEst" aria-live="polite"/); // 估算放在 aria-live 区域里
});

test('抽屉里不再有和实现不符的那句话，换成如实的说明', () => {
  assert.doesNotMatch(ui, /不会\$\{outboundOn\(\) \? '去接' : '去送'\}/);
  assert.doesNotMatch(ui, /绕路超过各自上限的车主不会/);
  assert.match(ui, /超过各自上限的标灰，默认不勾选。勾上的会加入候选站，算方案时再按各自的上限决定谁去/);
});

test('结果里每位车主各绕多少：超过上限标灰并写明，最顺路的突出，所有车主都超过的写「车主都要绕很远」', () => {
  const box = sugSandbox();
  const row = { name: '泾县站', where: '老张路上', to_venue: 106, checked: true, over_all: false,
    detours: [{ driver: '老王', minutes: 12, limit: 30, over: false }, { driver: '老张', minutes: 25, limit: 20, over: true }, { driver: '小赵', minutes: 18, limit: 30, over: false }] };
  const html = box.run(`sgTags(${JSON.stringify(row)})`);
  assert.match(html, /c-tag--accent c-tag--best" title="[^"]*">老王 \+12 分</); // 最顺路
  assert.match(html, /c-tag--ok" title="[^"]*">小赵 \+18 分</);
  assert.match(html, /c-tag c-tag--over" title="[^"]*">老张 \+25 分 · 超过上限</);
  assert.doesNotMatch(html, /车主都要绕很远/);
  const all = box.run(`sgTags(${JSON.stringify({ ...row, over_all: true, detours: [{ driver: '老张', minutes: 70, limit: 20, over: true }] })})`);
  assert.match(all, /车主都要绕很远/);
  assert.match(all, /老张 \+[^<]*· 超过上限/);
  // 「没列出的站」折叠，按原因分组；有坐标的能加入，没有坐标的提示手动添加
  const code = scripts(ui).at(-1);
  assert.match(code, /<details class="c-fold"><summary>没列出的站/);
  assert.match(code, /data-sg-more="\$\{j\}">加入<\/button>/);
  assert.match(code, /要用的话，点「\+ 手动添加」搜站名/);
});

test('「找站过程」图层：重新计算方案时清掉，关抽屉时隐藏', () => {
  const code = scripts(ui).at(-1);
  assert.match(/async function runPlan\(\) \{[\s\S]*?\n\}\n/.exec(code)[0], /clearSugLayer\(\);/);
  const removed = [];
  const cleared = [];
  const box = sugSandbox();
  box.ctx.map = { removeLayer: (l) => removed.push(l), hasLayer: () => true };
  box.run('sugLayer = { clearLayers: () => cleared.push(1) }'.replace('cleared.push(1)', 'globalThis.__cleared = (globalThis.__cleared || 0) + 1'));
  box.run('sug').peek = true;
  box.run('clearSugLayer()');
  assert.equal(box.ctx.__cleared, 1);
  assert.equal(removed.length, 1);
  assert.equal(box.run('sug').peek, false);
  // 抽屉不在「推荐车站」上，或者开关关了：图层从地图上拿掉
  const hide = (panel, layerOn) => {
    const b = sugSandbox();
    const gone = [];
    b.ctx.map = { removeLayer: (l) => gone.push(l), hasLayer: () => true };
    b.run('sugLayer = {}');
    b.els['#drawer'] = { dataset: { panel }, hidden: panel === '' };
    b.run('sug').layerOn = layerOn;
    b.run('syncSugLayer()');
    return gone.length;
  };
  assert.equal(hide('', true), 1); // 抽屉关了
  assert.equal(hide('history', true), 1); // 开着别的面板
  assert.equal(hide('suggest', false), 1); // 开关关了
  assert.match(code, /function closeDrawer\(keepSug = false\) \{[\s\S]*?syncSugLayer\(\);/);
  assert.match(code, /data-sg-layer\$\{sug\.layerOn \? ' checked' : ''\}/); // 开关，打开抽屉时默认开
  assert.match(ui, /在地图上显示找站过程/);
});

test('推荐车站的样式：通用的在 design.css（c- 组件），页面里只剩专用的小样式；颜色只用语义变量', () => {
  const css = readFileSync('web/design.css', 'utf8');
  assert.doesNotMatch(ui, /定稿后移到/, '「定稿后移到 design.css」的注释要去掉');
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
  assert.doesNotMatch(ui, /\.leaflet-sug-pane/);
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
  const used = usedClasses(ui);
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
  const sources = [ui, cssFile, readFileSync('web/admin.html', 'utf8'), readFileSync('web/pages/design.html', 'utf8'), readFileSync('config-fields.json', 'utf8')].join('\n');
  const named = [...new Set([...spec.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((t) => /^\.?[A-Za-z_][\w-]*(\(\))?$/.test(t)))];
  assert.ok(named.length > 60, `只找到 ${named.length} 个点名的名字，提取可能坏了`);
  const missing = named.filter((t) => !sources.includes(t.replace(/^\./, '').replace(/\(\)$/, '')));
  assert.deepEqual(missing, [], `规范里点名但代码里找不到：${missing.join('、')}`);
  // 关键的几个：规范里要写到，代码里要有定义
  for (const fn of ['openDrawer', 'closeDrawer', 'openDialog', 'confirmDialog', 'promptDialog', 'alertDialog', 'toast', 'sgFieldHtml', 'sgSummary', 'sgProblems', 'setSuggest',
    'scheduleSugEstimate', 'runSugEstimate', 'startProgress', 'updateProgress', 'stopProgress', 'syncSugLayer', 'drawSugLayer', 'clearSugLayer', 'sgTags', 'sgGroupBy',
    'isStale', 'updateStale', 'reportError', 'showQuota', 'decorateSoon', 'problemsDialog', 'jumpTo', 'setPane', 'themeVar', 'sugOpen', 'sgSyncFromCfg', 'updatePlanDot', 'renderEmptyPlan']) {
    assert.ok(spec.includes(fn), `规范里应该写到 ${fn}`);
    assert.match(ui, new RegExp(`(?:function ${fn}\\b|const ${fn} = )`), `代码里没有 ${fn} 的定义`);
  }
  assert.match(ui, /map\.createPane\('sugPane'\)\.style\.zIndex = 350/);
});

test('推荐车站设置：分组标题和第一项的名字重复时，只显示一个，名字留给读屏', () => {
  const box = sugSandbox();
  const quiet = box.run(`sgFieldHtml('areas', true)`);
  assert.match(quiet, /<span class="c-field__label c-sr-only" id="sg-areas-l">在哪些地方找<\/span>/);
  assert.match(quiet, /role="group" aria-labelledby="sg-areas-l"/); // 无障碍名称还在
  assert.doesNotMatch(box.run(`sgFieldHtml('areas')`), /c-sr-only/);
  const panel = box.run(`SG_GROUPS.map((g) => g.keys.map((k, i) => sgFieldHtml(k, Boolean(g.quietFirst) && i === 0)).join('')).join('')`);
  assert.equal((panel.match(/c-sr-only/g) || []).length, 1, '只有「在哪找」的第一项把名字藏起来');
  assert.match(ui, /title: '在哪找', keys: \['areas'/);
});
