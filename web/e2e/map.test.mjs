// SPDX-License-Identifier: AGPL-3.0-or-later
// 地图页面（v3.16 切片 1）：/map 和 /map/share 的画法、消息、嵌入规则。高德 JS API 用 web/e2e/fake-amap.js 的替身，不连外网。
// 父页面都是只在测试里用的页面（lib.mjs 的 stubs，不进正式构建）：嵌 /map 的是同源页面；嵌 /map/share 的模仿方案页（CSP 沙箱，来源是 null）。
// 两台 wrangler：一台设了（假的）AMAP_JS_KEY，一台没设。
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, closeBrowser, FAKE_JS_KEY, newGuardedPage, startWrangler } from './lib.mjs';

let withKey, noKey;
const guards = [];
before(async () => {
  withKey = (await startWrangler({ jsKey: FAKE_JS_KEY })).base;
  noKey = (await startWrangler()).base;
}, { timeout: 180_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => { for (const g of guards.splice(0)) g.assertClean(); });

// 测试用父页面：嵌地图 iframe，收它的消息记在 window.__msgs，等它 ready 了再发 scene（window.__send）
const parentHtml = (src, { target = 'location.origin', attrs = '' } = {}) => `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" src="${src}" ${attrs} style="width:800px;height:500px;border:0"></iframe>
<script>
window.__msgs = []; let ready = false, pending = null;
const f = document.getElementById('f');
const post = (m) => f.contentWindow.postMessage(m, ${target});
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow) return;
  window.__msgs.push(e.data);
  if (e.data.type === 'ready') { ready = true; if (pending) post(pending); }
});
window.__send = (scene) => { pending = { type: 'scene', scene }; if (ready) post(pending); };
window.__post = (m) => post(m);
</script>`;

const SCENE = (extra = {}) => ({
  v: 1, theme: 'light',
  points: [
    { lng: 117.98, lat: 30.0, kind: 'venue', name: '宏村示例酒店', priority: 0 },
    { lng: 120.12, lat: 30.27, kind: 'car', name: '老王（开车）', priority: 2 },
    { lng: 118.27, lat: 29.81, kind: 'st', name: '黄山北站', notes: ['老王 多绕 15 分钟'], highlight: false, priority: 4, radius: 6 },
  ],
  lines: [
    { path: [[120.12, 30.27], [117.98, 30.0]], color: '--taxi', weight: 4, opacity: 0.8, dash: [6, 8], tooltip: '老王不接人的直达路线' },
    { path: [[120.12, 30.27], [118.27, 29.81], [117.98, 30.0]], color: '#c2410c', weight: 5, opacity: 0.85, tooltip: '老王：多绕 15 分钟' },
  ],
  circles: [{ center: [118.27, 29.81], radius_m: 30000, color: '--station', weight: 1, opacity: 0.6, fillOpacity: 0.06, dash: [4, 4] }],
  fit: { auto: true, padding: { top: 16, right: 200, bottom: 16, left: 16 }, maxZoom: 12 },
  legend: [{ type: 'dot', color: '--dest', text: '目的地' }, { type: 'line', color: '--taxi', dash: [6, 8], text: '直达路线' }],
  ...extra,
});

async function open(base, path, { fake = true, stubPath = '/__test/parent', stub, allow, ...rest } = {}) {
  const P = await newGuardedPage(base, { fakeJsApi: fake, stubs: { [stubPath]: { body: stub ?? parentHtml(path) } }, ...rest });
  guards.push(P.guard);
  if (allow) P.guard.allowErrors.push(allow);
  await P.page.goto(`${base}${stubPath}`);
  return P;
}
const drawnCount = (page) => page.evaluate(() => window.__msgs.filter((m) => m.type === 'drawn').length);
async function send(page, scene) {
  const n = await drawnCount(page);
  await page.evaluate((s) => window.__send(s), scene);
  await page.waitForFunction((k) => window.__msgs.filter((m) => m.type === 'drawn').length > k, n, { timeout: 15_000 });
  return page.evaluate(() => window.__msgs.filter((m) => m.type === 'drawn').at(-1));
}
const mapFrame = (page) => page.frames().find((f) => /^\/map(\/share)?$/.test(new URL(f.url()).pathname));

// 假 JS API 里的覆盖物：位置和是否在容器里
const fakeState = (frame) => frame.evaluate(() => {
  const box = document.getElementById('map'), W = box.clientWidth, H = box.clientHeight;
  const q = (k) => [...document.querySelectorAll(`[data-fake="${k}"]`)];
  const pos = (el) => ({ x: +el.dataset.x, y: +el.dataset.y, inside: +el.dataset.x >= 0 && +el.dataset.x <= W && +el.dataset.y >= 0 && +el.dataset.y <= H });
  return {
    W, H,
    style: document.querySelector('[data-fake=map]')?.dataset.style,
    theme: document.documentElement.dataset.theme,
    markers: q('circlemarker').map((e) => ({ ...pos(e), radius: e.dataset.radius, fill: e.dataset.fill })),
    texts: q('text').map((e) => ({ text: e.textContent, hidden: e.dataset.hidden === 'true' })),
    lines: q('polyline').map((e) => ({ dash: e.dataset.dash, stroke: e.dataset.stroke, xs: e.dataset.xs.split(',').map(Number), ys: e.dataset.ys.split(',').map(Number) })),
    circles: q('circle').map((e) => ({ ...pos(e), radiusM: e.dataset.radiusM, dash: e.dataset.dash })),
    calls: window.__fakeAmap.calls.map((c) => c.fn),
    fit: window.__fakeAmap.calls.filter((c) => c.fn === 'setFitView').map((c) => c.arg),
    legend: [...document.querySelectorAll('#legend div')].map((d) => d.textContent),
  };
});
const insideAll = (st) => st.markers.every((m) => m.inside) && st.lines.every((l) => l.xs.every((x, i) => x >= 0 && x <= st.W && l.ys[i] >= 0 && l.ys[i] <= st.H));

test('/map 有 Key：加载假 JS API，画出点、标签、线、圈，回报 drawn（amap），所有位置在容器里', async () => {
  const { page, guard } = await open(withKey, '/map');
  const drawn = await send(page, SCENE());
  assert.deepEqual(drawn, { type: 'drawn', renderer: 'amap', points: 3, lines: 2, circles: 1 });
  const msgs = await page.evaluate(() => window.__msgs.map((m) => m.type));
  assert.deepEqual(msgs, ['ready', 'drawn']);
  // 加载的是 JS API 2.0，带的是页面里的 Key
  const loads = guard.jsApi.filter((u) => new URL(u).pathname === '/maps');
  assert.equal(loads.length, 1);
  assert.equal(new URL(loads[0]).searchParams.get('v'), '2.0');
  assert.equal(new URL(loads[0]).searchParams.get('key'), FAKE_JS_KEY);
  const st = await fakeState(mapFrame(page));
  assert.equal(st.markers.length, 3);
  assert.equal(st.texts.length, 3);
  assert.equal(st.lines.length, 2); // 自适应用的看不见的线已拿掉
  assert.equal(st.circles.length, 1);
  assert.equal(st.circles[0].radiusM, '30000');
  assert.equal(st.circles[0].dash, '4 4');
  assert.equal(st.lines[0].dash, '6 8');
  assert.equal(st.lines[1].dash, '');
  assert.equal(st.lines[1].stroke, '#c2410c');
  assert.match(st.lines[0].stroke, /^#[0-9a-f]{6}$/i, '设计变量 --taxi 在页面里被换成了颜色值');
  assert.match(st.markers[0].fill, /^#[0-9a-f]{6}$/i);
  assert.notEqual(st.markers[0].fill, st.markers[1].fill); // 目的地和开车的成员颜色不同
  assert.deepEqual(st.calls.filter((c) => ['Map', 'setMapStyle'].includes(c)), ['Map']);
  assert.equal(st.style, 'amap://styles/normal');
  assert.equal(st.fit.length, 1);
  assert.equal(st.fit[0].immediately, true);
  assert.deepEqual(st.fit[0].avoid, [16, 16, 16, 200]); // 上、下、左、右
  assert.equal(st.fit[0].maxZoom, 12);
  assert.ok(insideAll(st), JSON.stringify(st.markers));
  // 右边留了 200 像素（被抽屉遮住的一截）：点都在留白之外
  assert.ok(st.markers.every((m) => m.x <= st.W - 200 + 1), JSON.stringify(st.markers));
  assert.deepEqual(st.legend, ['目的地', '直达路线']);
});

test('/map 标签：只留不互相遮挡的（按优先级），不高亮的悬停才显示', async () => {
  const { page } = await open(withKey, '/map');
  // 两个高亮的点在同一个位置：优先级数字小的留下；第三个不高亮，不参与
  const scene = SCENE({ points: [
    { lng: 117.98, lat: 30.0, kind: 'st', name: '站 B', priority: 3 },
    { lng: 117.98, lat: 30.0, kind: 'venue', name: '目的地 A', priority: 0 },
    { lng: 119.0, lat: 30.5, kind: 'st', name: '其他站', highlight: false, priority: 4 },
  ] });
  await send(page, scene);
  const frame = mapFrame(page);
  const hidden = async () => Object.fromEntries((await fakeState(frame)).texts.map((t) => [t.text, t.hidden]));
  assert.deepEqual(await hidden(), { '站 B': true, '目的地 A': false, '其他站': true });
  // 悬停不高亮的点：显示它的标签；移开又隐藏
  const other = frame.locator('[data-fake=circlemarker]').nth(2);
  await other.dispatchEvent('mouseover');
  assert.equal((await hidden())['其他站'], false);
  await other.dispatchEvent('mouseout');
  assert.equal((await hidden())['其他站'], true);
  // 悬停被遮挡的高亮点：也显示
  await frame.locator('[data-fake=circlemarker]').nth(0).dispatchEvent('mouseover');
  assert.equal((await hidden())['站 B'], false);
  // 悬停线显示 tooltip
  await frame.locator('[data-fake=polyline]').nth(0).dispatchEvent('mouseover');
  assert.equal(await frame.locator('#tip').isVisible(), true);
  assert.equal(await frame.locator('#tip').textContent(), '老王不接人的直达路线');
  await frame.locator('[data-fake=polyline]').nth(0).dispatchEvent('mouseout');
  assert.equal(await frame.locator('#tip').isVisible(), false);
});

test('/map 深色：用高德自带的深色样式，页面颜色变量跟着换；再换回浅色', async () => {
  const { page } = await open(withKey, '/map');
  await send(page, SCENE());
  const light = (await fakeState(mapFrame(page)));
  await send(page, SCENE({ theme: 'dark' }));
  const dark = await fakeState(mapFrame(page));
  assert.equal(dark.style, 'amap://styles/dark');
  assert.equal(dark.theme, 'dark');
  assert.ok(dark.calls.includes('setMapStyle'));
  assert.equal(dark.calls.filter((c) => c === 'Map').length, 1, '换主题不重建地图');
  assert.notEqual(dark.markers[0].fill, light.markers[0].fill, '深色用深色版的设计变量');
  await send(page, SCENE());
  assert.equal((await fakeState(mapFrame(page))).style, 'amap://styles/normal');
});

test('/map 尺寸：容器 0×0 时先记下，收到 resize 有尺寸了再补做自适应；不重复做', async () => {
  const { page } = await open(withKey, '/map');
  await send(page, SCENE({ fit: { auto: false } })); // 先建好地图
  await page.evaluate(() => { document.getElementById('f').style.display = 'none'; });
  await page.waitForFunction(() => !document.getElementById('f').offsetWidth);
  const frame = mapFrame(page);
  await send(page, SCENE()); // 隐藏时来了要自适应的 scene
  assert.deepEqual((await fakeState(frame)).fit, [], '容器没有尺寸，不能自适应（会缩到最小一级）');
  await page.evaluate(() => { document.getElementById('f').style.display = ''; });
  await page.waitForFunction(() => document.getElementById('f').offsetWidth > 0);
  await page.evaluate(() => window.__post({ type: 'resize' }));
  await page.waitForFunction(() => document.getElementById('f').contentWindow.__fakeAmap?.calls.some((c) => c.fn === 'setFitView'));
  const st = await fakeState(frame);
  assert.equal(st.fit.length, 1);
  assert.ok(insideAll(st));
  assert.ok(st.calls.includes('resize'), 'resize 时让地图重新计算尺寸');
  await page.evaluate(() => window.__post({ type: 'resize' }));
  await page.waitForTimeout(200);
  assert.equal((await fakeState(frame)).fit.length, 1, '补做过就不再重复（不打断用户拖动的视野）');
});

test('/map 消息来源：只认同源的父窗口，别的窗口发来的 scene 不理；不合法的 scene 回报 fail', async () => {
  const stub = `${parentHtml('/map')}<iframe id="g" src="/__test/blank" style="display:none"></iframe>`;
  const P = await newGuardedPage(withKey, { fakeJsApi: true, stubs: { '/__test/parent': { body: stub }, '/__test/blank': { body: '<!doctype html><meta charset="utf-8">' } } });
  guards.push(P.guard);
  const { page } = P;
  await page.goto(`${withKey}/__test/parent`);
  await send(page, SCENE());
  const before = await drawnCount(page);
  // 兄弟 iframe（同源，但不是父窗口）给地图页面发 scene：忽略
  await page.frames().find((f) => f.url().endsWith('/__test/blank')).evaluate((s) => { window.parent.frames[0].postMessage({ type: 'scene', scene: s }, location.origin); }, SCENE({ points: [] }));
  await page.waitForTimeout(300);
  assert.equal(await drawnCount(page), before);
  assert.equal((await fakeState(mapFrame(page))).markers.length, 3);
  // 不合法的 scene：fail，不画
  await page.evaluate(() => window.__post({ type: 'scene', scene: { v: 1, theme: 'light', points: [{ lng: 'x' }], lines: [], circles: [] } }));
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'fail'));
  const fail = await page.evaluate(() => window.__msgs.find((m) => m.type === 'fail'));
  assert.match(fail.reason, /^bad-scene: .*points\[0\]/);
  assert.equal(await drawnCount(page), before);
});

test('/map 没有 Key：不加载高德，用不带底图的画法，SVG 里点、线、圈都在容器内，角上写「没有底图」', async () => {
  const { page, guard } = await open(noKey, '/map');
  const drawn = await send(page, SCENE());
  assert.deepEqual(drawn, { type: 'drawn', renderer: 'plain', points: 3, lines: 2, circles: 1 });
  assert.deepEqual(guard.jsApi, [], '没有 Key 不请求高德');
  const frame = mapFrame(page);
  const st = await frame.evaluate(() => {
    const box = document.getElementById('map'), W = box.clientWidth, H = box.clientHeight;
    const inside = (x, y) => x >= 0 && x <= W && y >= 0 && y <= H;
    const pts = [...document.querySelectorAll('[data-layer=point]')].map((e) => ({ name: e.dataset.name, kind: e.dataset.kind, x: +e.getAttribute('cx'), y: +e.getAttribute('cy'), fill: e.getAttribute('fill'), op: e.getAttribute('fill-opacity') }));
    const lines = [...document.querySelectorAll('[data-layer=line]')].map((e) => ({ dash: e.getAttribute('stroke-dasharray'), stroke: e.getAttribute('stroke'), pts: e.getAttribute('points').split(' ').map((p) => p.split(',').map(Number)) }));
    const circles = [...document.querySelectorAll('[data-layer=circle]')].map((e) => ({ x: +e.getAttribute('cx'), y: +e.getAttribute('cy'), r: +e.getAttribute('r') }));
    return { W, H, pts, lines, circles, note: document.querySelector('.plain-note')?.textContent, noteVisible: !!document.querySelector('.plain-note')?.offsetWidth,
      labels: [...document.querySelectorAll('.lbl')].map((e) => ({ text: e.textContent, vis: getComputedStyle(e).visibility })), legend: [...document.querySelectorAll('#legend div')].map((d) => d.textContent),
      inside: pts.every((p) => inside(p.x, p.y)) && lines.every((l) => l.pts.every(([x, y]) => inside(x, y))) && circles.every((c) => inside(c.x, c.y)) };
  });
  assert.equal(st.pts.length, 3);
  assert.equal(st.lines.length, 2);
  assert.equal(st.circles.length, 1);
  assert.ok(st.inside, JSON.stringify(st));
  assert.ok(st.circles[0].r > 5, '30 公里的圈有可见的半径');
  assert.equal(st.note, '没有底图');
  assert.ok(st.noteVisible);
  assert.equal(st.lines[0].dash, '6 8');
  assert.equal(st.lines[1].dash, null);
  assert.match(st.pts[0].fill, /^#[0-9a-f]{6}$/i);
  assert.equal(st.pts[2].op, '0.5'); // 不高亮的半透明
  assert.ok(st.pts.every((p) => p.x <= st.W - 200 + 1), '右边留的 200 像素没有点');
  assert.deepEqual(st.labels.map((l) => [l.text, l.vis]), [['宏村示例酒店', 'visible'], ['老王（开车）', 'visible'], ['黄山北站\n老王 多绕 15 分钟', 'hidden']]);
  assert.deepEqual(st.legend, ['目的地', '直达路线']);
  // 悬停不高亮的点显示它的标签
  await frame.locator('[data-layer=point]').nth(2).dispatchEvent('mouseenter');
  assert.equal(await frame.locator('.lbl').nth(2).evaluate((e) => getComputedStyle(e).visibility), 'visible');
});

test('/map 不带底图：可以用滚轮缩放、拖动，缩放后点的位置变了；resize 补做自适应', async () => {
  const { page } = await open(noKey, '/map');
  await send(page, SCENE());
  const frame = mapFrame(page);
  const pos = () => frame.locator('[data-layer=point]').first().evaluate((e) => [+e.getAttribute('cx'), +e.getAttribute('cy')]);
  const p0 = await pos();
  await page.locator('#f').hover({ position: { x: 300, y: 250 } });
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(200);
  const p1 = await pos();
  assert.notDeepEqual(p1, p0);
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(340, 280, { steps: 4 });
  await page.mouse.up();
  const p2 = await pos();
  assert.ok(Math.abs(p2[0] - p1[0] - 40) < 2 && Math.abs(p2[1] - p1[1] - 30) < 2, `${p1} -> ${p2}`);
  // 容器隐藏时来的 scene：显示后 resize，点回到容器里
  await page.evaluate(() => { document.getElementById('f').style.display = 'none'; });
  await send(page, SCENE());
  await page.evaluate(() => { document.getElementById('f').style.display = ''; });
  await page.waitForFunction(() => document.getElementById('f').offsetWidth > 0);
  await page.evaluate(() => window.__post({ type: 'resize' }));
  await page.waitForTimeout(200);
  const p3 = await pos();
  assert.ok(p3[0] >= 0 && p3[0] <= 800 && p3[1] >= 0 && p3[1] <= 500, String(p3));
});

test('/map 有 Key 但 JS API 加载失败：先回报 fail，再改用不带底图的画法', async () => {
  const { page } = await open(withKey, '/map', { fake: 'fail', allow: /Failed to load resource/ }); // 脚本请求被我们拦掉，浏览器会记一条报错
  const drawn = await send(page, SCENE());
  assert.equal(drawn.renderer, 'plain');
  const msgs = await page.evaluate(() => window.__msgs.map((m) => m.type + (m.reason ? `:${m.reason}` : '')));
  assert.deepEqual(msgs, ['ready', 'fail:amap-load', 'drawn']);
  assert.equal(await mapFrame(page).locator('[data-layer=point]').count(), 3);
});

// ---------- /map/share：方案页嵌它 ----------
// 方案页在 CSP 沙箱里（来源是 null）。实测（Chromium）：沙箱页面发出的 iframe 请求不带 Referer，不管 referrerpolicy 写什么
// （见下面「已知问题」一条）。所以这里分开测：
//   1) 沙箱页面的消息机制（来源 null、脚本加载、按 e.source 认父窗口）：由测试进程带着 /p/… 的 Referer 去问 wrangler，再把响应交给浏览器，模拟「Referer 规则通过」
//   2) Worker 的 Referer 规则本身：非沙箱的 /p/… 页面（真 Referer）能画；别的来源、别的页面、只有来源的都是 403
//   3) 已知问题：真的沙箱页面拿不到 Referer，按现在的规则是 403
const SANDBOX = 'sandbox allow-scripts allow-popups allow-modals';
const page_ = (html, { sandbox = true, policy } = {}) => ({ body: html, headers: { ...(sandbox ? { 'content-security-policy': SANDBOX } : {}), ...(policy ? { 'referrer-policy': policy } : {}) } });
const SHARE_PATH = '/p/abcdefghjk';
const IGNORED = [/Failed to load resource/, /serviceWorker.*sandboxed/]; // 403 的资源报错；Playwright 在沙箱页面里读 serviceWorker 的报错

async function openShare(base, stub, { path = SHARE_PATH, referer } = {}) {
  const P = await newGuardedPage(base, { fakeJsApi: true, stubs: { [path]: stub } });
  guards.push(P.guard);
  P.guard.allowErrors.push(...IGNORED);
  P.seen = [];
  // 模拟 Referer：浏览器的请求头改不了（Playwright 的 continue/fallback 改了 Referer 也不会真发出去），改成测试进程带着这个 Referer 去问 wrangler，再把整个响应交给浏览器
  if (referer) {
    await P.context.route('**/map/share', async (r) => {
      const res = await fetch(r.request().url(), { headers: { referer } });
      await r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
  }
  P.page.on('response', (r) => { if (new URL(r.url()).pathname === '/map/share') P.seen.push({ status: r.status(), referer: r.request().headers().referer ?? null, xfo: r.headers()['x-frame-options'] ?? null, csp: r.headers()['content-security-policy'] ?? '' }); });
  await P.page.goto(`${base}${path}`);
  return P;
}
const settle403 = (P) => P.page.waitForTimeout(600); // 403 没有消息可等，给 iframe 一点时间加载完

test('/map/share：沙箱页面（来源 null）嵌它，按 e.source 认父窗口、目标来源用 *，能画出来（Referer 由测试进程带着去问 wrangler 来模拟）', async () => {
  const P = await openShare(withKey, page_(parentHtml('/map/share', { target: "'*'" }), { policy: 'strict-origin' }), { referer: `${withKey}${SHARE_PATH}` });
  assert.equal(await P.page.evaluate(() => self.origin), 'null', '父页面是沙箱里的匿名来源（location.origin 在沙箱里仍是地址的来源，要看 self.origin）');
  const drawn = await send(P.page, SCENE());
  assert.deepEqual(drawn, { type: 'drawn', renderer: 'amap', points: 3, lines: 2, circles: 1 });
  assert.equal(P.seen.length, 1);
  assert.equal(P.seen[0].status, 200);
  assert.equal(P.seen[0].xfo, null, '/map/share 不带 X-Frame-Options，沙箱页面才嵌得进来');
  assert.doesNotMatch(P.seen[0].csp, /frame-ancestors/);
  const st = await fakeState(mapFrame(P.page));
  assert.equal(st.markers.length, 3);
  assert.ok(insideAll(st));
  assert.equal(await mapFrame(P.page).evaluate(() => self.origin), 'null', '地图页面也在沙箱里（继承）');
  // resize 同样是父窗口发的，被接受
  await P.page.evaluate(() => window.__post({ type: 'resize' }));
  await P.page.waitForTimeout(200);
  assert.ok((await fakeState(mapFrame(P.page))).calls.includes('resize'));
});

test('/map/share：非沙箱的 /p/… 页面发的是真 Referer（iframe 要写 no-referrer-when-downgrade），能画；没写时只剩来源，403', async () => {
  const ok = await openShare(withKey, page_(parentHtml('/map/share', { target: "'*'", attrs: 'referrerpolicy="no-referrer-when-downgrade"' }), { sandbox: false, policy: 'strict-origin' }));
  assert.equal((await send(ok.page, SCENE())).renderer, 'amap');
  assert.equal(ok.seen[0].referer, `${withKey}${SHARE_PATH}`, 'iframe 的 Referer 带着完整的 /p/… 路径（页面自己是 strict-origin，靠 iframe 的属性放宽）');
  const trimmed = await openShare(withKey, page_(parentHtml('/map/share', { target: "'*'" }), { sandbox: false, policy: 'strict-origin' }));
  await settle403(trimmed);
  assert.equal(trimmed.seen[0].status, 403);
  assert.equal(trimmed.seen[0].referer, `${withKey}/`, '只带来源');
  assert.deepEqual(await trimmed.page.evaluate(() => window.__msgs), []);
  assert.deepEqual(trimmed.guard.jsApi, [], '没有借到 Key（没有请求高德）');
});

test('/map/share：别的网站、本站别的页面、不带 Referer 都是 403，页面里没有 Key', async () => {
  const frameOpts = { target: "'*'", attrs: 'referrerpolicy="no-referrer-when-downgrade"' };
  for (const [name, path, stub, referer] of [
    ['别的网站的 /p/… 路径（模拟）', SHARE_PATH, page_(parentHtml('/map/share', frameOpts), { sandbox: false }), 'https://evil.example/p/abcdefghjk'],
    ['本站的 /t/ 页面', '/t/abcdefghjk', page_(parentHtml('/map/share', frameOpts), { sandbox: false })],
    ['本站首页', '/', page_(parentHtml('/map/share', frameOpts), { sandbox: false })],
    ['iframe 明确不发 Referer', SHARE_PATH, page_(parentHtml('/map/share', { target: "'*'", attrs: 'referrerpolicy="no-referrer"' }), { sandbox: false })],
  ]) {
    const P = await openShare(withKey, stub, { path, referer });
    await settle403(P);
    assert.equal(P.seen[0].status, 403, name);
    assert.deepEqual(await P.page.evaluate(() => window.__msgs), [], `${name}：地图页面没有加载`);
    assert.deepEqual(P.guard.jsApi, [], `${name}：没有借到 Key`);
    await P.context.close();
  }
  const direct = await fetch(`${withKey}/map/share`);
  assert.equal(direct.status, 403);
  assert.doesNotMatch(await direct.text(), /amap-js-key/);
});

// 已知问题（主代理要定怎么办，见 docs/v3.16-plan.md 第七节）：Chromium 里 CSP 沙箱页面（来源 null）发出的 iframe 请求不带 Referer，
// referrerpolicy 写 unsafe-url 也一样（本地用 node 小服务器实测过）。所以真的方案页嵌 /map/share，按「没有 Referer 就 403」的规则会被拒。
test('已知问题：真的沙箱页面发出的 iframe 请求没有 Referer，/map/share 返回 403（Chromium）', async () => {
  for (const attrs of ['', 'referrerpolicy="no-referrer-when-downgrade"', 'referrerpolicy="unsafe-url"']) {
    const P = await openShare(withKey, page_(parentHtml('/map/share', { target: "'*'", attrs }), { policy: 'strict-origin' }));
    await settle403(P);
    assert.equal(P.seen[0].referer, null, `iframe ${attrs || '默认'}`);
    assert.equal(P.seen[0].status, 403);
    await P.context.close();
  }
});
