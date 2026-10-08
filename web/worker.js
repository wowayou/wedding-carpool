// SPDX-License-Identifier: AGPL-3.0-or-later
// 拼车出行规划的 Cloudflare Worker：多个行程、编辑链接鉴权、实时同步与历史版本、高德接口代理、方案页。
// 计算在浏览器里跑（Pyodide，见 web/pyworker.js），这里只做转发、计数和存储。
//
// 绑定：ROOM（Durable Object，每个行程一个实例）、USAGE（Durable Object，全站计数）、
//       DATA（KV：方案页、高德配额标记）、ASSETS（静态文件 dist/）
// 密钥：AMAP_KEY（站长的高德 Key）、ACCESS_CODE（站长口令，只用于登录管理页，不能当邀请码）
// 可选变量：TRIP_DAILY_LIMIT（用站长 Key 的行程每天的高德调用上限）、OWN_TRIP_DAILY_LIMIT（自带 Key 的行程每天上限，
//          只防程序出错时无限调用）、OWNER_DAILY_LIMIT（站长 Key 全站每天上限）、
//          OWNER_MONTHLY_LBS_BUDGET / OWNER_MONTHLY_SEARCH_BUDGET（站长 Key 每月的路线测距类、搜索类预算）

import pkg from '../package.json' with { type: 'json' }; // 版本号：/api/env 返回，页脚和更新记录也用它

// 只放行计算用到的高德接口
const AMAP_PATHS = new Set([
  '/v3/geocode/geo', '/v3/geocode/regeo', '/v5/place/text', '/v5/place/around', '/v5/place/polygon',
  '/v3/distance', '/v3/direction/driving', '/v3/direction/transit/integrated',
]);
const ID_RE = /^[a-z2-9]{10}$/; // 行程 id
const MAX_CONFIG_BYTES = 100 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const HISTORY_LIMIT = 100; // 每个行程保留的历史版本数
const HISTORY_MERGE_MS = 2 * 60 * 1000; // 同一个人 2 分钟内的连续保存合并成一个历史版本
const DEFAULT_TRIP_DAILY_LIMIT = 1500;
const DEFAULT_OWN_TRIP_DAILY_LIMIT = 3000;
const DEFAULT_OWNER_DAILY_LIMIT = 4000;
// 站长 Key 每月预算，按高德的两类分别记；比高德的免费额度留一点余量。高德没有查剩余额度的接口，只能自己计数
const DEFAULT_OWNER_MONTHLY_BUDGET = { lbs: 140000, search: 4500 };
const DAILY_KEEP_DAYS = 35; // 每天的用量只保留这么久（月累计要用到整个自然月）
const DAILY_SHOW_DAYS = 30; // 管理页显示近多少天
// 流量统计（只记按天汇总的次数，不记 IP、完整 URL，不用 Cookie）
const STATS_PREFIX = 'st:'; // 每天一条记录：st:YYYY-MM-DD
const STATS_KEEP_DAYS = 35;
const STATS_SHOW_DAYS = 30;
const STATS_VALUE_CAP = 50; // 来源域名、from 参数、页面路径，每天每类最多记这么多个不同值，其余计入「其他」
const STATS_OTHER = '其他';
// 爬虫按 UA 归类，从上到下第一条命中的算；要增减爬虫改这张表（最后一类「other」兜底，不用动）
const BOT_RULES = [
  ['googlebot', /googlebot|googleother|google-inspectiontool|storebot-google|adsbot-google|apis-google/i],
  ['bingbot', /bingbot|msnbot|bingpreview/i],
  ['baiduspider', /baiduspider/i],
  ['bytespider', /bytespider/i],
  ['gptbot', /gptbot|chatgpt-user|oai-searchbot/i],
  ['claudebot', /claudebot|claude-web|claude-user|claude-searchbot|anthropic-ai/i],
  ['perplexitybot', /perplexitybot|perplexity-user/i],
  ['other', /bot\b|crawl|spider|slurp|scrapy|headlesschrome|python-requests|python-urllib|aiohttp|curl\/|wget\/|go-http-client|java\/|okhttp|libwww|node-fetch|axios|facebookexternalhit|embedly|linkpreview/i],
];
const BOT_NAMES = new Set(BOT_RULES.map(([name]) => name));
// 页面访问只统计这些路径（/guide/*、/for/* 只算存在的页面，见 route）
const PAGE_PATH_RE = /^\/(?:|demo|guide(?:\/[a-z0-9-]+)?|for\/[a-z0-9-]+|privacy|about)$/;
const CREATE_PER_IP_PER_DAY = 10;
// 数据保留期：出行日期后 60 天、最后一次编辑后 180 天，取较晚的那个；到期由行程实例的定时任务删除
const RETAIN_AFTER_TRAVEL_MS = 60 * 86400e3;
const RETAIN_IDLE_MS = 180 * 86400e3;
const SHARE_ATTEMPTS_PER_HOUR = 20; // 方案页访问口令每个方案页每小时最多试 20 次
const EDIT_CODE_TRIES_PER_HOUR = 10; // 编辑口令每个行程每小时最多试错 10 次
const EDIT_CODE_LENGTH = [4, 20];
// 管理页登录：同一 IP 15 分钟内最多试错 5 次，全站每小时最多试错 30 次；会话令牌 24 小时过期
const ADMIN_FAILS_PER_IP = 5, ADMIN_IP_WINDOW_MS = 15 * 60e3;
const ADMIN_FAILS_GLOBAL = 30, ADMIN_GLOBAL_WINDOW_MS = 3600e3;
const ADMIN_SESSION_SECONDS = 86400;
const ADMIN_OPS_LIMIT = 50; // 管理操作记录保留条数
const TRACKED_TRIPS_LIMIT = 200; // 最近用过公共额度的行程，最多记这么多个
const OWNER_RESERVE_RATIO = 0.8; // 公共额度用过八成后，当天还没用过公共额度的行程不再分配，留给已经在算的
const CREATE_PER_DAY = 200;
// 成功结果在 Cloudflare 节点上缓存：地点类变化慢，行车时间和路线跟路况走，缓存短一些
const CACHE_SECONDS = { '/v3/distance': 1200, '/v3/direction/driving': 1200, '/v3/direction/transit/integrated': 3600 };
const BATCH_LIMIT = 40; // 免费套餐单次请求最多 50 个子请求
const AMAP_QPS = 3; // 高德个人 Key 的每秒调用上限按 3 算
const QUOTA_RE = /DAILY_QUERY_OVER_LIMIT|QUOTA_PLAN_RUN_OUT|SERVICE_EXPIRED/;
// 高德按类别分别给配额：搜索类（关键字、周边、多边形搜索）比路线、测距、地理编码少得多，用完了互不影响
const SEARCH_PATHS = new Set(['/v5/place/text', '/v5/place/around', '/v5/place/polygon']);
const quotaClass = (path) => (SEARCH_PATHS.has(path) ? 'search' : 'lbs');
const QPS_RE = /QPS|TOO_FREQUENT/;
const EMPTY_CONFIG = { venue: { name: '' }, options: { max_detour_min: 30, max_stops: 2 }, stations: [], people: [] };

const QUOTA_CLASSES = ['lbs', 'search'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
const DAY_MS = 86400e3;

function nextBeijingMidnight(now = Date.now()) {
  const day = 86400e3, offset = 8 * 3600e3;
  return (Math.floor((now + offset) / day) + 1) * day - offset;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常数时间比较：两边先哈希成等长，再逐字节比（运行时有 timingSafeEqual 就直接用）
async function safeEqual(a, b) {
  const digest = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [x, y] = await Promise.all([digest(String(a)), digest(String(b))]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function randomId(length) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');
}

async function readJson(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '内容太大');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, '请求格式不对'); }
}

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  return cookie.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

