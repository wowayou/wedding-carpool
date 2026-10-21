// SPDX-License-Identifier: AGPL-3.0-or-later
// 端到端测试的公共部分：起服务、起浏览器、拦截高德请求、收集控制台报错、收拾进程和临时目录。
// 运行：npm run e2e（需要本机已有 Playwright 的 Chromium，不会自动下载）。
// 安全约定：
//   - wrangler 用 e2e 专用的 --env-file（假 Key、测试口令），不会读仓库根目录的 .dev.vars 里的真 Key；
//   - ui.py 用 --key 传假 Key，并且让它的出站请求走一个不存在的代理，真发出去也到不了高德；
//   - 浏览器里发往高德代理（/api/…/amap…）或任何站外地址的请求，一律拦下并记为违规，测试结束时断言为零。
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FAKE_KEY = '0123456789abcdef0123456789abcdef'; // 假的高德 Key
export const FAKE_JS_KEY = 'fedcba9876543210fedcba9876543210'; // 假的高德 JS API Key（地图页面用）
export const ACCESS_CODE = 'e2e-test-code'; // 测试用站长口令
export const SLOW = 90_000; // Pyodide 第一次加载要十几秒，给够

// ---------- 临时目录和子进程：登记在案，退出和失败时都能收拾 ----------
const tmpDirs = [];
const procs = []; // { child, name, log }

export function makeTmp(prefix = 'carpool-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ok(port)); });
  });
}

// 某进程的所有后代（wrangler 会再起 workerd），按进程号查，不按名字杀
function descendants(pid) {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n');
  const kids = new Map();
  for (const line of out) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const all = [], stack = [pid];
  while (stack.length) for (const k of kids.get(stack.pop()) || []) { all.push(k); stack.push(k); }
  return all;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function killTree(pid) {
  const pids = [...descendants(pid).reverse(), pid]; // 先杀子孙，再杀自己
  for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* 已经退出 */ } }
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const p of pids) if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* 已经退出 */ } }
}

export async function cleanup() {
  while (procs.length) {
    const { child } = procs.pop();
    if (child.pid) await killTree(child.pid);
  }
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
}
// 测试进程被打断时也收拾（Ctrl+C、被杀）
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => cleanup().finally(() => process.exit(1)));

function start(name, cmd, args, opts) {
  const log = { text: '' };
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { log.text = (log.text + d).slice(-20000); });
  child.on('exit', (code) => { log.exited = code ?? 'signal'; });
  procs.push({ child, name, log });
  return { child, log };
}

