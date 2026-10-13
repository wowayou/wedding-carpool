// SPDX-License-Identifier: AGPL-3.0-or-later
// 在线模式的端到端检查：wrangler dev 里的完整流程（管理页、邀请码、行程、实时同步、冲突、历史）。
// 数据都在临时目录里；AMAP_KEY 是假的，页面发往高德代理的请求一律被拦下并让测试失败，
// 唯一的例外是「推荐车站」自动估算：测试里明确把它换成一个假错误（guard.fakeAmapError），断言页面不卡住。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { ACCESS_CODE, bind, cleanup, closeBrowser, newGuardedPage, openSuggest, ROOT, SLOW, startWrangler, waitFormReady, waitMapReady } from './lib.mjs';

let base, admin, trip, inviteCode, A, B;
const guards = [];

before(async () => {
  ({ base } = await startWrangler());
}, { timeout: 120_000 });
after(async () => { await closeBrowser(); await cleanup(); });
afterEach(() => { for (const g of guards) g.assertClean(); });

async function openPage(opts) {
  const p = await newGuardedPage(base, opts);
  guards.push(p.guard);
  return p;
}

// 取名字遮罩：第一次打开行程要填名字
async function enterName(page, name) {
  await page.locator('#nameBox:not([hidden]) #nameInput').fill(name);
  await page.locator('#nameForm button').click();
  await page.locator('#nameBox').waitFor({ state: 'hidden' });
}

test('在线：用测试口令登录管理页，生成邀请码', async () => {
  admin = await openPage();
  // 管理页登录前请求 stats、输错口令登录，浏览器会在控制台记两条 401，是预期的
  admin.guard.allowErrors.push(/status of 401.*\/api\/admin\/(stats|login)/);
  const { page } = admin;
  await page.goto(`${base}/admin`);
  // 口令错误：提示，不进管理面板
  await page.locator('#code').fill('不对的口令');
  await page.locator('#login button[type=submit], #login button:not([type])').first().click();
  await page.locator('#loginErr', { hasText: '口令不对' }).waitFor();
  assert.equal(await page.locator('#panel').isHidden(), true);
  // 测试口令：登录
  await page.locator('#code').fill(ACCESS_CODE);
  await page.locator('#login button[type=submit], #login button:not([type])').first().click();
  await page.locator('#panel').waitFor({ state: 'visible' });
  // 发一个邀请码
  await page.locator('#note').fill('e2e');
  await page.locator('#create button.c-btn--primary').click();
  const code = page.locator('#invites tr code').first();
  await code.waitFor();
  inviteCode = (await code.innerText()).trim();
  assert.match(inviteCode, /^[a-z2-9]{8}$/);
  assert.match(await page.locator('#invites').innerText(), /e2e/);
  assert.match(await page.locator('#invites').innerText(), /有效/);
});

test('在线：用邀请码新建行程，打开 /t/<行程>#k=…', { timeout: SLOW }, async () => {
  const res = await admin.context.request.post(`${base}/api/trips`, { data: { code: inviteCode, name: 'e2e 行程' } });
  assert.equal(res.ok(), true, await res.text());
  trip = await res.json();
  assert.match(trip.id, /^[a-z2-9]{10}$/);
  assert.equal(trip.url, `/t/${trip.id}#k=${trip.key}`);
  // 邀请码用掉了一个名额
  await admin.page.reload();
  await admin.page.locator('#panel').waitFor({ state: 'visible' });
  assert.match(await admin.page.locator('#invites').innerText(), /1 \/ 3/);

  A = await openPage();
  await A.page.goto(`${base}${trip.url}`);
  await enterName(A.page, '甲');
  await waitFormReady(A.page);
  await waitMapReady(A.page);
  assert.equal(await A.page.evaluate(() => document.body.classList.contains('online')), true);
  assert.equal(await A.page.locator('#title').innerText(), 'e2e 行程');
  await A.page.locator('#status', { hasText: '已同步' }).waitFor();
  assert.equal(await A.page.locator('#historyBtn').isVisible(), true);
  assert.equal(await A.page.locator('#save').isHidden(), true, '在线版自动同步，没有保存键');
  // 编辑链接里的 #k 之后不丢：刷新还能进（会话在 cookie 里，链接记在本机）
  await A.page.reload();
  await waitFormReady(A.page);
});