const limitOf = (env, name, fallback) => Number(env[name]) || fallback;
const roomOf = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const usageOf = (env) => env.USAGE.get(env.USAGE.idFromName('global'));
// auth：{ key, code }，编辑密钥和编辑口令哈希（来自 Cookie），由 Worker 填写，不能让客户端自己带
// INTERNAL_HEADER 标记「Worker 自己发起的内部请求」：转发客户端请求时会删掉同名请求头，行程实例的内部接口没有它一律拒绝
const INTERNAL_HEADER = 'x-carpool-internal';
const internal = (path, body, auth) => new Request(`https://internal${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { [INTERNAL_HEADER]: '1', ...(auth === undefined ? {} : { 'x-trip-key': auth.key, 'x-trip-code': auth.code || '' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
// 客户端请求能直接转给行程实例的路径（其余内部接口只能由 Worker 自己调用）：方法 + 路径
const FORWARDABLE = [
  ['GET', /^\/config$/], ['POST', /^\/config$/], ['GET', /^\/sync$/],
  ['GET', /^\/history$/], ['GET', /^\/history\/\d+$/], ['POST', /^\/restore$/], ['POST', /^\/rename$/],
];
// 行程实例里只接受内部请求的路径
const ROOM_INTERNAL_ONLY = new Set(['/init', '/auth', '/published', '/share', '/rotate', '/edit-code', '/amap-take', '/set-key', '/delete']);
const TRIP_MODES = new Set(['owner', 'own']);

// ---------- 流量统计：写入 Usage 实例，不拖慢响应 ----------

// 后台写一条统计事件：用 ctx.waitUntil，页面响应不等它；写失败只记日志，不影响页面
function track(env, ctx, event) {
  const job = Promise.resolve().then(() => usageOf(env).fetch(internal('/hit', event))).catch((err) => console.error('统计写入失败', err));
  ctx?.waitUntil?.(job);
}

function botOf(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return 'other'; // 不带 UA 的不是正常浏览器
  return BOT_RULES.find(([, re]) => re.test(ua))?.[0] || null;
}

// 外站来源的域名（不记完整地址）；站内跳转、没有 Referer、解析不了都返回 null
function referrerHost(request, url) {
  try {
    const host = new URL(request.headers.get('referer') || '').hostname.toLowerCase().replace(/^www\./, '');
    const own = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === own || host.endsWith(`.${own}`) || !/^[a-z0-9.-]{1,60}$/.test(host)) return null;
    return host;
  } catch { return null; }
}

// 页面访问：只算 GET 且文件存在（200）的页面；爬虫单独计，不算页面访问；人要求 Accept 含 html
// 来源（Referer 域名、?from=）只在首页记
async function servePage(request, env, url, ctx) {
  const res = await env.ASSETS.fetch(request);
  if (request.method !== 'GET' || res.status !== 200) return res;
  const bot = botOf(request);
  if (bot) {
    track(env, ctx, { kind: 'bot', bot });
  } else if (/html/i.test(request.headers.get('accept') || '')) {
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : '/';
    const event = { kind: 'page', path };
    if (path === '/') {
      const from = (url.searchParams.get('from') || '').toLowerCase();
      if (/^[a-z0-9-]{1,24}$/.test(from)) event.from = from;
      const ref = referrerHost(request, url);
      if (ref) event.ref = ref;
    }
    track(env, ctx, event);
  }
  return res;
}

// ---------- 新建行程 ----------

// 用一次真实调用确认 Key 可用；配额或频率问题不算 Key 无效。返回错误说明，可用时返回空
async function amapKeyProblem(amapKey) {
  if (!/^[0-9a-f]{32}$/i.test(amapKey)) return '高德 Key 应该是 32 位的字母和数字';
  const check = await fetch(`https://restapi.amap.com/v3/geocode/geo?${new URLSearchParams({ address: '北京市', key: amapKey })}`)
    .then((r) => r.json()).catch(() => null);
  if (!check) return '暂时连不上高德，稍后再试';
  const info = String(check.info || '');
  if (String(check.status) !== '1' && !QUOTA_RE.test(info) && !QPS_RE.test(info)) {
    return `这个高德 Key 用不了（${info}）。需要「Web服务」类型的 Key，且不能设置 IP 白名单`;
  }
  return '';
}

const tripNameOf = (body) => String(body.name || '').trim().slice(0, 60) || '未命名行程';

async function createTrip(request, env, ctx) {
  const body = await readJson(request, 4096);
  const name = tripNameOf(body);
  let mode, amapKey = null;
  const code = String(body.code || '').trim();
  if (code) {
    mode = 'owner'; // 邀请码：用站点的公共额度（站长口令只能登录管理页，不能当邀请码）
  } else if (body.amapKey) {
    amapKey = String(body.amapKey).trim();
    const open = await usageOf(env).fetch(internal('/create-check', {})); // 暂停新建时不用再去验 Key
    if (!open.ok) return open;
    const problem = await amapKeyProblem(amapKey);
    if (problem) return json({ error: problem }, 400);
    mode = 'own';
  } else {
    return json({ error: '要么填邀请码，要么填自己的高德 Key' }, 400);
  }
  const ip = await sha256(request.headers.get('cf-connecting-ip') || 'unknown');
  const gate = await usageOf(env).fetch(internal('/create', { ip }));
  if (!gate.ok) return gate;
  const id = randomId(10), key = randomId(24);
  let invite = null, tripLimit = null;
  if (code) {
    // 邀请码：检查有效、未过期、没用满，并占一个名额
    const res = await usageOf(env).fetch(internal('/invite-use', { code, tripId: id }));
    if (!res.ok) { await sleep(800); return res; } // 拖慢猜邀请码
    ({ invite, tripLimit } = await res.json());
  }
  await roomOf(env, id).fetch(internal('/init', { id, name, mode, amapKey, invite, tripLimit, keyHash: await sha256(key) }));
  track(env, ctx, { kind: 'create', source: code ? 'invite' : 'own' });
  return json({ id, key, url: `/t/${id}#k=${key}` });
}

// 站长在管理页用公共额度新建行程：仍算进全站每天新建总数，不受单 IP 限制，也不受「暂停新建」影响
async function adminCreateTrip(request, env, ctx) {
  const name = tripNameOf(await readJson(request, 1024));
  const gate = await usageOf(env).fetch(internal('/create', { ip: null, admin: true }));
  if (!gate.ok) return gate;
  const id = randomId(10), key = randomId(24);
  await roomOf(env, id).fetch(internal('/init', { id, name, mode: 'owner', amapKey: null, invite: null, tripLimit: null, keyHash: await sha256(key) }));
  await usageOf(env).fetch(internal('/admin-log', { op: '用公共额度新建行程', target: id }));
  track(env, ctx, { kind: 'create', source: 'admin' });
  return json({ id, key, url: `/t/${id}#k=${key}` });
}

// ---------- 管理页：站长口令登录，管理邀请码、看用量、应急开关 ----------

const statusCacheKey = (url) => new Request(`${url.origin}/api/status`);

async function adminApi(request, env, url, ctx) {
  const sub = url.pathname.slice('/api/admin'.length);
  if (!env.ACCESS_CODE) return json({ error: '这个站点没有设置站长口令' }, 404);
  const usage = usageOf(env);
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  const cookie = (value, maxAge) => `adm=${value}; Path=/api/admin; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAge}`;
  if (sub === '/login' && request.method === 'POST') {
    const { code = '' } = await readJson(request, 1024);
    const ip = await sha256(request.headers.get('cf-connecting-ip') || 'unknown');
    const gate = await usage.fetch(internal('/admin-gate', { ip }));
    if (!gate.ok) return gate;
    if (!(await safeEqual(code, env.ACCESS_CODE))) {
      await usage.fetch(internal('/admin-fail', { ip }));
      await sleep(800);
      return json({ error: '口令不对' }, 401);
    }
    // 登录成功发随机令牌；服务端只存令牌的哈希和过期时间
    const token = randomId(32);
    await usage.fetch(internal('/admin-login', { hash: await sha256(token), expiresAt: Date.now() + ADMIN_SESSION_SECONDS * 1000 }));
    return json({ ok: true }, 200, { 'set-cookie': cookie(token, ADMIN_SESSION_SECONDS) });
  }
  const token = getCookie(request, 'adm');
  const checked = token ? await usage.fetch(internal('/admin-check', { hash: await sha256(token) })) : null;
  if (!checked?.ok) return json({ error: '需要站长口令' }, 401);
  const post = request.method === 'POST';
  if (sub === '/stats') {
    return usage.fetch(internal('/stats', {
      ownerLimit: limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT), budgets: budgetsOf(env),
    }));
  }
  if (sub === '/logout-all' && post) {
    const res = await usage.fetch(internal('/admin-logout-all', {}));
    return json(await res.json(), 200, { 'set-cookie': cookie('', 0) });
  }
  if (sub === '/trips' && post) return adminCreateTrip(request, env, ctx);
  if (sub === '/invites' && post) return usage.fetch(internal('/invite-create', await readJson(request, 2048)));
  if (sub === '/invites/disable-all' && post) return usage.fetch(internal('/invite-disable-all', {}));
  if (sub === '/flags' && post) {
    const res = await usage.fetch(internal('/flags', await readJson(request, 1024)));
    await globalThis.caches?.default?.delete(statusCacheKey(url)); // 公开状态马上跟着变
    return res;
  }
  const one = sub.match(/^\/invites\/([a-z2-9]{8})$/);
  if (one && post) return usage.fetch(internal('/invite-update', { code: one[1], ...(await readJson(request, 1024)) }));
  const block = sub.match(/^\/trip-block\/([a-z2-9]{10})$/);
  if (block && post) return usage.fetch(internal('/trip-block', { id: block[1], ...(await readJson(request, 1024)) }));
  return json({ error: 'not found' }, 404);
}

const budgetsOf = (env) => ({
  lbs: limitOf(env, 'OWNER_MONTHLY_LBS_BUDGET', DEFAULT_OWNER_MONTHLY_BUDGET.lbs),
  search: limitOf(env, 'OWNER_MONTHLY_SEARCH_BUDGET', DEFAULT_OWNER_MONTHLY_BUDGET.search),
});

