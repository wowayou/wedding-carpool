// SPDX-License-Identifier: AGPL-3.0-or-later
// 方案页和示例页的地图（v3.16 切片 3、4）：iframe 嵌 /map/share（方案页，CSP 沙箱，只用不带底图的画法，站点设了 JS Key 也一样）或 /map（示例页，同源，有 Key 时用高德）。高德 JS API 用假的，不连外网。
// 方案页走真实的发布流程（建行程、POST /page，页面由 Worker 带 SHARE_CSP 返回），内容是 share.py 生成的金标准；
// 旧格式的方案页（3.15 以前发布的，HTML 里是 Leaflet）用同一个接口放进 KV 后打开。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, closeBrowser, FAKE_JS_KEY, newGuardedPage, ROOT, startWrangler } from './lib.mjs';

let withKey, noKey;
const guards = [];
before(async () => {
  withKey = (await startWrangler({ jsKey: FAKE_JS_KEY })).base;
  noKey = (await startWrangler()).base;
}, { timeout: 180_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => { for (const g of guards.splice(0)) g.assertClean(); });

const GOLDEN = readFileSync(join(ROOT, 'tests/golden/two_cars/share-o1-b1.html'), 'utf8'); // share.py 生成的方案页（去程 1 加返程 1，两个车主）
const OLD = readFileSync(join(ROOT, 'web/e2e/fixtures/share-3.15.html'), 'utf8'); // 3.15 的方案页：HTML 里是 Leaflet（cdnjs 的脚本和样式、高德瓦片）

// 建一个行程并发布方案页，返回方案页地址（不连高德：自己的 Key 模式建行程，只是 HTTP，不算方案）
async function publish(base, html) {
  const made = await (await fetch(`${base}/api/trips`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '地图测试', own: true }) })).json();
  const session = await fetch(`${base}/api/t/${made.id}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: made.key }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/t/${made.id}/page`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ html }) });
  assert.equal(res.status, 200);
  return `${base}${new URL((await res.json()).share.url, base).pathname}`;
}
const dataOf = (html) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1].replace(/<\\\//g, '</'));
const mapFrameOf = (page) => page.frames().find((f) => /^\/map(\/share)?$/.test(new URL(f.url()).pathname));

// 假 JS API 里的覆盖物（web/e2e/fake-amap.js 画的）
const fakeState = (frame) => frame.evaluate(() => {
  const box = document.getElementById('map'), W = box.clientWidth, H = box.clientHeight;
  const q = (k) => [...document.querySelectorAll(`[data-fake="${k}"]`)];
  return {
    W, H, style: document.querySelector('[data-fake=map]')?.dataset.style, theme: document.documentElement.dataset.theme,
    markers: q('circlemarker').map((e) => ({ x: +e.dataset.x, y: +e.dataset.y, fill: e.dataset.fill, hidden: e.dataset.hidden })),
    texts: q('text').map((e) => ({ text: e.textContent, hidden: e.dataset.hidden === 'true' })),
    lines: q('polyline').filter((e) => e.dataset.stroke).map((e) => ({ dash: e.dataset.dash, stroke: e.dataset.stroke })),
    legend: [...document.querySelectorAll('#legend > div')].map((e) => e.textContent.trim()),
    calls: window.__fakeAmap.calls.map((c) => c.fn),
  };
});
// 不带底图的画法里的图层（SVG 和标签）
const plainState = (frame) => frame.evaluate(() => {
  const box = document.getElementById('map'), W = box.clientWidth, H = box.clientHeight;
  return {
    W, H, theme: document.documentElement.dataset.theme, note: document.querySelector('.plain-note')?.textContent ?? null,
    points: [...document.querySelectorAll('[data-layer=point]')].map((e) => ({ name: e.dataset.name, x: +e.getAttribute('cx'), y: +e.getAttribute('cy'), fill: e.getAttribute('fill') })),
    lines: [...document.querySelectorAll('[data-layer=line]')].map((e) => ({ dash: e.getAttribute('stroke-dasharray'), stroke: e.getAttribute('stroke') })),
    labels: [...document.querySelectorAll('.plain-labels .lbl')].map((e) => e.textContent),
    legend: [...document.querySelectorAll('#legend > div')].map((e) => e.textContent.trim()),
    metaKey: document.querySelector('meta[name="amap-js-key"]')?.content,
    amap: typeof window.AMap,
  };
});
async function waitDrawn(page, n) {
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe')][0]; return !!f; });
  const t0 = Date.now();
  for (;;) {
    const frame = mapFrameOf(page);
    const k = frame ? await frame.evaluate(() => document.querySelectorAll('[data-fake="circlemarker"], [data-layer=point]').length).catch(() => 0) : 0;
    if (k >= n) return frame;
    if (Date.now() - t0 > 15_000) throw new Error(`地图里的点没有画出来（要 ${n} 个，现在 ${k} 个）`);
    await page.waitForTimeout(100);
  }
}

async function openShare(base, url, { allow = [], ...opts } = {}) {
  const P = await newGuardedPage(base, { fakeJsApi: true, ...opts });
  guards.push(P.guard);
  P.guard.allowErrors.push(/serviceWorker.*sandboxed/, ...allow); // Playwright 在沙箱页面里读 serviceWorker 的报错，和页面无关
  P.seen = [];
  P.page.on('response', (r) => { if (new URL(r.url()).pathname === '/map/share') P.seen.push({ status: r.status(), referer: r.request().headers().referer ?? null, csp: r.headers()['content-security-policy'] ?? '' }); });
  await P.page.goto(url);
  return P;
}

test('方案页（真实发布，CSP 沙箱，站点设了 JS Key）：地图在 /map/share 的 iframe 里用不带底图的画法，点、线对得上 data，地图里没有图例框，不请求高德', async () => {
  const url = await publish(withKey, GOLDEN);
  const data = dataOf(GOLDEN);
  const P = await openShare(withKey, url);
  assert.equal(await P.page.evaluate(() => self.origin), 'null', '方案页在沙箱里（匿名来源）');
  const frame = await waitDrawn(P.page, data.points.length);
  assert.equal(new URL(frame.url()).pathname, '/map/share');
  const st = await plainState(frame);
  assert.equal(st.note, '没有底图');
  assert.equal(st.metaKey, '', '页面里没有 Key');
  assert.equal(st.amap, 'undefined', '没有加载高德 JS API');
  assert.equal(st.points.length, data.points.length);
  const segs = data.routes.reduce((n, r) => n + r.path.length + (r.direct || []).length, 0) + data.taxis.length;
  assert.equal(st.lines.length, segs, '每段路线、每条直达线、每条打车线一条');
  assert.ok(st.lines.some((l) => l.dash), '直达路线是虚线');
  assert.equal(st.theme, 'light');
  // 方案页的地图里不画图例框（3.15 就没有），图例只在地图下面写成文字
  assert.deepEqual(st.legend, []);
  assert.equal(await frame.evaluate(() => document.getElementById('legend').hidden), true);
  assert.match(await P.page.locator('p.legend').innerText(), /彩色线/);
  assert.equal(st.W > 300, true);
  // 点都在容器里（自适应范围）
  assert.ok(st.points.every((m) => m.x >= 0 && m.x <= st.W && m.y >= 0 && m.y <= st.H), JSON.stringify(st.points));
  // 目的地、车站、出发地的名字都带着（成员名当文字）
  for (const p of data.points) assert.ok(st.labels.some((t) => t.startsWith(p.name)), p.name);
  assert.equal(P.seen[0].status, 200);
  assert.deepEqual(P.guard.jsApi, [], '没有任何请求发往高德（脚本、接口都没有）');
  // 页面的安全策略：沙箱、只多一条 frame-src 本站，没有 cdnjs 和高德
  const csp = (await fetch(url)).headers.get('content-security-policy');
  assert.match(csp, /frame-src 'self'/);
  assert.doesNotMatch(csp, /cdnjs|autonavi|amap|unsafe-eval/);
  // 地图页面自己的安全策略也没有高德和 unsafe-eval
  assert.doesNotMatch(P.seen[0].csp, /amap|autonavi|unsafe-eval/);
  assert.equal(await P.page.locator('#map').isVisible(), true);
  await P.context.close();
});

test('方案页：手机宽度、系统深色 —— 不带底图的画法照样换成深色版颜色；打印时地图定高、改用浅色', async () => {
  const url = await publish(withKey, GOLDEN);
  const P = await openShare(withKey, url, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const n = dataOf(GOLDEN).points.length;
  const frame = await waitDrawn(P.page, n);
  let st = await plainState(frame);
  const dark = st;
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.note, '没有底图');
  assert.equal(await P.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '没有横向滚动');
  // 系统深浅色切换：同一个地图换颜色，点数不变
  await P.page.emulateMedia({ colorScheme: 'light' });
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  st = await plainState(frame);
  assert.equal(st.points.length, n);
  assert.notEqual(st.points[0].fill, dark.points[0].fill, '深色和浅色的点颜色不同');
  // 打印：地图固定高度（样式表里是 330px，减去 1px 边框），按钮隐藏
  await P.page.emulateMedia({ media: 'print', colorScheme: 'light' });
  const box = await P.page.locator('#mapFrame').boundingBox();
  assert.ok(Math.abs(box.height - 328) <= 2, String(box.height));
  assert.equal(await P.page.locator('#printBtn').isHidden(), true);
  assert.deepEqual(P.guard.jsApi, [], '没有请求高德');
  await P.context.close();
});

test('方案页：站点没有 JS Key，地图也是不带底图的画法，点照样画出来', async () => {
  const url = await publish(noKey, GOLDEN);
  const P = await openShare(noKey, url, { fakeJsApi: false });
  const frame = await waitDrawn(P.page, dataOf(GOLDEN).points.length);
  assert.equal(await frame.locator('.plain-note').innerText(), '没有底图');
  assert.equal(await frame.locator('[data-layer=line]').count() > 0, true);
  await P.context.close();
});

test('旧格式的方案页（3.15 以前发布的，HTML 里是 Leaflet）：脚本和样式被拦下，地图那块藏起来，其余照常，没有脚本报错', async () => {
  const url = await publish(withKey, OLD);
  // 新的安全策略拦下 cdnjs 的 Leaflet 和高德瓦片：浏览器控制台会记「违反内容安全策略」，是预期的；不能有脚本异常
  const P = await openShare(withKey, url, { allow: [/violates the following Content Security Policy/] });
  await P.page.waitForTimeout(500);
  assert.equal(await P.page.locator('#map').isHidden(), true, '没有地图的位置');
  assert.equal(await P.page.locator('iframe').count(), 0);
  assert.ok(await P.page.locator('.card').count() > 0, '时间线卡片照常显示');
  assert.deepEqual(P.guard.external, [], 'Leaflet 和瓦片根本没发出请求');
  assert.deepEqual(P.guard.jsApi, []);
  assert.equal(P.guard.errors.filter((e) => e.startsWith('pageerror')).length, 0);
  await P.context.close();
});

test('示例页 /demo：同源的 /map iframe 里画出地图（不在沙箱里）', async () => {
  const P = await openShare(withKey, `${withKey}/demo`);
  const demo = readFileSync(join(ROOT, 'web/demo.html'), 'utf8');
  const data = dataOf(demo);
  const frame = await waitDrawn(P.page, data.points.length);
  assert.equal(new URL(frame.url()).pathname, '/map');
  assert.equal(await P.page.evaluate(() => self.origin), withKey, '示例页是普通的同源页面');
  const st = await fakeState(frame);
  assert.equal(st.markers.length, data.points.length);
  assert.ok(st.markers.every((m) => m.x >= 0 && m.x <= st.W && m.y >= 0 && m.y <= st.H));
  const segs = data.routes.reduce((n, r) => n + r.path.length + (r.direct || []).length, 0) + data.taxis.length;
  assert.equal(st.lines.length, segs);
  assert.deepEqual(st.legend, [], '示例页的地图里不画图例框');
  assert.equal(await frame.evaluate(() => document.getElementById('legend').hidden), true);
  assert.ok(await P.page.locator('p.legend').count() > 0, '地图下面的文字说明还在');
  // 示例页的 CSP（meta）只多一条 frame-src 'self'
  const csp = await P.page.locator('meta[http-equiv=Content-Security-Policy]').getAttribute('content');
  assert.match(csp, /frame-src 'self'/);
  assert.doesNotMatch(csp, /cdnjs|autonavi|amap|unsafe-eval/);
  await P.context.close();
});
