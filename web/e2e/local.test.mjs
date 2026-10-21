// SPDX-License-Identifier: AGPL-3.0-or-later
// 本地模式（ui.py）的端到端检查：读写配置文件、校验、推荐车站的设置面板。
// 不点「计算方案」和「开始找」；ui.py 用的是假 Key，出站请求也走了不存在的代理。
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { bind, cleanup, closeBrowser, FAKE_JS_KEY, mapLayers, newGuardedPage, openSuggest, ROOT, startLocal, waitFormReady, waitMapLayers, waitMapReady } from './lib.mjs';

let srv, page, guard;

before(async () => {
  srv = await startLocal();
  ({ page, guard } = await newGuardedPage(srv.base));
}, { timeout: 60_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => guard?.assertClean());

test('本地：加载配置', async () => {
  await page.goto(srv.base);
  await waitFormReady(page);
  await waitMapReady(page);
  assert.equal(await page.evaluate(() => document.body.classList.contains('online') || document.body.classList.contains('try')), false);
  assert.match(await page.locator('#status').innerText(), /本地 · trip\.toml/);
  assert.equal(await bind(page, 'venue.name').inputValue(), '宏村示例酒店');
  assert.equal(await page.locator('#save').isVisible(), true);
  assert.equal(await page.locator('#historyBtn').isHidden(), true, '本地没有历史');
  assert.equal(await page.locator('#tryBanner').count(), 0);
  assert.equal(await page.locator('#save').innerText(), '保存');
  // 地图：本地版自己提供 /map；没配 JS Key（AMAP_JS_KEY 或 .amap_js_key）就是不带底图的画法，点照样画出来
  const layers = await waitMapLayers(page, (l) => l.points > 0, '本地版预览的点');
  assert.equal(layers.renderer, 'plain');
  assert.equal(await page.locator('#mapFail').isHidden(), true);
});

test('本地：配了 JS Key（环境变量）时地图页面用高德 JS API（假的），带的是这个 Key', async () => {
  const keyed = await startLocal({ jsKey: FAKE_JS_KEY });
  const P = await newGuardedPage(keyed.base, { fakeJsApi: true });
  try {
    await P.page.goto(keyed.base);
    await waitFormReady(P.page);
    await waitMapReady(P.page);
    const layers = await waitMapLayers(P.page, (l) => l.points > 0, '预览的点');
    assert.equal(layers.renderer, 'amap');
    const loads = P.guard.jsApi.filter((u) => new URL(u).pathname === '/maps');
    assert.equal(loads.length, 1);
    assert.equal(new URL(loads[0]).searchParams.get('key'), FAKE_JS_KEY);
    P.guard.assertClean();
    assert.equal((await mapLayers(P.page)).points, layers.points);
  } finally { await P.context.close(); }
});

// 方案页预览（/share）：本地版把「生成方案页」写成的 <配置名>-plan.html 原样返回；里面的地图 iframe 嵌 /map/share（本地版自己提供，同一份页面）。
// 这里不真的算方案（假 Key 到不了高德），直接把 share.py 生成的金标准方案页放到 ui.py 读的位置
test('本地：方案页预览里有地图（嵌 /map/share，不带 Key 是不带底图的画法，配了 Key 用假的 JS API）', async () => {
  const golden = join(ROOT, 'tests/golden/two_cars/share-o1-b1.html');
  for (const jsKey of [undefined, FAKE_JS_KEY]) {
    const s = jsKey ? await startLocal({ jsKey }) : srv;
    copyFileSync(golden, join(s.dir, 'trip-plan.html'));
    const P = await newGuardedPage(s.base, { fakeJsApi: !!jsKey });
    try {
      await P.page.goto(`${s.base}/share`);
      await P.page.waitForFunction(() => document.querySelector('iframe#mapFrame'));
      const pts = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(readFileSync(golden, 'utf8'))[1]).points.length;
      const sel = jsKey ? '[data-fake="circlemarker"]' : '[data-layer=point]';
      const frame = () => P.page.frames().find((f) => new URL(f.url()).pathname === '/map/share');
      await P.page.waitForFunction(([n, q]) => { const f = [...document.querySelectorAll('iframe')][0]?.contentDocument; return f && f.querySelectorAll(q).length >= n; }, [pts, sel], { timeout: 15_000 });
      assert.equal(await frame().locator(sel).count(), pts);
      assert.equal(await P.page.locator('#map').isVisible(), true);
      assert.equal(await frame().locator('.plain-note').count(), jsKey ? 0 : 1, jsKey ? '配了 Key：高德画法，没有「没有底图」' : '没配 Key：不带底图的画法');
      P.guard.assertClean();
    } finally { await P.context.close(); }
  }
});

