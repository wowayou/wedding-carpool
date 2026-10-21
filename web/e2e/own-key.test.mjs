// SPDX-License-Identifier: AGPL-3.0-or-later
// 自己的高德 Key 模式（3.15）：Key 只存在浏览器里，新建行程的请求不带 Key，计算时浏览器（含 Pyodide 计算线程）直连 restapi.amap.com。
// 高德返回由 lib.mjs 的 fakeDirectAmap 伪造（只有这个文件开启它）；发往 /amap-batch、/amap/ 的请求一律算失败。
// 公共额度（邀请码）行程仍走代理：见 online.test.mjs 的「推荐车站……估算请求被换成假错误」一条（断言请求发往代理并被拦下）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { bind, cleanup, closeBrowser, FAKE_KEY, newGuardedPage, ROOT, SLOW, startWrangler, waitFormReady, waitMapReady } from './lib.mjs';

const OTHER_KEY = 'fedcba9876543210fedcba9876543210';
let base, P, createBody, proxied;
const guards = [];

before(async () => { ({ base } = await startWrangler()); }, { timeout: 120_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => { for (const g of guards) g.assertClean(); });

// store.set 存的是 JSON，这里解出来
const stored = () => P.page.evaluate(() => JSON.parse(localStorage.getItem('carpool_amap_key') ?? 'null'));

test('自己的 Key：首页填假 Key 新建行程，请求体不带 Key，Key 存在本机', { timeout: SLOW }, async () => {
  P = await newGuardedPage(base, { fakeDirectAmap: true });
  guards.push(P.guard);
  proxied = [];
  P.context.on('request', (r) => { const u = new URL(r.url()); if (/\/amap(-batch)?([/?]|$)/.test(u.pathname)) proxied.push(r.url()); });
  const { page } = P;
  await page.goto(`${base}/`);
  await page.locator('input[name=mode][value=key]').check();
  await page.locator('#name').fill('e2e 自己的 Key');
  await page.locator('#amapKey').fill(FAKE_KEY);
  const req = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/trips');
  await page.locator('#createBtn').click();
  createBody = (await req).postData();
  assert.deepEqual(JSON.parse(createBody), { name: 'e2e 自己的 Key', own: true });
  assert.ok(!createBody.includes(FAKE_KEY), '新建请求体里没有 Key');
  await page.waitForURL(/\/t\/[a-z2-9]+#k=/);
  assert.equal(await stored(), FAKE_KEY, 'Key 存在本机 localStorage');
  // 首页验证 Key 是浏览器直接问高德
  assert.ok(P.guard.directAmap.some((h) => h.path === '/v3/geocode/geo' && h.key === FAKE_KEY));
});

test('自己的 Key：编辑页计算方案，所有高德请求直连 restapi.amap.com 且带本机的 Key，没有走代理', { timeout: SLOW }, async () => {
  const { page, guard } = P;
  await page.locator('#nameBox:not([hidden]) #nameInput').fill('甲');
  await page.locator('#nameForm button').click();
  await page.locator('#nameBox').waitFor({ state: 'hidden' });
  await waitFormReady(page);
  await waitMapReady(page);
  // 导入试玩示例配置（人、站、坐标都有，不需要地址解析）
  const cfg = JSON.parse(readFileSync(join(ROOT, 'web/try-trip.json'), 'utf8')).config;
  cfg.options.travel_date = '2030-10-12';
  cfg.return.date = '2030-10-13';
  await page.locator('#menuBtn').click();
  await page.locator('#drawer:not([hidden]) #importBtn').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#importBtn').click();
  await (await chooser).setFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ config: cfg })) });
  await page.locator('dialog.c-modal[open] [data-dialog-ok]').click();
  await page.locator('#toasts .c-toast', { hasText: '已导入' }).waitFor();
  await page.locator('#status', { hasText: '已同步' }).waitFor();
  assert.equal(await bind(page, 'venue.name').inputValue(), '宏村示例酒店');

  const before = guard.directAmap.length;
  await page.locator('#plan').click();
  await page.locator('#tabs .tab').first().waitFor({ timeout: SLOW });
  assert.match(await page.locator('#tabs .tab').first().innerText(), /方案 1/);
  const hits = guard.directAmap.slice(before);
  assert.ok(hits.length >= 5, `计算发出了直连高德的请求（${hits.length} 个）`);
  assert.ok(hits.some((h) => h.path === '/v3/distance') && hits.some((h) => h.path === '/v3/direction/driving'), '测距和驾车路线都查了');
  for (const h of hits) assert.equal(h.key, FAKE_KEY, `${h.path} 带的是本机的 Key`);
  assert.deepEqual(proxied, [], '没有任何请求发到 /amap-batch 或 /amap/');
  assert.deepEqual(guard.amapHits, []);
  // 计算线程（Pyodide Web Worker）直连没有被 CSP 拦下：guard.errors 里没有 connect-src 违规（afterEach 的 assertClean 也会查）
  assert.ok(!guard.errors.some((e) => /Content Security Policy|connect-src|Refused to connect/i.test(e)), guard.errors.join('\n'));
});

