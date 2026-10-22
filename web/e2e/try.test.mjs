// SPDX-License-Identifier: AGPL-3.0-or-later
// 试玩模式（/try）的端到端检查：不保存、不调用高德，计算在浏览器里的 Pyodide 中完成。
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bind, cleanup, closeBrowser, FAKE_JS_KEY, mapFrame, mapLayers, mapView, newGuardedPage, openSuggest, SLOW, startWrangler, waitFormReady, waitMapLayers, waitMapReady } from './lib.mjs';

let base, page, context, guard;
const cfg = JSON.parse(readFileSync('web/try-trip.json', 'utf8')).config;
const located = [cfg.venue, ...cfg.stations, ...cfg.people].filter((x) => x.location).length; // 试玩示例里已定位的点

before(async () => {
  ({ base } = await startWrangler({ jsKey: FAKE_JS_KEY })); // 设了假的 JS Key：地图页面走（假的）高德 JS API
}, { timeout: 120_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => guard?.assertClean());

// 桌面页面：整个文件里共用一个，Pyodide 只加载一次
test('试玩：加载', { timeout: SLOW }, async () => {
  ({ page, context, guard } = await newGuardedPage(`${base}`, { fakeJsApi: true }));
  await page.goto(`${base}/try`);
  await waitFormReady(page);
  await waitMapReady(page);
  assert.equal(await page.evaluate(() => document.body.classList.contains('try')), true);
  assert.match(await page.locator('#status').innerText(), /试玩/);
  assert.equal(await bind(page, 'venue.name').inputValue(), '宏村示例酒店');
  await page.locator('#tryBanner').waitFor();
  assert.equal(await page.locator('#save').isVisible(), false, '试玩没有保存键');
  // 候选站和成员都画出来了
  assert.ok(await page.locator('#form [data-station-name]').count() >= 4);
  assert.equal(await page.locator('#tabs .tab').count(), 0, '还没算，没有方案卡片');
  // 地图（iframe 里的 /map，假 JS API）：试玩示例里已定位的目的地、车站、成员都画成点，没有线和圈；图例在地图页面里
  const L0 = await waitMapLayers(page, (l) => l.points === located, `预览的 ${located} 个点`);
  assert.deepEqual({ lines: L0.lines, circles: L0.circles, renderer: L0.renderer }, { lines: 0, circles: 0, renderer: 'amap' });
  assert.deepEqual(L0.legend, ['目的地', '开车的成员', '不开车的成员', '车站', '彩色线 = 接人后的实际路线', '灰色虚线 = 不接人时的直达路线']);
  // 标签取舍：目的地的标签一定显示；不高亮的候选站只在悬停时显示
  const texts = await mapFrame(page).locator('[data-fake=text]').evaluateAll((els) => els.map((e) => ({ text: e.textContent, hidden: e.dataset.hidden === 'true' })));
  assert.equal(texts.length, located);
  assert.equal(texts.find((t) => t.text === cfg.venue.name).hidden, false);
  assert.ok(texts.some((t) => t.hidden), '候选站的标签没有悬停，不显示');
  const v = await mapView(page);
  assert.ok(v.inside, `预览的点都在地图容器里：${JSON.stringify(v)}`);
});

test('试玩：计算方案，方案卡片和地图图层都出来', { timeout: SLOW }, async () => {
  await page.locator('#plan').click();
  await page.locator('#tabs .tab').first().waitFor({ timeout: SLOW });
  assert.ok(await page.locator('#tabs .tab').count() >= 1);
  assert.match(await page.locator('#tabs .tab').first().innerText(), /方案 1/);
  assert.ok((await page.locator('#report').innerText()).length > 50, '报告有内容');
  assert.equal(await page.locator('#stale').isHidden(), true, '刚算完不过期');
  assert.equal(await page.locator('#plan').innerText(), '计算方案', '按钮恢复');
  // 地图：方案路线画在地图页面（iframe）里，视野在容器内
  const plan = await waitMapLayers(page, (l) => l.lines > 0, '方案的路线');
  assert.ok(plan.lines > 0 && plan.points > 0);
  assert.ok(plan.legend.length === 6, '图例没有找站的行');
  const view = await mapView(page, { onlyUsed: true });
  assert.ok(view.inside, `方案的点和线都在地图容器里：${JSON.stringify(view)}`);
  assert.match(await page.locator('#planDot').textContent(), /^\d+$/, '「方案」页签上有方案数');
});

test('试玩：改一个字段后方案显示「已过期」', async () => {
  await bind(page, 'options.max_detour_min').fill('31');
  await page.locator('#stale').waitFor({ state: 'visible' });
  assert.match(await page.locator('#stale').innerText(), /方案已过期/);
  assert.equal(await page.locator('#planDot').textContent(), '!');
  // 改回去就不过期了
  await bind(page, 'options.max_detour_min').fill('30');
  await page.locator('#stale').waitFor({ state: 'hidden' });
});

test('试玩：填一个很早的「最晚几点到」，报告里说明谁赶不上', { timeout: SLOW }, async () => {
  const field = bind(page, 'options.arrive_by');
  assert.equal(await page.locator('#form label.f', { hasText: '最晚几点到' }).count(), 1);
  await field.fill('06:00');
  await page.locator('#plan').click();
  await page.waitForFunction(() => /晚于 06:00/.test(document.querySelector('#report')?.innerText || ''), null, { timeout: SLOW });
  const report = await page.locator('#report').innerText();
  assert.match(report, /最晚到达时间 06:00/);
  assert.match(report, /小李[^\n]*按填的车次，最早 \d\d:\d\d 到，晚于 06:00，需要单独安排/);
  assert.match(report, /小陈[^\n]*按填的车次，最早 \d\d:\d\d 到，晚于 06:00，需要单独安排/);
  // 填错格式有红框，清空就回到不检查
  await field.fill('25:00');
  await page.locator('#plan').click();
  await page.locator('dialog.c-modal[open]').waitFor();
  await page.keyboard.press('Escape');
  await field.fill('');
  await page.locator('#plan').click();
  await page.waitForFunction(() => !/晚于 06:00/.test(document.querySelector('#report')?.innerText || ''), null, { timeout: SLOW });
});

test('试玩：车主卡片的勾选框叫「返程顺路送人」，去掉勾时说明车主照样开车回家', async () => {
  const box = page.locator('#form [data-backdrive="0"]');
  assert.match(await page.locator('#form label.toggle:has([data-backdrive="0"])').innerText(), /返程顺路送人/);
  assert.equal(await page.locator('#form').getByText('返程也开车').count(), 0);
  await box.uncheck();
  await page.getByText('车主照样开车回家，只是不送人').waitFor();
  await page.locator('#form [data-backdrive="0"]').check();
  assert.equal(await page.getByText('车主照样开车回家，只是不送人').count(), 0);
});

test('试玩：清空必填项，计算方案弹出校验清单，点一条跳到输入框', async () => {
  const depart = bind(page, 'return.depart_time');
  await depart.fill('');
  await page.locator('#plan').click();
  const dlg = page.locator('dialog.c-modal[open]');
  await dlg.waitFor();
  assert.match(await dlg.locator('.c-modal__title').innerText(), /还有 \d+ 处要先改一下/);
  const item = dlg.locator('[data-dialog-pick="return.depart_time"]');
  assert.match(await item.innerText(), /散场后/);
  await item.click();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.dataset?.bind === 'return.depart_time');
  assert.equal(await page.locator('#tabs .tab').count() >= 1, true, '校验没通过时不动已有方案');
  // 输入框旁有红框说明
  assert.ok(await page.locator('#form .ed-err').count() >= 1);
  await depart.fill('20:30');
  await page.locator('#form .ed-err').first().waitFor({ state: 'detached' });
});