// 公开的额度状态：只有粗粒度信息，不含行程、邀请码；在节点上缓存 60 秒，免得每次打开首页都去问全站计数
async function publicStatus(env, url) {
  const cache = globalThis.caches?.default; // 只在 Cloudflare 上有
  const hit = cache && (await cache.match(statusCacheKey(url)));
  if (hit) return hit;
  const res = await usageOf(env).fetch(internal('/public-status', {
    ownerLimit: limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT), budgets: budgetsOf(env),
  }));
  const out = json(await res.json(), 200, { 'cache-control': 'public, max-age=60' });
  if (cache) await cache.put(statusCacheKey(url), out.clone());
  return out;
}

// ---------- 行程内的接口 ----------

const tripCookie = (name, id, value, secure, maxAge = 7776000) => `${name}_${id}=${value}; Path=/api/t/${id}; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;

async function tripApi(request, env, url, id, sub, ctx) {
  const room = roomOf(env, id);
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  if (sub === '/session' && request.method === 'POST') {
    // 用编辑链接里的密钥（设了编辑口令的还要口令）换 Cookie，只对这个行程路径生效（WebSocket 也会带上）
    const { key = '', code = '' } = await readJson(request, 1024);
    const res = await room.fetch(internal('/auth', { code: String(code) }, { key: String(key) }));
    if (!res.ok) { if (res.status !== 404) await sleep(500); return res; } // 拖慢猜密钥和口令（行程已不存在的不用拖）
    const { editCodeHash, ...info } = await res.json();
    const out = json(info, 200, { 'set-cookie': tripCookie('tk', id, key, secure) });
    if (editCodeHash) out.headers.append('set-cookie', tripCookie('tc', id, editCodeHash, secure));
    return out;
  }
  const key = getCookie(request, `tk_${id}`);
  if (!key) return json({ error: '需要用编辑链接打开', status: '0', info: 'UNAUTHORIZED' }, 401);
  const auth = { key, code: getCookie(request, `tc_${id}`) };
  if (request.headers.get('upgrade') === 'websocket' && request.headers.get('origin') !== url.origin) {
    return json({ error: '只接受本站发起的连接' }, 403); // 防止其他网站借用户的 Cookie 建立同步连接
  }
  if (sub === '/amap-batch' || sub.startsWith('/amap/')) return tripAmap(request, env, url, room, auth, sub);
  if (sub === '/page' && request.method === 'POST') return publishPage(request, env, url, room, auth, ctx);
  if (sub === '/share' && request.method === 'POST') return shareSettings(request, env, room, auth);
  if (sub === '/rotate-key' && request.method === 'POST') return rotateKey(request, env, url, room, auth, id);
  if (sub === '/edit-code' && request.method === 'POST') return editCodeSettings(request, room, secure, auth, id);
  if (sub === '/key' && request.method === 'POST') { // 改用自己的高德 Key：公共额度用完时可以接着算
    const amapKey = String((await readJson(request, 1024)).amapKey || '').trim();
    const problem = await amapKeyProblem(amapKey);
    if (problem) return json({ error: problem }, 400);
    return room.fetch(internal('/set-key', { amapKey }, auth));
  }
  if (sub === '/delete' && request.method === 'POST') {
    const res = await room.fetch(internal('/delete', {}, auth));
    if (res.ok) {
      const { shareId } = await res.clone().json();
      if (shareId) await env.DATA.delete(`page:${shareId}`);
    }
    return res;
  }
  // 其余只有白名单里的（配置、同步、历史、恢复、改名）交给行程实例；init、amap-take 这类内部接口不能从外面到达
  if (!FORWARDABLE.some(([method, re]) => method === request.method && re.test(sub))) return json({ error: 'not found' }, 404);
  if (request.method === 'POST' && Number(request.headers.get('content-length') || 0) > MAX_CONFIG_BYTES) {
    return json({ error: '内容太大' }, 413);
  }
  const forward = new Request(`https://internal${sub}${url.search}`, request);
  forward.headers.delete(INTERNAL_HEADER); // 客户端不能冒充内部请求
  forward.headers.set('x-trip-key', auth.key);
  forward.headers.set('x-trip-code', auth.code); // 总是覆盖，不接受客户端自己带的
  return room.fetch(forward);
}

// 方案页存在 KV：键是方案页自己的 id（不是行程 id，可以单独作废），口令哈希放在元数据里，过期时间跟着行程保留期走
const pageOptions = (share) => ({
  metadata: { codeHash: share.codeHash || null },
  expiration: Math.floor((share.deadline + 86400e3) / 1000),
});

async function publishPage(request, env, url, room, auth, ctx) {
  const { html } = await readJson(request, MAX_PAGE_BYTES);
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) return json({ error: '方案页内容不对' }, 400);
  const res = await room.fetch(internal('/published', {}, auth)); // 先鉴权并记下发布时间
  if (!res.ok) return res;
  const share = await res.json();
  await env.DATA.put(`page:${share.shareId}`, html, pageOptions(share));
  track(env, ctx, { kind: 'publish' });
  return json({ share: share.public });
}

async function shareSettings(request, env, room, auth) {
  const body = await readJson(request, 1024);
  const res = await room.fetch(internal('/share', body, auth));
  if (!res.ok) return res;
  const share = await res.json();
  if (share.action === 'stop') {
    await env.DATA.delete(`page:${share.shareId}`);
  } else {
    const from = share.oldShareId || share.shareId;
    const { value, metadata } = await env.DATA.getWithMetadata(`page:${from}`);
    if (value !== null && value !== undefined) {
      await env.DATA.put(`page:${share.shareId}`, value, pageOptions(share));
      if (share.oldShareId) await env.DATA.delete(`page:${share.oldShareId}`);
    } else if (metadata) {
      await env.DATA.delete(`page:${from}`);
    }
  }
  return json({ share: share.public });
}

async function rotateKey(request, env, url, room, auth, id) {
  const { clientId = '' } = await readJson(request, 1024);
  const next = randomId(24);
  const res = await room.fetch(internal('/rotate', { keyHash: await sha256(next), clientId }, auth));
  if (!res.ok) return res;
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return json({ key: next, url: `/t/${id}#k=${next}` }, 200, { 'set-cookie': tripCookie('tk', id, next, secure) }); // 编辑口令不受影响
}

// 设置或清除编辑口令（空字符串表示清除）；发起人拿到新的口令 Cookie，其他在线连接由行程实例断开
async function editCodeSettings(request, room, secure, auth, id) {
  const { code = '', client_id: clientId = '' } = await readJson(request, 1024);
  const res = await room.fetch(internal('/edit-code', { code: String(code), clientId }, auth));
  if (!res.ok) return res;
  const { editCodeHash } = await res.json();
  return json({ editCode: Boolean(editCodeHash) }, 200, {
    'set-cookie': editCodeHash ? tripCookie('tc', id, editCodeHash, secure) : tripCookie('tc', id, '', secure, 0),
  });
}

// Worker 自己生成的简单页面（口令页、方案页 404）：引用 /design.css（构建时由 web/design.css 生成），类名用 c- 前缀。
// design.css 不存在或加载失败时，页面自带的这段最小样式兜底，保证能看；兜底放在 <link> 前面，design.css 的同名规则会覆盖它
const FALLBACK_CSS = `:root{color-scheme:light dark;--bg:#f7f4ee;--surface:#fff;--line:#e5ddd0;--line-strong:#cfc4b3;--ink:#221e1a;--ink-2:#5a5148;--accent:#b4442c;--on-accent:#fff;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--surface:#1f1c19;--line:#35302a;--line-strong:#4a443c;--ink:#efe9e1;--ink-2:#bdb4a8;--accent:#e47a5f;--on-accent:#1a0f0b;--danger:#f87171}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
.wc-box{width:min(420px,88vw)}.c-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:18px;line-height:1.3;margin:0 0 8px}p,li{color:var(--ink-2);font-size:14px}ul{padding-left:1.2em;margin:8px 0 16px}
.c-input{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
.c-btn{display:inline-block;box-sizing:border-box;font:inherit;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);text-decoration:none;cursor:pointer}
.c-btn-block{width:100%;margin-top:12px;text-align:center}.c-field-error{color:var(--danger);min-height:1.4em;margin:6px 0 0;font-size:14px}`;