test('自己的 Key：清掉本机 Key 后点「计算方案」弹提示，填假 Key 后能继续算', { timeout: SLOW }, async () => {
  const { page, guard } = P;
  await bind(page, 'options.max_detour_min').fill('31'); // 改一项让方案过期，下面重新算完就恢复
  await page.locator('#stale').waitFor({ state: 'visible' });
  await page.evaluate(() => localStorage.removeItem('carpool_amap_key'));
  const before = guard.directAmap.length;
  await page.locator('#plan').click();
  await page.locator('#quotaBox:not([hidden])').waitFor();
  assert.match(await page.locator('#quotaTitle').innerText(), /这台设备上还没填高德 Key/);
  assert.match(await page.locator('#quotaText').innerText(), /这台设备上还没填/);
  assert.equal(guard.directAmap.length, before, '没有 Key 时不发请求');
  await page.locator('#quotaKey').fill(FAKE_KEY);
  await page.locator('#quotaKeyBtn').click();
  await page.locator('#quotaBox').waitFor({ state: 'hidden' });
  assert.equal(await stored(), FAKE_KEY);
  await page.locator('#plan').click();
  // 重新算完：过期标记消失。同一个计算线程里已经查过的请求有缓存，不一定再发新请求，所以不断言请求数
  await page.locator('#stale').waitFor({ state: 'hidden', timeout: SLOW });
  assert.equal(await page.locator('#plan').innerText(), '计算方案');
  assert.ok(guard.directAmap.slice(before).every((h) => h.key === FAKE_KEY));
  assert.deepEqual(proxied, []);
});

test('自己的 Key：「更多」里显示已填（尾号），可更换、清除', { timeout: SLOW }, async () => {
  const { page, guard } = P;
  await page.locator('#menuBtn').click();
  const row = page.locator('#drawer:not([hidden]) .kv', { hasText: '这台设备上的高德 Key' });
  await row.waitFor();
  assert.match(await row.innerText(), /已填（尾号 cdef）/);
  assert.doesNotMatch(await page.locator('#drawer').innerText(), /0123456789abcdef/, '页面上不显示完整 Key');
  // 更换：验证（直连高德，带新 Key）后存本机
  await page.locator('#ownKeyChange').click();
  await page.locator('#quotaBox:not([hidden])').waitFor();
  assert.match(await page.locator('#quotaTitle').innerText(), /更换这台设备上的高德 Key/);
  await page.locator('#quotaKey').fill(OTHER_KEY);
  await page.locator('#quotaKeyBtn').click();
  await page.locator('#quotaBox').waitFor({ state: 'hidden' });
  assert.equal(await stored(), OTHER_KEY);
  assert.ok(guard.directAmap.some((h) => h.key === OTHER_KEY), '验证新 Key 是浏览器直连高德');
  await page.locator('#menuBtn').click();
  await page.locator('#drawer:not([hidden]) .kv', { hasText: '尾号 3210' }).waitFor();
  // 清除（要确认）
  await page.locator('#ownKeyClear').click();
  await page.locator('dialog.c-modal[open] [data-dialog-ok]').click();
  await page.locator('#toasts .c-toast', { hasText: '已清除' }).waitFor();
  assert.equal(await stored(), null);
  await page.locator('#drawer .kv', { hasText: '还没填' }).waitFor();
  assert.deepEqual(proxied, []);
});