test('试玩：推荐车站的设置、估算、「开始找」不能点、地图上的找站过程', { timeout: SLOW }, async () => {
  await openSuggest(page);
  assert.equal(await page.locator('#drawerTitle').innerText(), '推荐车站');
  // 设置折叠成一行摘要
  assert.match(await page.locator('#sgSummary').innerText(), /目的地周边/);
  const toggle = page.locator('#sgToggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#sgPanel').isHidden(), true);
  // 估算（试玩也能算，不花搜索次数）
  await page.locator('#sgEst .c-estimate b').waitFor({ timeout: SLOW });
  assert.match(await page.locator('#sgEst').innerText(), /这次大约要 .+ 次地点搜索（单次上限 \d+）/);
  // 「开始找」不能点，并写明原因
  assert.equal(await page.locator('#sgGo').isDisabled(), true);
  assert.match(await page.locator('#sgWhy').innerText(), /试玩不能实际搜索/);
  // 地图上有找站过程图层（圈和路线）：方案和预览里没有圈，圈出现了就是找站图层；图例多出找站过程的两行
  const sugOn = await waitMapLayers(page, (l) => l.circles > 0, '找站过程的圈');
  assert.ok(sugOn.legend.includes('点线 = 车主路线（找站用）') && sugOn.legend.includes('浅色圈 = 搜过的范围'), '图例多出找站过程的几行');
  assert.ok(await mapFrame(page).locator('[data-fake=polyline][data-dash="2 7"]').count() > 0, '车主路线是点线');
  // 展开设置：焦点到第一个输入框，改一项后摘要出现「改了 1 项」，估算重新算
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#sgPanel').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#sgPanel').contains(document.activeElement));
  const reset = page.locator('#sgPanel [data-sg-reset]');
  assert.equal(await reset.isDisabled(), true, '没改过时「恢复默认」不能点');
  await page.locator('#sgPanel [data-sg="dest_radius_km"]').fill('60');
  await page.locator('#sgSummary .c-tag--accent', { hasText: '改了 1 项' }).waitFor();
  await page.locator('#sgEst .c-estimate b').waitFor({ timeout: SLOW });
  assert.equal(await page.locator('#sgGo').isDisabled(), true);
  // 恢复默认
  await reset.click();
  await page.locator('#sgSummary .c-tag--accent').waitFor({ state: 'detached' });
  const radius = page.locator('#sgPanel [data-sg="dest_radius_km"]');
  assert.equal(await radius.inputValue(), '', '回到默认：框里留空');
  assert.equal(await radius.getAttribute('placeholder'), '90', '占位文字写默认值');
  // 关抽屉：找站过程从地图上拿掉，Esc 也能关
  await page.keyboard.press('Escape');
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  const sugOff = await waitMapLayers(page, (l) => l.circles === 0, '找站过程的圈拿掉');
  assert.deepEqual(sugOff.legend.filter((t) => /找站用|搜过的范围/.test(t)), [], '图例里找站过程的行拿掉');
  assert.equal(await mapFrame(page).locator('[data-fake=polyline][data-dash="2 7"]').count(), 0);
});