test('在线：导入示例配置，第二个页面（同一行程）实时收到', { timeout: SLOW }, async () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'web/try-trip.json'), 'utf8')).config;
  cfg.options.travel_date = '2030-10-12';
  cfg.return.date = '2030-10-13';
  await A.page.locator('#menuBtn').click();
  await A.page.locator('#drawer:not([hidden]) #importBtn').waitFor();
  const chooser = A.page.waitForEvent('filechooser');
  await A.page.locator('#importBtn').click();
  await (await chooser).setFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ config: cfg })) });
  await A.page.locator('dialog.c-modal[open] [data-dialog-ok]').click();
  await A.page.locator('#toasts .c-toast', { hasText: '已导入' }).waitFor();
  await A.page.locator('#status', { hasText: '已同步' }).waitFor();
  assert.equal(await bind(A.page, 'venue.name').inputValue(), '宏村示例酒店');

  B = await openPage();
  await B.page.goto(`${base}${trip.url}`);
  await enterName(B.page, '乙');
  await waitFormReady(B.page);
  assert.equal(await bind(B.page, 'venue.name').inputValue(), '宏村示例酒店');
  // 在线名单：两个人互相看得到
  await A.page.locator('#peers', { hasText: '乙' }).waitFor();
  await B.page.locator('#peers', { hasText: '甲' }).waitFor();
});

test('在线：改字段、自动保存，对方实时收到', async () => {
  await bind(A.page, 'venue.name').fill('甲改的酒店');
  await A.page.locator('#status', { hasText: '同步中' }).waitFor();
  await A.page.locator('#status', { hasText: '已同步' }).waitFor();
  await B.page.waitForFunction(() => document.querySelector('#form [data-bind="venue.name"]')?.value === '甲改的酒店');
  await B.page.locator('#toasts .c-toast', { hasText: '甲' }).waitFor();
  // 反过来也一样
  await bind(B.page, 'options.max_stops').fill('3');
  await A.page.waitForFunction(() => document.querySelector('#form [data-bind="options.max_stops"]')?.value === '3');
});

test('在线：两边同时改同一格，出现冲突提示', async () => {
  const field = 'options.max_detour_min';
  // 让甲的保存请求停在路上，乙先存成功
  // （甲的保存会被服务器以 409 退回再合并，浏览器会在控制台记一条 409，是预期的）
  A.guard.allowErrors.push(/status of 409.*\/api\/t\/[a-z2-9]+\/config/);
  let release, holding = true, held = 0;
  const gate = new Promise((r) => { release = r; });
  await A.page.route('**/api/t/*/config', async (route) => {
    if (route.request().method() !== 'POST' || !holding) return route.fallback();
    held += 1;
    await gate;
    return route.fallback();
  });
  await bind(A.page, field).fill('41');
  while (!held) await new Promise((r) => setTimeout(r, 50)); // 等甲的保存请求发出并被拦住
  await bind(B.page, field).fill('42');
  await B.page.locator('#status', { hasText: '已同步' }).waitFor();
  // 乙的改动推到甲：甲有没存的改动，合并时同一格对不上，弹出冲突提示
  const conflict = A.page.locator('#conflicts .conflict');
  await conflict.first().waitFor();
  const text = await conflict.first().innerText();
  assert.match(text, /你和 乙 同时改了/);
  assert.match(text, /41/);
  assert.match(text, /42/);
  holding = false;
  // 放行后：甲的保存先被 409 退回，合并后再存一次，这次成功
  const saved = A.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/t\/[a-z2-9]+\/config$/.test(r.url()) && r.status() === 200);
  release();
  await saved;
  // 合并后重存成功：不用再动，状态栏也要从「同步中…」回到「已同步」（3.10 前会一直停在「同步中…」）
  await A.page.locator('#status', { hasText: '已同步' }).waitFor({ timeout: 5000 });
  // 一键改用对方的
  await conflict.first().locator('[data-use-theirs]').click();
  await A.page.waitForFunction((p) => document.querySelector(`#form [data-bind="${p}"]`)?.value === '42', field);
  await A.page.locator('#status', { hasText: '已同步' }).waitFor();
  await conflict.first().waitFor({ state: 'detached' });
  await B.page.waitForFunction((p) => document.querySelector(`#form [data-bind="${p}"]`)?.value === '42', field);
});

