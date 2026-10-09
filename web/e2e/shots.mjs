// SPDX-License-Identifier: AGPL-3.0-or-later
// 给三种模式的主要状态截图，用来做改前改后的逐像素对比（不属于 npm run e2e）。
// 用法：node web/e2e/shots.mjs <输出目录> [试玩|本地|在线 ...]
// 固定的东西：视口（桌面 1280×800，手机 390×844）、主题（浅色/深色）、数据（试玩示例行程和 e2e 临时配置）、
// 时钟（Date.now 固定在 2026-10-10 10:00 北京时间）、地图瓦片（统一换成 1×1 的空白图）、动画（全部关掉）；
// 会变的东西（轻提示、在线名单、保留期标签）截图时隐藏；每张图都等到连续两次截图完全一致才保存。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bind, cleanup, closeBrowser, ensureDir, newGuardedPage, openSuggest, ACCESS_CODE, ROOT, startLocal, startWrangler, waitFormReady, waitMapReady } from './lib.mjs';

const outDir = process.argv[2];
if (!outDir) { console.error('用法：node web/e2e/shots.mjs <输出目录> [试玩|本地|在线 ...]'); process.exit(2); }
const only = process.argv.slice(3);
const want = (name) => !only.length || only.includes(name);

const VARIANTS = [
  { id: 'desktop-light', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  { id: 'desktop-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { id: 'mobile-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
];
const FIXED_NOW = new Date('2026-10-10T10:00:00+08:00');
const FREEZE_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  #toasts, #expiryChip, #peers, #progress { visibility: hidden !important; }`;
const index = [];

// 连续 3 次（每次隔 400 毫秒）截图完全一致，才算页面稳定了（地图的移动、重画、字体加载都可能在几百毫秒后才结束）
async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.move(0, 0);
  await page.waitForLoadState('networkidle').catch(() => {});
  let prev = null, same = 0;
  for (let i = 0; i < 40; i++) {
    const buf = await page.screenshot({ animations: 'disabled' });
    const sum = createHash('sha256').update(buf).digest('hex');
    same = sum === prev ? same + 1 : 0;
    if (same >= 2) return buf;
    prev = sum;
    await page.waitForTimeout(400);
  }
  throw new Error('页面一直在变，截不到稳定的图');
}

async function shot(page, mode, variant, state) {
  const buf = await settle(page);
  const name = `${mode}-${state}-${variant.id}.png`;
  writeFileSync(join(outDir, name), buf);
  index.push(`${createHash('sha256').update(buf).digest('hex')}  ${name}`);
  console.log('截图', name);
}

async function open(base, variant, url, { before } = {}) {
  const p = await newGuardedPage(base, { viewport: variant.viewport, colorScheme: variant.colorScheme });
  await p.page.clock.setFixedTime(FIXED_NOW);
  await p.page.addInitScript((css) => {
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
  }, FREEZE_CSS);
  await before?.(p);
  await p.page.goto(url);
  return p;
}

const settled = (page) => page.waitForFunction(() => {
  const est = document.querySelector('#sgEst');
  return est && !/正在估算/.test(est.textContent) && est.textContent.trim() !== '';
}, null, { timeout: 120_000 });

// 校验清单弹窗：清空一个必填项后点「计算方案」
async function problemsShot(p, mode, variant) {
  const depart = bind(p.page, 'return.depart_time');
  await depart.fill('');
  await p.page.locator('#plan').click();
  await p.page.locator('dialog.c-modal[open]').waitFor();
  await shot(p.page, mode, variant, 'problems');
  await p.page.keyboard.press('Escape');
  await p.page.locator('dialog.c-modal[open]').waitFor({ state: 'detached' });
  await depart.fill('20:30');
  await p.page.locator('#form .ed-err').first().waitFor({ state: 'detached' }).catch(() => {});
}

async function suggestShot(p, mode, variant) {
  if (variant.id === 'mobile-light') await p.page.locator('#tabFill').click();
  await openSuggest(p.page);
  await settled(p.page);
  await p.page.locator('#sgToggle').click(); // 展开设置面板，一并截下来
  await shot(p.page, mode, variant, 'suggest');
  await p.page.keyboard.press('Escape');
  await p.page.locator('#drawer').waitFor({ state: 'hidden' });
}

async function tryShots(base) {
  for (const variant of VARIANTS) {
    const p = await open(base, variant, `${base}/try`);
    await waitFormReady(p.page);
    await waitMapReady(p.page);
    await shot(p.page, 'try', variant, 'loaded');
    if (variant.id === 'mobile-light') { await p.page.locator('#tabMap').click(); await shot(p.page, 'try', variant, 'map'); await p.page.locator('#tabFill').click(); }
    await problemsShot(p, 'try', variant);
    await suggestShot(p, 'try', variant);
    await p.page.locator('#plan').click();
    await p.page.locator('#tabs .tab').first().waitFor({ timeout: 90_000 });
    await p.page.locator('#plan:not([disabled])').waitFor();
    await shot(p.page, 'try', variant, 'plan');
    if (variant.id === 'mobile-light') { await p.page.locator('#tabMap').click(); await shot(p.page, 'try', variant, 'plan-map'); }
    await p.context.close();
    p.guard.assertClean();
  }
}

async function localShots() {
  const srv = await startLocal();
  for (const variant of VARIANTS) {
    const p = await open(srv.base, variant, srv.base);
    await waitFormReady(p.page);
    await waitMapReady(p.page);
    await shot(p.page, 'local', variant, 'loaded');
    await problemsShot(p, 'local', variant);
    await suggestShot(p, 'local', variant);
    await p.context.close();
    p.guard.assertClean();
  }
}

async function onlineShots(base) {
  // 管理页登录、发邀请码、新建行程都走接口（不截图）；所有截图共用这一个行程
  const boot = await newGuardedPage(base);
  const req = boot.context.request;
  const ok = async (res) => { if (!res.ok()) throw new Error(`${res.url()} ${res.status()} ${await res.text()}`); return res.json(); };
  await ok(await req.post(`${base}/api/admin/login`, { data: { code: ACCESS_CODE } }));
  const { invite } = await ok(await req.post(`${base}/api/admin/invites`, { data: { note: 'shots', maxTrips: 3, days: 30 } }));
  const trip = await ok(await req.post(`${base}/api/trips`, { data: { code: invite.code, name: 'e2e 行程' } }));
  await boot.context.close();
  const cfg = JSON.parse(readFileSync(join(ROOT, 'web/try-trip.json'), 'utf8')).config;
  cfg.options.travel_date = '2030-10-12';
  cfg.return.date = '2030-10-13';
  let imported = false;
  for (const variant of VARIANTS) {
    const p = await open(base, variant, `${base}${trip.url}`, { before: (q) => q.page.addInitScript(() => localStorage.setItem('carpool_name', JSON.stringify('甲'))) });
    await waitFormReady(p.page);
    if (!imported) { // 第一次进来行程是空的：用界面的「导入配置」放进示例
      await p.page.locator('#menuBtn').click();
      const chooser = p.page.waitForEvent('filechooser');
      await p.page.locator('#drawer:not([hidden]) #importBtn').click();
      await (await chooser).setFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ config: cfg })) });
      await p.page.locator('dialog.c-modal[open] [data-dialog-ok]').click();
      await p.page.locator('#status', { hasText: '已同步' }).waitFor();
      imported = true;
    }
    await bind(p.page, 'venue.name').waitFor();
    await p.page.waitForFunction(() => document.querySelector('#form [data-bind="venue.name"]')?.value === '宏村示例酒店');
    await waitMapReady(p.page);
    await p.page.locator('#status', { hasText: '已同步' }).waitFor();
    await shot(p.page, 'online', variant, 'loaded');
    await problemsShot(p, 'online', variant);
    p.guard.fakeAmapError = true; // 打开推荐车站会自动估算，换成假错误，不出站
    await suggestShot(p, 'online', variant);
    p.guard.fakeAmapError = false;
    await p.context.close();
    p.guard.assertClean();
  }
}

try {
  ensureDir(outDir);
  if (want('试玩') || want('在线')) {
    const { base } = await startWrangler();
    if (want('试玩')) await tryShots(base);
    if (want('在线')) await onlineShots(base);
  }
  if (want('本地')) await localShots();
  writeFileSync(join(outDir, 'SHA256SUMS'), `${index.sort((a, b) => a.split('  ')[1].localeCompare(b.split('  ')[1])).join('\n')}\n`);
  console.log(`共 ${index.length} 张，存到 ${outDir}`);
} finally {
  await closeBrowser();
  await cleanup();
}
