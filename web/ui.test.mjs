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
