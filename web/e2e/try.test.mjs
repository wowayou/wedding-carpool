// SPDX-License-Identifier: AGPL-3.0-or-later
// 试玩模式（/try）的端到端检查：不保存、不调用高德，计算在浏览器里的 Pyodide 中完成。
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { bind, cleanup, closeBrowser, newGuardedPage, openSuggest, SLOW, startWrangler, waitFormReady, waitMapReady } from './lib.mjs';

let base, page, context, guard;

before(async () => {
  ({ base } = await startWrangler());
}, { timeout: 120_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => guard?.assertClean());

// 桌面页面：整个文件里共用一个，Pyodide 只加载一次
test('试玩：加载', { timeout: SLOW }, async () => {
  ({ page, context, guard } = await newGuardedPage(`${base}`));
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
});

test('试玩：计算方案，方案卡片和地图图层都出来', { timeout: SLOW }, async () => {
  await page.locator('#plan').click();
  await page.locator('#tabs .tab').first().waitFor({ timeout: SLOW });
  assert.ok(await page.locator('#tabs .tab').count() >= 1);
  assert.match(await page.locator('#tabs .tab').first().innerText(), /方案 1/);
  assert.ok((await page.locator('#report').innerText()).length > 50, '报告有内容');
  assert.equal(await page.locator('#stale').isHidden(), true, '刚算完不过期');
  assert.equal(await page.locator('#plan').innerText(), '计算方案', '按钮恢复');
  // 地图：方案路线画在 overlayPane 里
  await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length > 0);
  assert.ok(await page.locator('#map .leaflet-overlay-pane path').count() > 0);
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
  // 地图上有找站过程图层（自建 pane 里的圈和路线）
  await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-sug-pane path').length > 0);
  assert.equal(await page.locator('.legend-sug').isVisible(), true, '图例多出找站过程的几行');
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
  await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-sug-pane path').length === 0);
  assert.equal(await page.locator('.legend-sug').isHidden(), true);
});

test('试玩：恢复示例', async () => {
  await bind(page, 'venue.name').fill('改过的名字');
  await page.locator('#stale').waitFor({ state: 'visible' });
  await page.locator('[data-try-reset]').click();
  await page.waitForFunction(() => document.querySelector('#form [data-bind="venue.name"]')?.value === '宏村示例酒店');
  assert.equal(await page.locator('#tryBanner').isVisible(), true);
});

test('试玩：手机宽度的三个页签、深色模式、没有横向滚动', { timeout: SLOW }, async () => {
  await context.close();
  ({ page, context, guard } = await newGuardedPage(base, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' }));
  await page.goto(`${base}/try`);
  await waitFormReady(page);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
  const tab = (name) => page.locator(`#tab${name}`);
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
  // 推荐车站在手机上盖住整个屏幕，有「去地图上看」出口
  await tab('Fill').click();
  await openSuggest(page);
  assert.equal(await page.locator('[data-sg-map]').isVisible(), true);
  assert.equal(await noHScroll(), true);
  await page.locator('[data-sg-map]').click();
  assert.equal(await page.locator('#app').getAttribute('data-tab'), 'map');
  assert.equal(await page.locator('#drawer').isHidden(), true);
});