test('试玩：勾选几个候选站一起删除，车次跟着清掉；出发日期下面写火车票哪天开售', async () => {
  const stations = page.locator('#form [data-station-name]');
  const before = await stations.count();
  const names = await stations.evaluateAll((els) => els.map((e) => e.value));
  const del = page.locator('#form [data-st-del]');
  assert.equal(await del.isDisabled(), true, '没勾的时候不能点');
  await page.locator('#form [data-st-pick="0"]').check();
  await page.locator('#form [data-st-pick="1"]').check();
  assert.equal(await del.innerText(), '删除选中（2）');
  assert.equal(await page.locator('#form [data-st-all]').evaluate((el) => el.indeterminate), true, '勾了一部分：全选是半勾');
  await del.click();
  const dlg = page.locator('dialog.c-modal[open]');
  await dlg.waitFor();
  assert.match(await dlg.innerText(), new RegExp(`删除 2 个候选站？[\\s\\S]*${names[0]}、${names[1]}[\\s\\S]*恢复示例`));
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-dialog-cancel')), true, '危险操作焦点落在取消');
  await dlg.locator('[data-dialog-ok]').click();
  await page.locator('#toasts .c-toast', { hasText: '删掉了 2 个候选站' }).waitFor();
  assert.equal(await stations.count(), before - 2);
  for (const n of names.slice(0, 2)) assert.equal(await page.locator(`#form [data-train][data-station="${n}"]`).count(), 0, `${n} 的车次输入框跟着去掉`);
  // 全选再取消
  await page.locator('#form [data-st-all]').check();
  assert.equal(await del.innerText(), `删除选中（${before - 2}）`);
  await page.locator('#form [data-st-all]').uncheck();
  assert.equal(await del.isDisabled(), true);
  // 出发日期下面的开售提示（试玩的日期是下个周六）
  const hint = page.locator('#form [data-sale="options.travel_date"]');
  assert.match(await hint.innerText(), /^火车票 \d+月\d+日（周.）(已经开售|开售)/);
});

test('试玩：恢复示例', async () => {
  await bind(page, 'venue.name').fill('改过的名字');
  await page.locator('#stale').waitFor({ state: 'visible' });
  await page.locator('[data-try-reset]').click();
  await page.waitForFunction(() => document.querySelector('#form [data-bind="venue.name"]')?.value === '宏村示例酒店');
  assert.equal(await page.locator('#tryBanner').isVisible(), true);
});