test('本地：改字段并保存，配置文件真的变了，第一次保存生成 .bak', async () => {
  assert.equal(existsSync(`${srv.config}.bak`), false, '保存前没有 .bak');
  await bind(page, 'venue.name').fill('e2e 改过的酒店');
  await page.waitForFunction(() => document.querySelector('#save').textContent === '保存*');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save').textContent === '保存');
  await page.locator('#toasts .c-toast', { hasText: '已保存' }).waitFor();
  const saved = readFileSync(srv.config, 'utf8');
  assert.match(saved, /e2e 改过的酒店/);
  assert.match(saved, /由 ui\.py 保存/);
  assert.equal(readFileSync(`${srv.config}.bak`, 'utf8'), srv.original, '.bak 是保存前的原文件');
  // 第二次保存不再覆盖 .bak
  await bind(page, 'venue.name').fill('e2e 第二次');
  await page.waitForFunction(() => document.querySelector('#save').textContent === '保存*');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save').textContent === '保存');
  assert.match(readFileSync(srv.config, 'utf8'), /e2e 第二次/);
  assert.equal(readFileSync(`${srv.config}.bak`, 'utf8'), srv.original, '.bak 仍是第一次保存前的内容');
  // 刷新后读到保存的内容
  await page.reload();
  await waitFormReady(page);
  assert.equal(await bind(page, 'venue.name').inputValue(), 'e2e 第二次');
});

test('本地：校验（格式问题就地标红，缺内容点计算后弹清单）', async () => {
  // 格式问题：稍等一下标在输入框旁，不弹窗
  await bind(page, 'options.travel_time').fill('abc');
  await page.locator('#form .ed-err', { hasText: '时:分' }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await bind(page, 'options.travel_time').fill('08:00');
  await page.locator('#form .ed-err').first().waitFor({ state: 'detached' });
  // 缺少必填项：点「计算方案」只弹校验清单，不会往下走（校验不过就不发请求）
  await bind(page, 'return.depart_time').fill('');
  await page.locator('#plan').click();
  const dlg = page.locator('dialog.c-modal[open]');
  await dlg.waitFor();
  await dlg.locator('[data-dialog-pick="return.depart_time"]').click();
  await page.waitForFunction(() => document.activeElement?.dataset?.bind === 'return.depart_time');
  await bind(page, 'return.depart_time').fill('20:30');
});

test('本地：推荐车站的设置面板；估算查不到路线（假 Key）时页面正常收场、不卡住', { timeout: 150_000 }, async () => {
  await openSuggest(page);
  assert.match(await page.locator('#sgSummary').innerText(), /目的地周边/);
  // 估算会查车主的驾车路线；假 Key 查不到（出站代理不通，重试几次后放弃），页面要结束「正在估算」：
  // 要么写明「估算没成功：原因」加「重试估算」，要么照常给出估算并在说明里写出哪些车主的路线查不到
  await page.waitForFunction(() => {
    const est = document.querySelector('#sgEst');
    return est && !/正在估算/.test(est.textContent) && est.textContent.trim() !== '';
  }, null, { timeout: 120_000 });
  const failed = await page.locator('#sgEst .c-alert--danger').count();
  if (failed) {
    assert.match(await page.locator('#sgEst').innerText(), /估算没成功：.+/);
    await page.locator('#sgEst [data-sg-retry-est]').waitFor();
  } else {
    assert.match(await page.locator('#sgEst').innerText(), /这次大约要 .+ 次地点搜索/);
  }
  assert.equal(await page.locator('#sgGo').isDisabled(), false, '主按钮可点（本测试不点它）');
  assert.equal(await page.locator('#sgWhy').isHidden(), true);
  // 设置面板：展开、改一项、超范围就地提示、恢复默认
  const toggle = page.locator('#sgToggle');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const radius = page.locator('#sgPanel [data-sg="dest_radius_km"]');
  await radius.fill('60');
  await page.locator('#sgSummary .c-tag--accent', { hasText: '改了 1 项' }).waitFor();
  await radius.fill('500');
  await page.locator('#sgPanel [data-sg-err="dest_radius_km"]:not([hidden])').waitFor();
  assert.match(await page.locator('#sgPanel [data-sg-err="dest_radius_km"]').innerText(), /30 到 150/);
  await page.locator('#sgPanel [data-sg-reset]').click();
  await page.locator('#sgSummary .c-tag--accent').waitFor({ state: 'detached' });
  // 页面仍能响应：Esc 关抽屉，没有卡在进度条上
  await page.keyboard.press('Escape');
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#progress').isHidden(), true);
});