function simplePage(title, body, status) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>${FALLBACK_CSS}</style><link rel="stylesheet" href="/design.css"></head>
<body><main class="wc-box">${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

// 方案页不存在：可能还没发布、已停止分享、换了新链接，或行程已删除、到期
function sharePageGone() {
  return simplePage('找不到这个方案页', `<div class="c-card"><h1>找不到这个方案页</h1>
<p>可能的原因：</p><ul><li>链接没复制完整，或有错字</li><li>发起人还没有发布方案页</li><li>发起人已经停止分享，或换了新的链接</li><li>行程已经删除或到期，方案页跟着自动删除了</li></ul>
<p>可以问一下发给你链接的人要最新的链接。</p><a class="c-btn c-btn-primary c-btn-block" href="/">回到首页</a></div>`, 404);
}

// 方案页：有访问口令的先要口令；口令对了发一个只对这个方案页路径有效的 Cookie
function codePage(id, message, status) {
  return simplePage('输入访问口令', `<form class="c-card" method="post" action="/p/${id}"><h1>这个出行方案设了访问口令</h1><p>口令由发起人设置，问一下发给你链接的人。</p>
<input class="c-input" name="code" autocomplete="off" autofocus required><div class="c-field-error err">${message}</div><button class="c-btn c-btn-primary c-btn-block">查看方案</button></form>`, status);
}

// 方案页的 HTML 是编辑者的浏览器生成后上传的，不能当作本站的可信代码：放进沙箱（独立的匿名来源），
// 读不到本站的 localStorage（里面有编辑链接）和 Cookie；只放行地图要用的脚本、样式和瓦片，不能发请求、不能提交表单
const SHARE_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation-by-user-activation',
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  'img-src data: https://cdnjs.cloudflare.com https://*.is.autonavi.com https://carpool.eigentime.org', // 最后一个是站点图标
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

async function sharePage(request, env, url, id, ctx) {
  const { value: html, metadata } = await env.DATA.getWithMetadata(`page:${id}`);
  if (html === null || html === undefined) {
    return sharePageGone();
  }
  const codeHash = metadata?.codeHash;
  if (codeHash && request.method === 'POST') {
    const gate = await usageOf(env).fetch(internal('/share-attempt', { id }));
    if (!gate.ok) return codePage(id, '试得太多了，请一小时后再试', 429);
    const form = await request.formData().catch(() => null);
    const code = String(form?.get('code') || '').trim();
    if ((await sha256(`${id}:${code}`)) !== codeHash) {
      await sleep(800);
      return codePage(id, '口令不对', 401);
    }
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return new Response(null, { status: 303, headers: {
      location: `/p/${id}`, 'set-cookie': `pc_${id}=${codeHash}; Path=/p/${id}; HttpOnly;${secure} SameSite=Lax; Max-Age=2592000`,
    } });
  }
  if (codeHash && getCookie(request, `pc_${id}`) !== codeHash) return codePage(id, '', 401);
  if (request.method === 'GET' && !botOf(request)) track(env, ctx, { kind: 'shareView' }); // 方案页被打开
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache', 'x-robots-tag': 'noindex',
      'content-security-policy': SHARE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin',
    },
  });
}

// ---------- 高德代理 ----------

const cacheKeyOf = (origin, path, query) => {
  const params = new URLSearchParams(query);
  params.delete('key');
  return new Request(`${origin}/__amap_cache${path}?${params}`);
};

async function fromCache(origin, path, query) {
  const cache = globalThis.caches?.default; // 只在 Cloudflare 上有；自定义域名下才生效
  const hit = cache && (await cache.match(cacheKeyOf(origin, path, query)));
  return hit ? hit.json() : null;
}