async function waitHttp(url, log, what, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (log.exited !== undefined) throw new Error(`${what} 提前退出：\n${log.text}`);
    try { if ((await fetch(url)).ok) return; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} 启动超时：\n${log.text}`);
}

// 子进程的环境：去掉可能带真 Key 的变量，本机回环地址不走代理
function cleanEnv(extra = {}) {
  const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NO_COLOR: '1', ...extra };
  for (const k of ['AMAP_KEY', 'AMAP_JS_KEY', 'ACCESS_CODE', 'IP_SALT']) delete env[k];
  return env;
}

// ---------- 在线和试玩：wrangler dev ----------
let built = false;
export function ensureBuilt() {
  if (built) return;
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`npm run build 失败：\n${build.stdout}\n${build.stderr}`);
  built = true;
}

// jsKey：地图页面（/map）用的高德 JS API Key（假的）；传 null 表示不设，地图页面走不带底图的画法
export async function startWrangler({ jsKey = null } = {}) {
  ensureBuilt();
  const dir = makeTmp();
  const envFile = join(dir, 'e2e.env');
  writeFileSync(envFile, `AMAP_KEY=${FAKE_KEY}\nACCESS_CODE=${ACCESS_CODE}\n${jsKey ? `AMAP_JS_KEY=${jsKey}\n` : ''}`);
  const port = await freePort(), inspector = await freePort();
  const { log } = start('wrangler', process.execPath, [
    join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
    '--port', String(port), '--inspector-port', String(inspector), '--ip', '127.0.0.1',
    '--env-file', envFile, '--persist-to', join(dir, 'state'),
  ], {
    cwd: ROOT, detached: true,
    env: cleanEnv({ WRANGLER_LOG_PATH: join(dir, 'logs'), WRANGLER_SEND_METRICS: 'false', CI: '1' }),
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(`${base}/api/env`, log, 'wrangler dev');
  // 守卫：必须是 e2e 的环境变量文件生效；一旦看到读了 .dev.vars 就立刻失败（里面可能是真 Key）
  if (/\.dev\.vars/.test(log.text) || !log.text.includes(envFile.replace(/^.*\//, ''))) {
    throw new Error(`wrangler 没有只用 e2e 的环境变量文件，拒绝继续：\n${log.text}`);
  }
  return { base, dir };
}

// ---------- 本地：ui.py ----------
export async function startLocal() {
  ensureBuilt(); // 本地版的页面从 CDN 取 Leaflet 和 marked，测试里用 dist/vendor/ 里校验过的同一份文件代替（见 newGuardedPage）
  const dir = makeTmp();
  const config = join(dir, 'trip.toml');
  // 配置：试玩示例行程的 config，用 carpool.dump_toml 写成 toml
  const conv = spawnSync('python3', ['-I', '-c', [
    'import json,sys', `sys.path.insert(0, ${JSON.stringify(ROOT)})`, 'import carpool',
    `cfg = json.load(open(${JSON.stringify(join(ROOT, 'web/try-trip.json'))}, encoding="utf-8"))["config"]`,
    'cfg.setdefault("options", {}).update(travel_date="2030-10-12", travel_time="08:00")',
    'cfg["return"]["date"] = "2030-10-13"',
    `open(${JSON.stringify(config)}, "w", encoding="utf-8").write(carpool.dump_toml(cfg, "# e2e 临时配置\\n"))`,
  ].join('\n')], { encoding: 'utf8' });
  if (conv.status !== 0) throw new Error(`生成临时 toml 失败：${conv.stderr}`);
  const original = readFileSync(config, 'utf8');
  const port = await freePort();
  const { log } = start('ui.py', 'python3', [join(ROOT, 'ui.py'), config, '--port', String(port), '--key', FAKE_KEY], {
    cwd: dir, detached: true,
    // 假 Key 真要出站也到不了高德：出站请求走一个没人听的代理，立刻连接失败
    env: cleanEnv({ HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', PYTHONDONTWRITEBYTECODE: '1' }),
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(`${base}/api/env`, log, 'ui.py');
  return { base, dir, config, original };
}

// ---------- 浏览器 ----------
let browser = null;
export async function launchBrowser() {
  browser ??= await chromium.launch({ args: ['--force-color-profile=srgb', '--disable-lcd-text', '--disable-gpu', '--disable-gpu-rasterization', '--num-raster-threads=1', '--disable-partial-raster', '--disable-skia-runtime-opts', '--disable-features=LocalNetworkAccessChecks'] });
  return browser;
}
export async function closeBrowser() { await browser?.close().catch(() => {}); browser = null; }

// 1x1 透明 PNG：地图瓦片一律用它，不连网、截图稳定
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const CDN_FILES = {
  'leaflet/1.9.4/leaflet.min.js': 'leaflet/leaflet.js', 'leaflet/1.9.4/leaflet.min.css': 'leaflet/leaflet.css',
  'marked/12.0.2/marked.min.js': 'marked/marked.min.js',
  ...Object.fromEntries(['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png'].map((f) => [`leaflet/1.9.4/images/${f}`, `leaflet/images/${f}`])),
};

// 假的高德返回：按路径给够一次「计算方案」用的数据（测距、驾车路线），别的接口给空结果。一律不连真高德
function fakeAmapBody(u) {
  const q = u.searchParams, ok = { status: '1', info: 'OK', infocode: '10000' };
  const pt = (s) => s.split(',').map(Number);
  switch (u.pathname) {
    case '/v3/distance':
      return { ...ok, results: q.get('origins').split('|').map((_, i) => ({ origin_id: String(i + 1), dest_id: '1', distance: '60000', duration: '3600' })) };
    case '/v3/direction/driving': {
      const pts = [q.get('origin'), ...(q.get('waypoints') ? q.get('waypoints').split(';') : []), q.get('destination')].map(pt);
      const line = pts.flatMap((a, i) => i ? [0.25, 0.5, 0.75, 1].map((k) => `${(pts[i - 1][0] + (a[0] - pts[i - 1][0]) * k).toFixed(6)},${(pts[i - 1][1] + (a[1] - pts[i - 1][1]) * k).toFixed(6)}`) : [`${a[0]},${a[1]}`]);
      return { ...ok, route: { paths: [{ distance: '60000', duration: '3600', steps: [{ polyline: line.join(';') }] }] } };
    }
    case '/v3/geocode/geo':
      return { ...ok, geocodes: [{ location: '116.397428,39.90923', formatted_address: '北京市', level: '市', citycode: '010', city: '北京市', province: '北京市' }] };
    case '/v3/geocode/regeo':
      return { ...ok, regeocode: { addressComponent: { citycode: '010' } } };
    case '/v3/direction/transit/integrated':
      return { ...ok, route: { transits: [] } };
    default:
      return { ...ok, pois: [], count: '0' };
  }
}

// 新开一个带守卫的页面。返回 { page, context, guard }
//   guard.amapHits：发往高德代理的请求（正常应为空）；guard.external：站外请求（正常应为空）
//   guard.errors：控制台报错和页面异常
//   guard.fakeAmapError：设为 true 时，高德代理请求不放行，直接回一个假的错误，并记在 guard.fakedAmap 里（不算违规）
//   fakeDirectAmap：传 true 时，允许并伪造发往 https://restapi.amap.com 的请求（自己的高德 Key 模式，浏览器直连），
//     每个请求记在 guard.directAmap 里（{ path, key, url }），不算违规；默认（不传）仍把它们当违规
//   fakeJsApi：传 true 时，https://webapi.amap.com/maps?… 换成 web/e2e/fake-amap.js 的替身（高德 JS API），其余 *.amap.com 的请求返回空，
//     都记在 guard.jsApi 里，不算违规；默认（不传）仍把它们当违规。传 'fail' 时脚本请求直接失败（模拟 JS API 加载不出来）
//   stubs：{ '/路径': { body, contentType?, status?, headers? } }，本站这些路径直接用给定内容回答（测试专用的页面，不进正式构建）
export async function newGuardedPage(base, { viewport = { width: 1280, height: 800 }, colorScheme = 'light', fakeDirectAmap = false, fakeJsApi = false, stubs = {}, ...rest } = {}) {
  const b = await launchBrowser();
  const context = await b.newContext({ viewport, colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block', ...rest });
  const guard = { amapHits: [], fakedAmap: [], directAmap: [], jsApi: [], external: [], errors: [], fakeAmapError: false, allowErrors: [] };
  // allowErrors：这一页上预期会有的浏览器报错（比如管理页登录前的 401），写正则；其余控制台报错一律算失败
  const origin = new URL(base).origin;
  const isAmap = (u) => /\/amap(-batch)?([/?]|$)/.test(u.pathname) || u.pathname === '/api/amap' || /(^|\.)amap\.com$/.test(u.hostname);
  await context.route('**/*', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.hostname === 'cdnjs.cloudflare.com') { // 本地版页面直接引用 CDN：用构建时校验过的同一份文件顶替，不连外网
      const rel = CDN_FILES[u.pathname.replace(/^\/ajax\/libs\//, '')];
      if (rel) return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.png') ? 'image/png' : 'text/javascript', body: readFileSync(join(ROOT, 'dist/vendor', rel)) });
    }
    if (/\.is\.autonavi\.com$/.test(u.hostname)) return route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE });
    if (fakeDirectAmap && u.origin === 'https://restapi.amap.com') {
      guard.directAmap.push({ path: u.pathname, key: u.searchParams.get('key'), url: u.href });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(fakeAmapBody(u)) });
    }
    if (fakeJsApi && u.protocol === 'https:' && /(^|\.)amap\.com$/.test(u.hostname) && !/^\/api\//.test(u.pathname)) {
      guard.jsApi.push(u.href);
      if (u.hostname === 'webapi.amap.com' && u.pathname === '/maps') {
        if (fakeJsApi === 'fail') return route.abort('failed');
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(ROOT, 'web/e2e/fake-amap.js')) });
      }
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{}' });
    }
    if (isAmap(u)) {
      if (guard.fakeAmapError) {
        guard.fakedAmap.push(`${req.method()} ${u.pathname}`);
        return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '测试用的假错误：e2e 不调用高德' }) });
      }
      guard.amapHits.push(`${req.method()} ${u.href}`);
      return route.abort('blockedbyclient');
    }
    if (u.origin === origin && stubs[u.pathname]) {
      const { body, contentType = 'text/html; charset=utf-8', status = 200, headers = {} } = stubs[u.pathname];
      return route.fulfill({ status, contentType, headers, body });
    }
    if (u.origin !== origin) { guard.external.push(u.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !guard.allowErrors.some((re) => re.test(`${m.text()} ${m.location().url}`))) guard.errors.push(`console.error: ${m.text()} (${m.location().url})`); });
  page.on('pageerror', (e) => { if (!guard.allowErrors.some((re) => re.test(e.message))) guard.errors.push(`pageerror: ${e.message}`); });
  guard.assertClean = () => {
    const bad = { 高德请求: guard.amapHits, 站外请求: guard.external, 控制台报错: guard.errors };
    for (const [what, list] of Object.entries(bad)) if (list.length) throw new Error(`${what}：\n${list.join('\n')}`);
  };
  guard.reset = () => { guard.errors.length = 0; guard.fakedAmap.length = 0; };
  return { page, context, guard };
}

// ---------- 页面上的常用动作 ----------
export const bind = (page, path) => page.locator(`#form [data-bind="${path}"]`);

// 编辑页加载完：表单画出来了（试玩和在线都等到 #form 里有目的地名称输入框）
export async function waitFormReady(page) {
  await bind(page, 'venue.name').waitFor({ timeout: 30_000 });
}

// 等 Leaflet 地图建好
export async function waitMapReady(page) {
  await page.locator('#map .leaflet-pane').first().waitFor({ state: 'attached', timeout: 30_000 });
}

// 设置抽屉：打开「推荐车站」
export async function openSuggest(page) {
  await page.locator('[data-suggest]').click();
  await page.locator('#drawer:not([hidden]) #sgRoot').waitFor();
}

// 目录辅助：截图脚本也用
export function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir; }
export { cpSync, existsSync, readFileSync };