test('在线：历史版本抽屉能打开，看得到刚才的版本', async () => {
  await A.page.locator('#historyBtn').click();
  await A.page.locator('#drawer:not([hidden])').waitFor();
  assert.equal(await A.page.locator('#drawerTitle').innerText(), '历史版本');
  const items = A.page.locator('#drawer .hist');
  await items.first().waitFor();
  assert.ok(await items.count() >= 2);
  const all = await A.page.locator('#drawerBody').innerText();
  assert.match(all, /版本 \d+ · .+/);
  assert.match(all, /甲/);
  assert.match(all, /乙/);
  assert.match(all, /当前/);
  // 看一个旧版本和现在的差别（不恢复）
  const preview = A.page.locator('#drawer [data-preview]').first();
  await preview.click();
  await A.page.locator('#drawer .diff', { hasText: '恢复后会' }).waitFor();
  await A.page.keyboard.press('Escape');
  await A.page.locator('#drawer').waitFor({ state: 'hidden' });
});

test('在线：推荐车站的设置面板；估算请求被换成假错误后页面正常收场、不卡住', { timeout: SLOW }, async () => {
  // 打开抽屉会自动估算，估算要查车主路线（走高德代理）：在测试里拦下，回一个假错误，并记在 fakedAmap 里
  A.guard.fakeAmapError = true;
  await openSuggest(A.page);
  assert.match(await A.page.locator('#sgSummary').innerText(), /目的地周边/);
  assert.equal(await A.page.locator('#sgToggle').getAttribute('aria-expanded'), 'false');
  await A.page.waitForFunction(() => {
    const est = document.querySelector('#sgEst');
    return est && !/正在估算/.test(est.textContent) && est.textContent.trim() !== '';
  }, null, { timeout: SLOW });
  // 假错误回来后，页面要么写明「估算没成功：原因」加「重试估算」，要么照常给估算（路线查不到的车主被跳过）；都不能卡在「正在估算」
  const est = await A.page.locator('#sgEst').innerText();
  if (/估算没成功/.test(est)) await A.page.locator('#sgEst [data-sg-retry-est]').waitFor();
  else assert.match(est, /这次大约要 .+ 次地点搜索/);
  assert.ok(A.guard.fakedAmap.length >= 1, '估算请求确实被拦下、没有出站');
  assert.equal(await A.page.locator('#sgGo').isDisabled(), false, '估算没成功或跳过时，「开始找」仍可点（测试不点它）');
  // 设置面板：展开、改一项、恢复默认
  await A.page.locator('#sgToggle').click();
  assert.equal(await A.page.locator('#sgToggle').getAttribute('aria-expanded'), 'true');
  const radius = A.page.locator('#sgPanel [data-sg="dest_radius_km"]');
  await radius.fill('60');
  await A.page.locator('#sgSummary .c-tag--accent', { hasText: '改了 1 项' }).waitFor();
  await A.page.locator('#sgPanel [data-sg-reset]').click();
  await A.page.locator('#sgSummary .c-tag--accent').waitFor({ state: 'detached' });
  await A.page.keyboard.press('Escape');
  await A.page.locator('#drawer').waitFor({ state: 'hidden' });
  A.guard.fakeAmapError = false;
  assert.equal(await A.page.locator('#progress').isHidden(), true);
  assert.deepEqual(A.guard.amapHits, [], '没有真正发往高德代理的请求');
});

