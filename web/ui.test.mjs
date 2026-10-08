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
  for (const attr of ['data-return-toggle', 'data-backtrain', 'data-train', 'data-station=', 'data-share="new-link"', 'data-plan=', 'data-leg=', 'data-bind=']) {
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
  assert.match(ui, /\$\('#sharebtn'\)\.hidden = mode === 'try' \|\| !result\.plans\.length;/);
});

function loadWith(names, ctx) {
  const code = scripts(ui).at(-1);
  const pick = names.map((n) => {
    const m = new RegExp(`function ${n}\\b[\\s\\S]*?\\n\\}\\n`).exec(code); // 只取 function，避免和同名的局部 const 混淆
    assert.ok(m, `找不到 ${n}`);
    return m[0];
  }).join('\n');
  return vm.runInNewContext(`${pick}\n({ ${names.join(', ')} })`, ctx);
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