test('试玩：系统切换深色和浅色，scene 带的 theme 跟着变，瓦片调暗、底图样式不变、点数不变', async () => {
  const before = await waitMapLayers(page, (l) => l.points === located, '恢复示例后预览的点（重画有 250 毫秒的延迟）');
  await page.emulateMedia({ colorScheme: 'dark' });
  await mapFrame(page).locator('html[data-theme=dark]').waitFor();
  // 不设高德的深色样式（设了审图号会消失），深色只靠瓦片滤镜
  assert.equal(await mapFrame(page).locator('[data-fake=map]').getAttribute('data-style'), 'amap://styles/normal');
  assert.equal(await mapFrame(page).locator('img[src*="appmaptile"]').first().evaluate((e) => getComputedStyle(e).filter), 'brightness(0.82) contrast(1.05)');
  assert.deepEqual((await mapLayers(page)).points, before.points);
  await page.emulateMedia({ colorScheme: 'light' });
  await mapFrame(page).locator('html[data-theme=light]').waitFor();
  await mapFrame(page).locator('[data-fake=map][data-style="amap://styles/normal"]').waitFor();
  assert.equal(await mapFrame(page).locator('[data-fake=map]').count(), 1, '换主题不重建地图');
});

test('试玩：手机宽度的三个页签、深色模式、没有横向滚动', { timeout: SLOW }, async () => {
  await context.close();
  ({ page, context, guard } = await newGuardedPage(base, { viewport: { width: 390, height: 844 }, colorScheme: 'dark', fakeJsApi: true }));
  await page.goto(`${base}/try`);
  await waitFormReady(page);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
  const tab = (name) => page.locator(`#tab${name}`);
  // 地图视野：点和路线合起来的外框（在地图页面里量，假 JS API 画的矢量），宽或高至少占地图容器的四成，并且都在容器里
  const mapFitted = async (what, onlyUsed = false) => {
    const ok = (v) => v.n > 0 && v.inside && (v.w >= v.cw * 0.4 || v.h >= v.ch * 0.4);
    let v;
    for (let i = 0; i < 30; i++) { v = await mapView(page, { onlyUsed }); if (ok(v)) return; await page.waitForTimeout(100); }
    assert.fail(`${what}：地图视野没缩放到地点和路线上，实际 ${JSON.stringify(v)}`);
  };
  const visible = async () => ({
    fill: await page.locator('#paneFill').isVisible(), map: await page.locator('#paneMap').isVisible(), plan: await page.locator('#panePlan').isVisible(),
  });
  // 三个页签，一次只显示一块
  assert.deepEqual(await visible(), { fill: true, map: false, plan: false });
  assert.equal(await noHScroll(), true);
  await tab('Map').click();
  assert.deepEqual(await visible(), { fill: false, map: true, plan: false });
  assert.equal(await tab('Map').getAttribute('aria-selected'), 'true');
  assert.equal(await noHScroll(), true);
  await mapFitted('载入后点「地图」');
  // 深色：scene 带 theme，设计变量的颜色跟着换；底图样式仍是普通样式（深色靠瓦片滤镜）
  const dark = await mapFrame(page).locator('body').evaluate(() => ({ theme: document.documentElement.dataset.theme, style: document.querySelector('[data-fake=map]').dataset.style }));
  assert.deepEqual(dark, { theme: 'dark', style: 'amap://styles/normal' });
  await tab('Plan').click();
  assert.deepEqual(await visible(), { fill: false, map: false, plan: true });
  assert.equal(await noHScroll(), true);
  await tab('Fill').click();
  assert.deepEqual(await visible(), { fill: true, map: false, plan: false });
  // 深色：页面背景是深色（亮度低）
  assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  assert.ok((r + g + b) / 3 < 100, `深色背景，实际 ${bg}`);
  // 手机上算完自动切到「方案」，方案页也不横向滚动
  await page.locator('#plan').click();
  await page.locator('#tabs .tab').first().waitFor({ timeout: SLOW });
  assert.equal(await page.locator('#app').getAttribute('data-tab'), 'plan');
  assert.equal(await noHScroll(), true);
  await tab('Map').click();
  await mapFitted('算完方案后点「地图」', true);
  await tab('Plan').click();
  // 推荐车站在手机上盖住整个屏幕，有「去地图上看」出口
  await tab('Fill').click();
  await openSuggest(page);
  assert.equal(await page.locator('[data-sg-map]').isVisible(), true);
  assert.equal(await noHScroll(), true);
  await page.locator('[data-sg-map]').click();
  assert.equal(await page.locator('#app').getAttribute('data-tab'), 'map');
  assert.equal(await page.locator('#drawer').isHidden(), true);
});