test('在线：新建第二个行程，从第一个行程导入成员（不带车次）；粘贴高德链接直接定位，不调用高德；日期下面写开售日', { timeout: SLOW }, async () => {
  const res = await admin.context.request.post(`${base}/api/trips`, { data: { code: inviteCode, name: 'e2e 第二个行程' } });
  assert.equal(res.ok(), true, await res.text());
  const second = await res.json();
  const { page } = A;
  await page.goto(`${base}${second.url}`);
  if (await page.locator('#nameBox').isVisible()) await enterName(page, '甲');
  await waitFormReady(page);
  assert.equal(await page.locator('#title').innerText(), 'e2e 第二个行程');
  // 从第一个行程导入成员：这台设备打开过它，列在抽屉里
  await page.locator('#form [data-import-people]').click();
  await page.locator('#drawer:not([hidden])').waitFor();
  assert.equal(await page.locator('#drawerTitle').innerText(), '从别的行程导入成员');
  await page.locator(`#drawer [data-ip-trip="${trip.id}"]`).click();
  const picks = page.locator('#drawer [data-ip-pick]');
  await picks.first().waitFor();
  const n = await picks.count();
  assert.ok(n >= 4, `第一个行程的成员都列出来了（${n} 位）`);
  await page.locator('#drawer [data-ip-go]').click();
  await page.locator('#toasts .c-toast', { hasText: `导入了 ${n} 位成员` }).waitFor();
  assert.equal(await page.locator('#form [data-bind$=".name"][data-bind^="people."]').count(), n);
  assert.equal(await page.locator('#form [data-train]').count(), 0, '这个行程还没有候选站，车次不带过来');
  await page.locator('#status', { hasText: '已同步' }).waitFor();
  // 粘贴方案页里「在高德里看目的地」的链接：直接给一个候选，点了就定位
  await bind(page, 'venue.address').fill('https://uri.amap.com/marker?position=119.815696,32.928919&name=%E5%90%9B%E5%92%8C%E5%AE%B4%E4%BC%9A%E4%B8%AD%E5%BF%83&src=wedding-carpool');
  await page.locator('#form [data-search="venue"]').click();
  const cand = page.locator('#form [data-cands="venue"] [data-pick]');
  await cand.waitFor();
  assert.match(await cand.innerText(), /君和宴会中心[\s\S]*分享的位置/);
  await cand.click();
  await page.locator('#sec-venue .loc', { hasText: '已定位 119.815696,32.928919' }).waitFor();
  assert.equal(await bind(page, 'venue.name').inputValue(), '君和宴会中心');
  assert.equal(await bind(page, 'venue.address').inputValue(), '君和宴会中心', '地址框里的链接换成认出来的名称');
  // 粘贴高德 App 分享的链接（带分享追踪参数）：粘贴时就认出来，框里只留名称和地址，链接不进配置
  await page.locator('#sec-venue [data-clearloc="venue"]').click();
  await bind(page, 'venue.address').fill('');
  await bind(page, 'venue.address').evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, '君和宴会中心\nhttps://m.amap.com/poi/detail?__p=B0M21XZAFD%2C32.73760556252852%2C120.13335898518561%2C%E5%90%9B%E5%92%8C%E5%AE%B4%E4%BC%9A%E4%B8%AD%E5%BF%83%2C%E6%88%B4%E5%8D%97%E9%95%87%E8%BF%8E%E5%AE%BE%E5%A4%A7%E9%81%9313%E5%8F%B7%E6%88%B4%E5%8D%97%E4%B8%8D%E9%94%88%E9%92%A2%E4%BA%A4%E6%98%93%E5%9F%8E&src=app_share&userRelationToken=dummytoken0000&share_type=url&poiid=B0M21XZAFD');
  assert.equal(await bind(page, 'venue.address').inputValue(), '君和宴会中心 戴南镇迎宾大道13号戴南不锈钢交易城');
  await cand.waitFor();
  assert.match(await cand.innerText(), /君和宴会中心[\s\S]*戴南镇迎宾大道13号[\s\S]*120\.133359,32\.737606/);
  await cand.click();
  await page.locator('#sec-venue .loc', { hasText: '已定位 120.133359,32.737606' }).waitFor();
  await page.locator('#status', { hasText: '已同步' }).waitFor();
  const saved = await page.evaluate(async () => (await fetch(location.pathname.replace('/t/', '/api/t/') + '/config')).text());
  assert.doesNotMatch(saved, /userRelationToken|amap\.com/, '分享链接和追踪参数没有存进行程');
  // 出发日期在 2027 年春运期间：写开售日，并提醒开售当天买
  await bind(page, 'options.travel_date').fill('2027-02-13');
  await bind(page, 'options.travel_time').click(); // 失焦触发 change
  const hint = page.locator('#form [data-sale="options.travel_date"]');
  await hint.waitFor({ state: 'visible' });
  assert.match(await hint.innerText(), /火车票 1月30日（周六）开售.*春运期间/);
  assert.deepEqual(A.guard.amapHits, [], '导入和粘贴定位都没有调用高德');
});