async function fetchAmap(origin, item, apiKey, quotaKey, env) { // quotaKey：这个 Key 这一类接口的配额标记
  const params = new URLSearchParams(item.query);
  params.set('key', apiKey);
  let data;
  try {
    data = JSON.parse(await (await fetch(`https://restapi.amap.com${item.path}?${params}`)).text());
  } catch (err) {
    return { status: '0', info: 'NETWORK_ERROR', error: `连不上高德：${err.message}` };
  }
  if (QUOTA_RE.test(String(data.info || ''))) {
    await env.DATA.put(quotaKey, String(nextBeijingMidnight()));
  } else if (String(data.status) === '1' && globalThis.caches?.default) {
    await caches.default.put(cacheKeyOf(origin, item.path, item.query), new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS[item.path] ?? 7 * 86400}` },
    }));
  }
  return data;
}

// 站长 Key（公共额度）拿不到时的提示；文案都含「额度」，编辑页靠它弹出「改用自己的 Key」
const CLASS_LABEL = { lbs: '路线和测距', search: '地点搜索' };
function ownerLimitError(reason, cls) {
  const own = '改用自己的高德 Key 能马上继续';
  const errors = {
    INVITE_DISABLED: '建这个行程用的邀请码已停用，不能再用站点的公共额度；改用自己的高德 Key 就能继续',
    OWNER_RESERVED: '站点今天的公共额度快用完了，剩下的优先留给已经在算的行程；改用自己的高德 Key 能马上继续，或者明天再来',
    PUBLIC_PAUSED: `站点暂时停用了公共额度；${own}`,
    TRIP_BLOCKED: `这个行程的公共额度被停用了；${own}`,
    MONTHLY_BUDGET: `站点这个月「${CLASS_LABEL[cls]}」的公共额度已用完；${own}，或者下个月再来`,
  };
  const info = errors[reason] ? reason : 'OWNER_DAILY_LIMIT';
  return { status: '0', info, error: errors[reason] || '站点今天共用的高德额度已用完。明天再试，或者改用自己的高德 Key' };
}

async function tripAmap(request, env, url, room, auth, sub) {
  let items;
  const single = sub.startsWith('/amap/');
  if (single) {
    items = [{ path: sub.slice('/amap'.length), query: url.search.slice(1) }];
  } else {
    const { requests } = await readJson(request, 200 * 1024);
    if (!Array.isArray(requests) || requests.length > BATCH_LIMIT) return json({ error: `一次最多 ${BATCH_LIMIT} 个请求` }, 400);
    items = requests.map((r) => ({ path: String(r.path), query: String(r.query || '') }));
  }
  const results = items.map((r) => (AMAP_PATHS.has(r.path) ? null : { status: '0', info: 'PATH_NOT_ALLOWED' }));
  await Promise.all(items.map(async (r, i) => { if (!results[i]) results[i] = await fromCache(url.origin, r.path, r.query); }));
  const misses = results.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);

  // 鉴权，并按行程的每日上限领取调用次数（缓存命中不算）
  const grant = await room.fetch(internal('/amap-take', {
    n: misses.length,
    limit: limitOf(env, 'TRIP_DAILY_LIMIT', DEFAULT_TRIP_DAILY_LIMIT),
    ownLimit: limitOf(env, 'OWN_TRIP_DAILY_LIMIT', DEFAULT_OWN_TRIP_DAILY_LIMIT),
  }, auth));
  if (!grant.ok) return grant;
  const { mode, amapKey, granted: tripGranted, limit: tripLimit, usedBefore, invite, tripId, createdAt } = await grant.json();
  const tripLimitError = { status: '0', info: 'TRIP_DAILY_LIMIT', error: `这个行程今天的高德调用已到上限（${tripLimit} 次），明天再试` };
  const apiKey = mode === 'own' ? amapKey : env.AMAP_KEY;
  const keyHash = (await sha256(apiKey || '')).slice(0, 16);
  const quotaKeyOf = (i) => `amap_quota_until:${keyHash}:${quotaClass(items[i].path)}`; // 按 Key 和接口类别记，互不影响
  const blockedOf = (i) => ({
    status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003',
    error: quotaClass(items[i].path) === 'search'
      ? '高德的地点搜索配额已用完（搜索类配额比路线类少得多），北京时间零点前不再搜索；已经定好位置的地点，计算行车时间不受影响'
      : '高德今日配额已用完，北京时间零点前不再调用',
  });
  const spent = new Set(); // 已经用完配额的类别
  for (const i of misses) {
    const cls = quotaClass(items[i].path);
    if (!spent.has(cls) && Date.now() < (Number(await env.DATA.get(quotaKeyOf(i))) || 0)) spent.add(cls);
  }
  const open = misses.filter((i) => !spent.has(quotaClass(items[i].path)));
  for (const i of misses) if (spent.has(quotaClass(items[i].path))) results[i] = blockedOf(i);
  for (const i of open.slice(tripGranted)) results[i] = tripLimitError;
  let todo = open.slice(0, tripGranted);
  if (mode !== 'own' && todo.length) { // 不是自带 Key 的一律走公共额度的全部护栏（宁可拦错，不能放过）
    // 站长 Key：按类别向全站计数领取（每日总上限、每月预算、应急开关都在那边判断）
    const want = { lbs: 0, search: 0 };
    for (const i of todo) want[quotaClass(items[i].path)] += 1;
    const res = await usageOf(env).fetch(internal('/owner-take', {
      want, limit: limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT), budgets: budgetsOf(env),
      invite, fresh: usedBefore === 0, tripId, createdAt,
    }));
    const { granted: ownerGranted, reasons } = await res.json();
    const given = { lbs: 0, search: 0 };
    todo = todo.filter((i) => {
      const cls = quotaClass(items[i].path);
      if (given[cls] < ownerGranted[cls]) { given[cls] += 1; return true; }
      results[i] = ownerLimitError(reasons[cls], cls);
      return false;
    });
  }
  // 没命中缓存的按每秒 AMAP_QPS 个发；被限流的等一会儿再试一次
  for (const round of [0, 1]) {
    if (round) {
      todo = todo.filter((i) => QPS_RE.test(String(results[i].info || '')) && !spent.has(quotaClass(items[i].path)));
      if (todo.length) await sleep(1000);
    }
    const queue = [...todo];
    while (queue.length) {
      const started = Date.now();
      const wave = queue.splice(0, AMAP_QPS);
      const out = await Promise.all(wave.map((i) => fetchAmap(url.origin, items[i], apiKey, quotaKeyOf(i), env)));
      wave.forEach((i, j) => {
        results[i] = out[j];
        if (QUOTA_RE.test(String(out[j].info || ''))) spent.add(quotaClass(items[i].path));
      });
      for (let q = queue.length - 1; q >= 0; q--) { // 配额用完：同一类的剩下的不再请求
        const i = queue[q];
        if (spent.has(quotaClass(items[i].path))) { results[i] = blockedOf(i); queue.splice(q, 1); }
      }
      if (queue.length) await sleep(Math.max(0, 1000 - (Date.now() - started)));
    }
  }
  if (!single) return json({ results });
  const [data] = results;
  return json(data, data.info === 'PATH_NOT_ALLOWED' ? 403 : data.info === 'NETWORK_ERROR' ? 502 : 200);
}

// ---------- 每个行程一个实例：配置、版本、历史、在线名单 ----------

export class ConfigRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 客户端心跳由运行时直接回复，不唤醒实例
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  get storage() { return this.ctx.storage; }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (ROOM_INTERNAL_ONLY.has(path) && request.headers.get(INTERNAL_HEADER) !== '1') return json({ error: 'not found' }, 404);
    if (path === '/init') return this.init(await request.json());
    const meta = await this.storage.get('meta');
    if (!meta) { // 行程已删除或到期：和「密钥不对」分开，让编辑页能提示。行程 id 是 10 位随机串，说出「存在与否」不会帮人猜到什么
      return json({ error: '这个行程已经删除或到期', status: '0', info: 'TRIP_GONE' }, 404);
    }
    if (meta.keyHash !== (await sha256(request.headers.get('x-trip-key') || ''))) {
      return json({ error: '编辑链接无效或已失效', status: '0', info: 'UNAUTHORIZED' }, 401);
    }
    if (path !== '/auth' && meta.editCodeHash && request.headers.get('x-trip-code') !== meta.editCodeHash) {
      // 设了编辑口令：Cookie 里的口令哈希也要对（包括实时同步连接）
      return json({ error: '需要输入编辑口令', status: '0', info: 'EDIT_CODE_REQUIRED' }, 401);
    }
    if (!meta.shareId && meta.pageAt) { // v3 之前发布过的行程：方案页沿用 /p/<行程 id>，重新发布时更新的还是大家手里的那个链接
      meta.shareId = meta.id;
      await this.storage.put('meta', meta);
    }
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;
    if (path === '/auth') return this.auth(meta, body);
    if (path === '/sync') return this.connect(request);
    if (path === '/config' && request.method === 'GET') return this.read(meta);
    if (path === '/config') return this.save(body);
    if (path === '/history') return json({ history: [...((await this.storage.get('hindex')) || [])].reverse() });
    const version = path.match(/^\/history\/(\d+)$/)?.[1];
    if (version) {
      const config = await this.storage.get(`h:${version}`);
      return config ? json({ version: Number(version), config }) : json({ error: '这个版本已经不在历史里了' }, 404);
    }
    if (path === '/restore') return this.restore(body);
    if (path === '/rename') return this.rename(meta, body);
    if (path === '/published') {
      meta.shareId ||= randomId(10);
      meta.pageAt = Date.now();
      await this.storage.put('meta', meta);
      return this.shareReply(meta, {});
    }
    if (path === '/share') {
      meta.shareId ||= randomId(10);
      const extra = { action: body.action };
      if (body.action === 'code') meta.shareCode = String(body.code || '').trim().slice(0, 20) || null;
      if (body.action === 'stop') meta.pageAt = null;
      if (body.action === 'new-link') { extra.oldShareId = meta.shareId; meta.shareId = randomId(10); }
      await this.storage.put('meta', meta);
      return this.shareReply(meta, extra);
    }
    if (path === '/rotate') {
      // 换编辑密钥：旧链接和旧 Cookie 立即失效；除发起人外，已连着的实时连接都断开
      meta.keyHash = body.keyHash;
      await this.storage.put('meta', meta);
      this.kickOthers(body.clientId, 4001, 'key rotated');
      return json({ ok: true });
    }
    if (path === '/edit-code') return this.setEditCode(meta, body);
    if (path === '/amap-take') return this.take(meta, body);
    if (path === '/set-key') {
      Object.assign(meta, { mode: 'own', amapKey: body.amapKey });
      await this.storage.put('meta', meta);
      await this.storage.delete('usage'); // 之前的用量算在站长 Key 上，换 Key 后重新计
      this.broadcast({ type: 'meta', name: meta.name, mode: 'own' });
      return json({ mode: 'own' });
    }
    if (path === '/delete') {
      this.broadcast({ type: 'deleted' });
      await this.storage.deleteAlarm?.();
      await this.storage.deleteAll(); // 配置、历史、用量都清掉；实例没有数据后由平台回收
      return json({ deleted: true, shareId: meta.shareId || null });
    }
    return json({ error: 'not found' }, 404);
  }

  // 用编辑密钥换会话（密钥已在 fetch 里验过）；设了编辑口令的还要口令，每小时最多试错 EDIT_CODE_TRIES_PER_HOUR 次
  async auth(meta, { code = '' }) {
    if (meta.editCodeHash) {
      code = String(code).trim();
      if (!code) return json({ error: '这个行程设了编辑口令，请输入', status: '0', info: 'EDIT_CODE_REQUIRED' }, 401);
      const hour = Math.floor(Date.now() / 3600e3);
      const saved = await this.storage.get('codeTries');
      const tries = saved?.hour === hour ? saved.count : 0;
      if (tries >= EDIT_CODE_TRIES_PER_HOUR) return json({ error: '试得太多了，请一小时后再试', status: '0', info: 'TOO_MANY_TRIES' }, 429);
      if ((await sha256(`${meta.id}:edit:${code}`)) !== meta.editCodeHash) {
        await this.storage.put('codeTries', { hour, count: tries + 1 });
        return json({ error: '编辑口令不对', status: '0', info: 'EDIT_CODE_WRONG' }, 401);
      }
    }
    return json({ name: meta.name, mode: meta.mode, editCodeHash: meta.editCodeHash || null });
  }

  // 设置或清除编辑口令；设置后除发起人外的在线连接都断开（关闭码 4003），要重新输入口令
  async setEditCode(meta, { code = '', clientId = '' }) {
    code = String(code).trim();
    const [min, max] = EDIT_CODE_LENGTH;
    if (code && (code.length < min || code.length > max)) return json({ error: `编辑口令要 ${min} 到 ${max} 个字符` }, 400);
    meta.editCodeHash = code ? await sha256(`${meta.id}:edit:${code}`) : null;
    await this.storage.put('meta', meta);
    await this.storage.delete('codeTries');
    if (code) this.kickOthers(clientId, 4003, 'edit code changed');
    return json({ editCodeHash: meta.editCodeHash });
  }

  kickOthers(clientId, code, reason) {
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() || {}).clientId !== clientId) {
        try { ws.close(code, reason); } catch { /* 已经断了 */ }
      }
    }
  }

  async init({ id, name, mode, amapKey, keyHash, invite = null, tripLimit = null }) {
    if (await this.storage.get('meta')) return json({ error: '行程已存在' }, 409);
    const limitOk = tripLimit === null || (Number.isInteger(tripLimit) && tripLimit > 0 && tripLimit <= 100000);
    if (!TRIP_MODES.has(mode) || !/^[0-9a-f]{64}$/.test(String(keyHash)) || !limitOk || (mode === 'own') !== Boolean(amapKey)) {
      return json({ error: '行程参数不对' }, 400);
    }
    const now = Date.now();
    const meta = { id, name, mode, amapKey, keyHash, invite, tripLimit, createdAt: now, pageAt: null, shareId: randomId(10), shareCode: null };
    await this.storage.put('meta', meta);
    await this.storage.put('state', { config: structuredClone(EMPTY_CONFIG), version: 1, at: now, author: '' });
    await this.schedule(meta, EMPTY_CONFIG, now);
    return json({ ok: true });
  }

  // ---- 方案页 ----
  async shareReply(meta, extra) {
    const state = await this.storage.get('state');
    const codeHash = meta.shareCode ? await sha256(`${meta.shareId}:${meta.shareCode}`) : null;
    const share = { url: meta.pageAt ? `/p/${meta.shareId}` : null, at: meta.pageAt, code: meta.shareCode || '' };
    this.broadcast({ type: 'share', share });
    return json({ shareId: meta.shareId, codeHash, deadline: this.deadlineOf(state.config, state.at), public: share, ...extra });
  }

  // ---- 数据保留期 ----
  deadlineOf(config, lastEdit) {
    const m = String(config?.options?.travel_date || '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    const travel = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600e3 : NaN; // 北京时间当天零点
    return Math.max(Number.isFinite(travel) ? travel + RETAIN_AFTER_TRAVEL_MS : 0, lastEdit + RETAIN_IDLE_MS);
  }

  async schedule(meta, config, lastEdit) {
    const deadline = this.deadlineOf(config, lastEdit);
    if (meta.deadline && Math.abs(deadline - meta.deadline) < 12 * 3600e3) return; // 变化不大就不重设，省写入
    meta.deadline = deadline;
    await this.storage.put('meta', meta);
    await this.storage.setAlarm(deadline);
  }

  async alarm() {
    const meta = await this.storage.get('meta');
    const state = await this.storage.get('state');
    if (!meta || !state) return;
    const deadline = this.deadlineOf(state.config, state.at);
    if (Date.now() < deadline) { // 期间又有人编辑过或改了出行日期：顺延
      meta.deadline = deadline;
      await this.storage.put('meta', meta);
      await this.storage.setAlarm(deadline);
      return;
    }
    if (meta.shareId) await this.env.DATA.delete(`page:${meta.shareId}`);
    this.broadcast({ type: 'deleted' });
    await this.storage.deleteAll();
  }

  async read(meta) {
    const state = await this.storage.get('state');
    const usage = await this.storage.get('usage');
    if (!meta.deadline) await this.schedule(meta, state.config, state.at); // v3 之前建的行程补上保留期
    return json({
      config: state.config, version: state.version, author: state.author, at: state.at,
      name: meta.name, mode: meta.mode, expiresAt: meta.deadline, editCode: Boolean(meta.editCodeHash),
      share: { url: meta.pageAt && meta.shareId ? `/p/${meta.shareId}` : null, at: meta.pageAt, code: meta.shareCode || '' },
      usage: usage?.day === beijingDay() ? usage.count : 0,
    });
  }

  async save({ config, base_version: base, client_id: clientId, author = '', note = '' }) {
    if (!config || typeof config !== 'object') return json({ error: '配置格式不对' }, 400);
    const state = await this.storage.get('state');
    if (base !== undefined && base !== state.version) {
      // 别人先保存了：把最新的给回去，由浏览器合并后再存
      return json({ error: '配置已被别人更新', conflict: true, config: state.config, version: state.version, author: state.author }, 409);
    }
    const next = await this.commit(config, String(author).slice(0, 30), String(note).slice(0, 200));
    this.broadcast({ type: 'config', config, version: next.version, client_id: clientId, author: next.author });
    return json({ saved: true, version: next.version });
  }

  async restore({ version, author = '', client_id: clientId }) {
    const config = await this.storage.get(`h:${version}`);
    if (!config) return json({ error: '这个版本已经不在历史里了' }, 404);
    const next = await this.commit(config, String(author).slice(0, 30), `恢复到版本 ${version}`, true);
    this.broadcast({ type: 'config', config, version: next.version, client_id: clientId, author: next.author, restored: Number(version) });
    return json({ saved: true, version: next.version, config });
  }

  // 写入新版本并记历史；同一个人 2 分钟内的连续保存合并成一条历史
  async commit(config, author, note, restore = false) {
    const state = await this.storage.get('state');
    const now = Date.now();
    const next = { config, version: state.version + 1, at: now, author };
    await this.storage.put('state', next);
    const index = (await this.storage.get('hindex')) || [];
    const last = index.at(-1);
    if (!restore && last && !last.restore && last.author === author && now - last.firstAt < HISTORY_MERGE_MS) {
      await this.storage.delete(`h:${last.version}`);
      Object.assign(last, { version: next.version, at: now });
      if (note && !last.notes.includes(note)) last.notes = [...last.notes, note].slice(-6);
    } else {
      index.push({ version: next.version, at: now, firstAt: now, author, notes: note ? [note] : [], restore });
    }
    await this.storage.put(`h:${next.version}`, config);
    while (index.length > HISTORY_LIMIT) await this.storage.delete(`h:${index.shift().version}`);
    await this.storage.put('hindex', index);
    await this.schedule(await this.storage.get('meta'), config, now);
    return next;
  }

  async rename(meta, { name }) {
    meta.name = String(name || '').trim().slice(0, 60) || meta.name;
    await this.storage.put('meta', meta);
    this.broadcast({ type: 'meta', name: meta.name });
    return json({ name: meta.name });
  }

  async take(meta, { n = 0, limit, ownLimit }) {
    // 自带 Key 用单独的上限；用邀请码建的行程按邀请码设的上限
    if (meta.mode === 'own') limit = ownLimit;
    else if (meta.tripLimit) limit = meta.tripLimit;
    const today = beijingDay();
    const usage = await this.storage.get('usage');
    const used = usage?.day === today ? usage.count : 0;
    const granted = Math.max(0, Math.min(Number(n) || 0, limit - used));
    if (granted) await this.storage.put('usage', { day: today, count: used + granted });
    return json({
      mode: meta.mode, amapKey: meta.mode === 'own' ? meta.amapKey : null, invite: meta.mode === 'own' ? null : meta.invite || null,
      granted, limit, usedBefore: used, used: used + granted, tripId: meta.id, createdAt: meta.createdAt,
    });
  }

  // ---- 实时同步：在线名单、谁在编辑哪一格 ----
  sockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except);
  }

  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const ws of this.sockets(except)) {
      try { ws.send(text); } catch { /* 已断开的连接由 webSocketClose 清理 */ }
    }
  }

  presence(except) {
    return this.sockets(except).map((ws) => ws.deserializeAttachment() || {}).filter((p) => p.clientId);
  }

  async connect(request) {
    if (request.headers.get('upgrade') !== 'websocket') return json({ error: '需要 WebSocket 连接' }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});
    server.send(JSON.stringify({ type: 'hello', version: (await this.storage.get('state')).version }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const me = ws.deserializeAttachment() || {};
    if (msg.type === 'join') {
      Object.assign(me, { clientId: String(msg.clientId).slice(0, 40), name: String(msg.name || '').slice(0, 30) || '匿名', focus: null });
    } else if (msg.type === 'focus') {
      me.focus = msg.path ? String(msg.path).slice(0, 120) : null;
    } else {
      return;
    }
    ws.serializeAttachment(me);
    this.broadcast({ type: 'presence', people: this.presence() });
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* 已经关了 */ }
    this.broadcast({ type: 'presence', people: this.presence(ws) }, ws);
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011, 'error');
  }
}

const emptyStatsDay = () => ({
  pages: 0, paths: {}, bots: {}, refs: {}, froms: {},
  creates: { invite: 0, own: 0, admin: 0 }, active: 0, publishes: 0, shareViews: 0,
});

// 给「名字 → 次数」的表加一次；这张表里最多 STATS_VALUE_CAP 个不同的名字，超出的和不合规的计入「其他」
function bumpName(map, name) {
  const valid = typeof name === 'string' && /^[a-z0-9./-]{1,60}$/.test(name);
  const known = Object.keys(map).filter((k) => k !== STATS_OTHER).length;
  const key = valid && (Object.hasOwn(map, name) || known < STATS_VALUE_CAP) ? name : STATS_OTHER;
  map[key] = (map[key] || 0) + 1;
}

// ---------- 全站计数：新建行程的频率、站长 Key 的用量、邀请码、管理会话和应急开关 ----------

export class Usage {
  constructor(ctx) { this.ctx = ctx; }

  get storage() { return this.ctx.storage; }

  // 每天的站长 Key 用量：{ 'YYYY-MM-DD': { lbs, search } }，只留 DAILY_KEEP_DAYS 天
  async loadDaily(today) {
    const daily = await this.storage.get('daily');
    if (daily) return daily;
    const old = await this.storage.get('owner'); // 升级前只有当天的总数，不分类：按路线类算，宁多勿少
    return old?.day === today ? { [today]: { lbs: old.count, search: 0 } } : {};
  }

  async saveDaily(daily, now = Date.now()) {
    const oldest = beijingDay(now - (DAILY_KEEP_DAYS - 1) * DAY_MS);
    for (const day of Object.keys(daily)) if (day < oldest) delete daily[day];
    await this.storage.put('daily', daily);
  }

  // 今天和本月的用量
  usageOf(daily, today) {
    const sum = (days) => Object.fromEntries(QUOTA_CLASSES.map((c) => [c, days.reduce((n, d) => n + (daily[d]?.[c] || 0), 0)]));
    const month = Object.keys(daily).filter((d) => d.slice(0, 7) === today.slice(0, 7));
    return { today: sum([today]), month: sum(month) };
  }

  // 记一条管理操作，只留最近 ADMIN_OPS_LIMIT 条
  async log(op, target = '') {
    const ops = (await this.storage.get('ops')) || [];
    ops.unshift({ at: Date.now(), op, target });
    await this.storage.put('ops', ops.slice(0, ADMIN_OPS_LIMIT));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    const today = beijingDay();
    if (path === '/create' || path === '/create-check') {
      const flags = (await this.storage.get('flags')) || {};
      if (flags.creationPaused && !body.admin) return json({ error: '站点暂停了新建行程', info: 'CREATION_PAUSED' }, 503);
      if (path === '/create-check') return json({ ok: true });
      const saved = (await this.storage.get('create')) || {};
      const stats = saved.day === today ? saved : { day: today, total: 0, ips: {} };
      if (stats.total >= CREATE_PER_DAY) return json({ error: '今天新建的行程太多了，明天再试' }, 429);
      if (body.ip && (stats.ips[body.ip] || 0) >= CREATE_PER_IP_PER_DAY) return json({ error: '你今天新建的行程太多了，明天再试' }, 429);
      stats.total += 1;
      if (body.ip) stats.ips[body.ip] = (stats.ips[body.ip] || 0) + 1;
      await this.storage.put('create', stats);
      return json({ ok: true });
    }
    if (path === '/share-attempt') {
      const hour = Math.floor(Date.now() / 3600e3);
      const saved = (await this.storage.get('attempts')) || {};
      const attempts = saved.hour === hour ? saved : { hour, counts: {} };
      attempts.counts[body.id] = (attempts.counts[body.id] || 0) + 1;
      await this.storage.put('attempts', attempts);
      return attempts.counts[body.id] > SHARE_ATTEMPTS_PER_HOUR ? json({ error: 'too many' }, 429) : json({ ok: true });
    }
    if (path === '/hit') return this.hit(body, today);
    if (path === '/owner-take') return this.ownerTake(body, today);
    if (path === '/public-status') return this.publicStatus(body, today);
    // ---- 管理会话 ----
    if (path === '/admin-gate') { // 登录前检查：试错次数超了就直接拒绝，连口令对不对都不判断
      const now = Date.now();
      const fails = (await this.storage.get('adminFails')) || { ips: {}, all: [] };
      const recent = (list, ms) => (list || []).filter((t) => now - t < ms);
      if (recent(fails.ips[body.ip], ADMIN_IP_WINDOW_MS).length >= ADMIN_FAILS_PER_IP) return json({ error: '登录试错太多了，请 15 分钟后再试' }, 429);
      if (recent(fails.all, ADMIN_GLOBAL_WINDOW_MS).length >= ADMIN_FAILS_GLOBAL) return json({ error: '站点登录试错太多了，请一小时后再试' }, 429);
      return json({ ok: true });
    }
    if (path === '/admin-fail') {
      const now = Date.now();
      const fails = (await this.storage.get('adminFails')) || { ips: {}, all: [] };
      for (const [ip, list] of Object.entries(fails.ips)) {
        const recent = list.filter((t) => now - t < ADMIN_IP_WINDOW_MS);
        if (recent.length) fails.ips[ip] = recent; else delete fails.ips[ip];
      }
      fails.ips[body.ip] = [...(fails.ips[body.ip] || []), now];
      fails.all = [...fails.all.filter((t) => now - t < ADMIN_GLOBAL_WINDOW_MS), now];
      await this.storage.put('adminFails', fails);
      return json({ ok: true });
    }
    if (path === '/admin-login') {
      const sessions = (await this.storage.get('admin')) || {};
      for (const [hash, until] of Object.entries(sessions)) if (until < Date.now()) delete sessions[hash];
      sessions[body.hash] = body.expiresAt;
      await this.storage.put('admin', sessions);
      await this.log('登录管理页');
      return json({ ok: true });
    }
    if (path === '/admin-check') {
      const sessions = (await this.storage.get('admin')) || {};
      return sessions[body.hash] > Date.now() ? json({ ok: true }) : json({ error: '需要站长口令' }, 401);
    }
    if (path === '/admin-logout-all') {
      await this.storage.put('admin', {});
      await this.log('退出所有管理会话');
      return json({ ok: true });
    }
    if (path === '/admin-log') {
      await this.log(body.op, body.target);
      return json({ ok: true });
    }
    // ---- 应急开关 ----
    if (path === '/flags') {
      const flags = (await this.storage.get('flags')) || {};
      const names = { publicPaused: '公共额度', creationPaused: '新建行程' };
      for (const [name, label] of Object.entries(names)) {
        if (typeof body[name] !== 'boolean' || Boolean(flags[name]) === body[name]) continue;
        flags[name] = body[name];
        await this.log(`${body[name] ? '暂停' : '恢复'}${label}`);
      }
      await this.storage.put('flags', flags);
      return json({ flags });
    }
    if (path === '/trip-block') {
      const trips = (await this.storage.get('trips')) || [];
      const trip = trips.find((t) => t.id === body.id);
      if (!trip) return json({ error: '这个行程不在最近使用公共额度的名单里' }, 404);
      trip.blocked = Boolean(body.blocked);
      await this.storage.put('trips', trips);
      await this.log(trip.blocked ? '停用行程的公共额度' : '恢复行程的公共额度', trip.id);
      return json({ trip });
    }
    // ---- 邀请码 ----
    if (path === '/invite-use') {
      const invites = (await this.storage.get('invites')) || {};
      const inv = invites[String(body.code).toLowerCase()];
      if (!inv) return json({ error: '邀请码不对' }, 401);
      if (!inv.active) return json({ error: '这个邀请码已停用' }, 403);
      if (inv.expiresAt && Date.now() > inv.expiresAt) return json({ error: '这个邀请码已过期' }, 403);
      if (inv.trips.length >= inv.maxTrips) return json({ error: `这个邀请码最多能建 ${inv.maxTrips} 个行程，已经用完了` }, 403);
      inv.trips.push(body.tripId);
      await this.storage.put('invites', invites);
      return json({ invite: inv.code, tripLimit: inv.tripDailyLimit || null });
    }
    if (path === '/invite-create') {
      const invites = (await this.storage.get('invites')) || {};
      const code = randomId(8);
      invites[code] = {
        code, note: String(body.note || '').slice(0, 60), maxTrips: Math.max(1, Math.min(Number(body.maxTrips) || 3, 1000)),
        tripDailyLimit: Number(body.tripDailyLimit) > 0 ? Math.min(Number(body.tripDailyLimit), 100000) : null,
        expiresAt: Number(body.days) > 0 ? Date.now() + Number(body.days) * 86400e3 : null,
        active: true, createdAt: Date.now(), trips: [], usage: null,
      };
      await this.storage.put('invites', invites);
      await this.log('新建邀请码', code);
      return json({ invite: invites[code] });
    }
    if (path === '/invite-update') {
      const invites = (await this.storage.get('invites')) || {};
      const inv = invites[body.code];
      if (!inv) return json({ error: '没有这个邀请码' }, 404);
      inv.active = Boolean(body.active);
      await this.storage.put('invites', invites);
      await this.log(inv.active ? '启用邀请码' : '停用邀请码', inv.code);
      return json({ invite: inv });
    }
    if (path === '/invite-disable-all') {
      const invites = (await this.storage.get('invites')) || {};
      const on = Object.values(invites).filter((inv) => inv.active);
      for (const inv of on) inv.active = false;
      await this.storage.put('invites', invites);
      await this.log('停用所有邀请码', `${on.length} 个`);
      return json({ disabled: on.length });
    }
    if (path === '/stats') {
      const create = (await this.storage.get('create')) || {};
      const daily = await this.loadDaily(today);
      const { today: used, month } = this.usageOf(daily, today);
      const invites = Object.values((await this.storage.get('invites')) || {})
        .map((inv) => ({ ...inv, usedToday: inv.usage?.day === today ? inv.usage.count : 0 }))
        .sort((a, b) => b.createdAt - a.createdAt);
      const trips = [...((await this.storage.get('trips')) || [])].reverse() // 最近用过的在前；今天没用就显示 0
        .map((t) => ({ ...t, usedToday: t.lastDay === today ? t.usedToday : 0 }));
      const days = Array.from({ length: DAILY_SHOW_DAYS }, (_, i) => {
        const day = beijingDay(Date.now() - i * DAY_MS);
        return { day, lbs: daily[day]?.lbs || 0, search: daily[day]?.search || 0 };
      });
      return json({
        ownerUsedToday: used.lbs + used.search, ownerLimit: body.ownerLimit,
        createdToday: create.day === today ? create.total : 0, invites, trips,
        flags: (await this.storage.get('flags')) || {}, ops: (await this.storage.get('ops')) || [],
        quota: { today: used, month, budgets: body.budgets, days },
        traffic: await this.traffic(today),
      });
    }
    return json({ error: 'not found' }, 404);
  }

  // ---- 流量统计：每天一条 st:YYYY-MM-DD，只有次数；新的一天写入第一条时顺便清掉超过 STATS_KEEP_DAYS 天的 ----

  async statsBump(today, update) {
    const key = STATS_PREFIX + today;
    let day = await this.storage.get(key);
    if (!day) {
      day = emptyStatsDay();
      const oldest = beijingDay(Date.now() - (STATS_KEEP_DAYS - 1) * DAY_MS);
      const old = [...(await this.storage.list({ prefix: STATS_PREFIX })).keys()].filter((k) => k < STATS_PREFIX + oldest);
      for (let i = 0; i < old.length; i += 100) await this.storage.delete(old.slice(i, i + 100));
    }
    update(day);
    await this.storage.put(key, day);
  }

  // Worker 在后台发来的事件：page（页面访问）、bot（爬虫）、create（新建行程）、publish（发布方案页）、shareView（方案页被打开）
  async hit(body, today) {
    await this.statsBump(today, (d) => {
      if (body.kind === 'page') {
        d.pages += 1;
        bumpName(d.paths, body.path);
        if (body.ref) bumpName(d.refs, body.ref);
        if (body.from) bumpName(d.froms, body.from);
      } else if (body.kind === 'bot') {
        const name = BOT_NAMES.has(body.bot) ? body.bot : 'other';
        d.bots[name] = (d.bots[name] || 0) + 1;
      } else if (body.kind === 'create' && body.source in d.creates) {
        d.creates[body.source] += 1;
      } else if (body.kind === 'publish') {
        d.publishes += 1;
      } else if (body.kind === 'shareView') {
        d.shareViews += 1;
      }
    });
    return json({ ok: true });
  }

  // 近 STATS_SHOW_DAYS 天的统计，新的在前，没有记录的天补零
  async traffic(today) {
    const saved = await this.storage.list({ prefix: STATS_PREFIX });
    const days = Array.from({ length: STATS_SHOW_DAYS }, (_, i) => {
      const day = beijingDay(Date.now() - i * DAY_MS);
      return { day, ...(saved.get(STATS_PREFIX + day) || emptyStatsDay()) };
    });
    return { days };
  }

  // 站长 Key 按类别领取调用次数。顺序：应急开关 → 行程是否被停用 → 邀请码 → 八成预留 → 每日总上限和每月预算
  async ownerTake(body, today) {
    const flags = (await this.storage.get('flags')) || {};
    const daily = await this.loadDaily(today);
    const { today: used, month } = this.usageOf(daily, today);
    const total = used.lbs + used.search;
    const refuse = (reason) => json({
      granted: { lbs: 0, search: 0 }, reasons: { lbs: reason, search: reason }, used: total,
    });
    if (flags.publicPaused) return refuse('PUBLIC_PAUSED');
    const trips = (await this.storage.get('trips')) || [];
    if (body.tripId && trips.find((t) => t.id === body.tripId)?.blocked) return refuse('TRIP_BLOCKED');
    const invites = (await this.storage.get('invites')) || {};
    const inv = body.invite ? invites[body.invite] : null;
    if (body.invite && (!inv || !inv.active)) return refuse('INVITE_DISABLED');
    if (body.fresh && total >= body.limit * OWNER_RESERVE_RATIO) return refuse('OWNER_RESERVED');
    let room = Math.max(0, body.limit - total); // 全站今天还剩多少
    const granted = {}, reasons = {};
    for (const cls of QUOTA_CLASSES) {
      const want = Math.max(0, Number(body.want?.[cls]) || 0);
      const left = Math.max(0, body.budgets[cls] - month[cls]); // 这一类本月预算还剩多少
      granted[cls] = Math.min(want, left, room);
      if (granted[cls] < want) reasons[cls] = left <= room ? 'MONTHLY_BUDGET' : 'OWNER_DAILY_LIMIT';
      room -= granted[cls];
    }
    const sum = granted.lbs + granted.search;
    if (sum) {
      daily[today] = { lbs: used.lbs + granted.lbs, search: used.search + granted.search };
      await this.saveDaily(daily);
      if (inv) {
        inv.usage = inv.usage?.day === today ? { day: today, count: inv.usage.count + sum } : { day: today, count: sum };
        await this.storage.put('invites', invites);
      }
      if (body.tripId) {
        // 当天有计算的行程数：这个行程当天第一次领到额度时计一次
        if (trips.find((t) => t.id === body.tripId)?.lastDay !== today) await this.statsBump(today, (d) => { d.active += 1; });
        await this.touchTrip(trips, body, today, sum);
      }
    }
    return json({ granted, reasons, used: total + sum });
  }

  // 记下最近用过公共额度的行程：只记 id、新建时间、邀请码、最后使用日、今天用量，不记名称和内容
  async touchTrip(trips, body, today, count) {
    let i = trips.findIndex((t) => t.id === body.tripId);
    const trip = i >= 0 ? trips.splice(i, 1)[0] : { id: body.tripId, createdAt: body.createdAt || null, invite: body.invite || null, blocked: false };
    trip.usedToday = trip.lastDay === today ? trip.usedToday + count : count;
    trip.lastDay = today;
    trips.push(trip); // 最近用过的放最后
    while (trips.length > TRACKED_TRIPS_LIMIT) { // 满了先挤掉最久没用的，被停用的尽量留着
      i = trips.findIndex((t) => !t.blocked);
      trips.splice(i >= 0 ? i : 0, 1);
    }
    await this.storage.put('trips', trips);
  }

  // 公开状态：粗粒度的百分比，不含具体次数、行程、邀请码
  async publicStatus({ ownerLimit, budgets }, today) {
    const flags = (await this.storage.get('flags')) || {};
    const { today: used, month } = this.usageOf(await this.loadDaily(today), today);
    const total = used.lbs + used.search;
    const pct = (n, of) => Math.min(100, Math.round((100 * n) / of));
    let level = 'ok';
    if (total >= ownerLimit * 0.8) level = 'tight';
    if (total >= ownerLimit || month.lbs >= budgets.lbs) level = 'out';
    if (flags.publicPaused) level = 'paused';
    return json({ public: { level, usedPct: pct(total, ownerLimit), searchMonthPct: pct(month.search, budgets.search) }, creating: !flags.creationPaused });
  }
}

// ---------- 入口 ----------

// Worker 生成的响应（JSON、方案页、口令页、编辑页、404）也要带安全头；静态文件的同一组头在 web/_headers。
// 两处要保持一致。X-Frame-Options 和 frame-ancestors 只能放在响应头里，meta 标签里无效
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=15552000',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};

function withSecurityHeaders(res, extra = {}) {
  if (res.status === 101 || res.webSocket) return res; // WebSocket 升级响应不能改
  const out = new Response(res.body, res); // 复制一份，ASSETS 等来源的响应头是只读的
  // 方案页自带的 referrer-policy 等更严格的设置保留，其余补齐
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

// 改动状态的请求只接受本站页面发起的：带了 Origin 但不是本站就拒绝；不带的（curl、部分旧浏览器的同源 POST）放行
function crossSiteMutation(request, url) {
  const origin = request.headers.get('origin');
  if (!origin || origin === url.origin) return false;
  if (!['POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method)) return false;
  return url.pathname.startsWith('/api/') || /^\/p\/[a-z2-9]{10,12}$/.test(url.pathname);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isEditPage = /^\/t\/[a-z2-9]{10}\/?$/.test(url.pathname);
    return withSecurityHeaders(await route(request, env, url, ctx), isEditPage ? { 'content-security-policy': "frame-ancestors 'none'" } : {});
  },
};

async function route(request, env, url, ctx) {
  const { pathname } = url;
  try {
    if (crossSiteMutation(request, url)) return json({ error: '只接受本站发起的请求' }, 403);
    if (pathname === '/api/env') return json({ mode: 'online', ownerKey: Boolean(env.ACCESS_CODE && env.AMAP_KEY), version: pkg.version });
    if (pathname === '/api/status' && request.method === 'GET') return await publicStatus(env, url);
    if (pathname === '/api/trips' && request.method === 'POST') return await createTrip(request, env, ctx);
    if (pathname.startsWith('/api/admin/')) return await adminApi(request, env, url, ctx);
    const trip = pathname.match(/^\/api\/t\/([a-z2-9]+)(\/.*)$/);
    if (trip) return ID_RE.test(trip[1]) ? await tripApi(request, env, url, trip[1], trip[2], ctx) : json({ error: '行程不存在' }, 404);
    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    const page = pathname.match(/^\/p\/([a-z2-9]{10,12})$/);
    // 方案页：链接本身是访问凭证，可另设口令。10 位是方案页 id，12 位是 v1 单独发布的旧链接
    if (page) return await sharePage(request, env, url, page[1], ctx);
    if (/^\/t\/[a-z2-9]{10}\/?$/.test(pathname)) return env.ASSETS.fetch(new Request(new URL('/edit', url)));
    if (PAGE_PATH_RE.test(pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname)) return await servePage(request, env, url, ctx); // 页面访问计数
    return env.ASSETS.fetch(request);
  } catch (err) {
    // 4xx 是我们自己抛的、写给用户看的提示；其余不把内部错误原文交给客户端
    if (err.status && err.status < 500) return json({ error: err.message }, err.status);
    console.error('未处理的错误', err);
    return json({ error: '服务器出错了，请稍后再试' }, 500);
  }
}
