// SPDX-License-Identifier: AGPL-3.0-or-later
// 拼车出行规划的 Cloudflare Worker：多个行程、编辑链接鉴权、实时同步与历史版本、高德接口代理、方案页。
// 计算在浏览器里跑（Pyodide，见 web/pyworker.js），这里只做转发、计数和存储。
//
// 绑定：ROOM（Durable Object，每个行程一个实例）、USAGE（Durable Object，全站计数）、
//       DATA（KV：方案页、高德配额标记）、ASSETS（静态文件 dist/）
// 密钥：AMAP_KEY（站长的高德 Key）、ACCESS_CODE（创建口令，用站长 Key 新建行程时要填）
// 可选变量：TRIP_DAILY_LIMIT（用站长 Key 的行程每天的高德调用上限）、OWN_TRIP_DAILY_LIMIT（自带 Key 的行程每天上限，
//          只防程序出错时无限调用）、OWNER_DAILY_LIMIT（站长 Key 全站每天上限）

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
const CREATE_PER_IP_PER_DAY = 10;
// 数据保留期：出行日期后 60 天、最后一次编辑后 180 天，取较晚的那个；到期由行程实例的定时任务删除
const RETAIN_AFTER_TRAVEL_MS = 60 * 86400e3;
const RETAIN_IDLE_MS = 180 * 86400e3;
const SHARE_ATTEMPTS_PER_HOUR = 20; // 方案页访问口令每个方案页每小时最多试 20 次
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);

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
const internal = (path, body, key) => new Request(`https://internal${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: key === undefined ? {} : { 'x-trip-key': key },
  body: body === undefined ? undefined : JSON.stringify(body),
});

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

async function createTrip(request, env) {
  const body = await readJson(request, 4096);
  const name = String(body.name || '').trim().slice(0, 60) || '未命名行程';
  let mode, amapKey = null;
  const code = String(body.code || '').trim();
  if (code) {
    mode = 'owner'; // 站长口令或邀请码：用站点的公共额度
  } else if (body.amapKey) {
    amapKey = String(body.amapKey).trim();
    const problem = await amapKeyProblem(amapKey);
    if (problem) return json({ error: problem }, 400);
    mode = 'own';
  } else {
    return json({ error: '要么填创建口令，要么填自己的高德 Key' }, 400);
  }
  const ip = await sha256(request.headers.get('cf-connecting-ip') || 'unknown');
  const gate = await usageOf(env).fetch(internal('/create', { ip }));
  if (!gate.ok) return gate;
  const id = randomId(10), key = randomId(24);
  let invite = null, tripLimit = null;
  if (code && !(env.ACCESS_CODE && code === env.ACCESS_CODE)) {
    // 邀请码：检查有效、未过期、没用满，并占一个名额
    const res = await usageOf(env).fetch(internal('/invite-use', { code, tripId: id }));
    if (!res.ok) { await sleep(800); return res; } // 拖慢猜邀请码
    ({ invite, tripLimit } = await res.json());
  }
  await roomOf(env, id).fetch(internal('/init', { id, name, mode, amapKey, invite, tripLimit, keyHash: await sha256(key) }));
  return json({ id, key, url: `/t/${id}#k=${key}` });
}

// ---------- 管理页：站长口令登录，管理邀请码、看用量 ----------

const adminToken = (env) => sha256(`admin:${env.ACCESS_CODE}`);

async function adminApi(request, env, url) {
  const sub = url.pathname.slice('/api/admin'.length);
  if (!env.ACCESS_CODE) return json({ error: '这个站点没有设置站长口令' }, 404);
  if (sub === '/login' && request.method === 'POST') {
    const { code = '' } = await readJson(request, 1024);
    if (code !== env.ACCESS_CODE) { await sleep(800); return json({ error: '口令不对' }, 401); }
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true }, 200, { 'set-cookie': `adm=${await adminToken(env)}; Path=/api/admin; HttpOnly;${secure} SameSite=Strict; Max-Age=86400` });
  }
  if (getCookie(request, 'adm') !== (await adminToken(env))) return json({ error: '需要站长口令' }, 401);
  const usage = usageOf(env);
  if (sub === '/stats') return usage.fetch(internal('/stats', { ownerLimit: limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT) }));
  if (sub === '/invites' && request.method === 'POST') return usage.fetch(internal('/invite-create', await readJson(request, 2048)));
  const one = sub.match(/^\/invites\/([a-z2-9]{8})$/);
  if (one && request.method === 'POST') return usage.fetch(internal('/invite-update', { code: one[1], ...(await readJson(request, 1024)) }));
  return json({ error: 'not found' }, 404);
}

// ---------- 行程内的接口 ----------

async function tripApi(request, env, url, id, sub) {
  const room = roomOf(env, id);
  if (sub === '/session' && request.method === 'POST') {
    // 用编辑链接里的密钥换一个只对这个行程路径生效的 Cookie（WebSocket 也会带上）
    const { key = '' } = await readJson(request, 1024);
    const res = await room.fetch(internal('/auth', undefined, String(key)));
    if (!res.ok) { await sleep(500); return res; }
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json(await res.json(), 200, {
      'set-cookie': `tk_${id}=${key}; Path=/api/t/${id}; HttpOnly;${secure} SameSite=Lax; Max-Age=7776000`,
    });
  }
  const key = getCookie(request, `tk_${id}`);
  if (!key) return json({ error: '需要用编辑链接打开', status: '0', info: 'UNAUTHORIZED' }, 401);
  if (request.headers.get('upgrade') === 'websocket' && request.headers.get('origin') !== url.origin) {
    return json({ error: '只接受本站发起的连接' }, 403); // 防止其他网站借用户的 Cookie 建立同步连接
  }
  if (sub === '/amap-batch' || sub.startsWith('/amap/')) return tripAmap(request, env, url, room, key, sub);
  if (sub === '/page' && request.method === 'POST') return publishPage(request, env, url, room, key);
  if (sub === '/share' && request.method === 'POST') return shareSettings(request, env, room, key);
  if (sub === '/rotate-key' && request.method === 'POST') return rotateKey(request, env, url, room, key, id);
  if (sub === '/key' && request.method === 'POST') { // 改用自己的高德 Key：公共额度用完时可以接着算
    const amapKey = String((await readJson(request, 1024)).amapKey || '').trim();
    const problem = await amapKeyProblem(amapKey);
    if (problem) return json({ error: problem }, 400);
    return room.fetch(internal('/set-key', { amapKey }, key));
  }
  if (sub === '/delete' && request.method === 'POST') {
    const res = await room.fetch(internal('/delete', {}, key));
    if (res.ok) {
      const { shareId } = await res.clone().json();
      if (shareId) await env.DATA.delete(`page:${shareId}`);
    }
    return res;
  }
  // 其余（配置、同步、历史、改名）交给行程实例
  if (request.method === 'POST' && Number(request.headers.get('content-length') || 0) > MAX_CONFIG_BYTES) {
    return json({ error: '内容太大' }, 413);
  }
  const forward = new Request(`https://internal${sub}${url.search}`, request);
  forward.headers.set('x-trip-key', key);
  return room.fetch(forward);
}

// 方案页存在 KV：键是方案页自己的 id（不是行程 id，可以单独作废），口令哈希放在元数据里，过期时间跟着行程保留期走
const pageOptions = (share) => ({
  metadata: { codeHash: share.codeHash || null },
  expiration: Math.floor((share.deadline + 86400e3) / 1000),
});

async function publishPage(request, env, url, room, key) {
  const { html } = await readJson(request, MAX_PAGE_BYTES);
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) return json({ error: '方案页内容不对' }, 400);
  const res = await room.fetch(internal('/published', {}, key)); // 先鉴权并记下发布时间
  if (!res.ok) return res;
  const share = await res.json();
  await env.DATA.put(`page:${share.shareId}`, html, pageOptions(share));
  return json({ share: share.public });
}

async function shareSettings(request, env, room, key) {
  const body = await readJson(request, 1024);
  const res = await room.fetch(internal('/share', body, key));
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

async function rotateKey(request, env, url, room, key, id) {
  const { clientId = '' } = await readJson(request, 1024);
  const next = randomId(24);
  const res = await room.fetch(internal('/rotate', { keyHash: await sha256(next), clientId }, key));
  if (!res.ok) return res;
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return json({ key: next, url: `/t/${id}#k=${next}` }, 200, {
    'set-cookie': `tk_${id}=${next}; Path=/api/t/${id}; HttpOnly;${secure} SameSite=Lax; Max-Age=7776000`,
  });
}

// 方案页：有访问口令的先要口令；口令对了发一个只对这个方案页路径有效的 Cookie
function codePage(id, message, status) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>输入访问口令</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf7f2;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#24201c}
form{background:#fff;border:1px solid #ebe4da;border-radius:14px;padding:22px;width:min(320px,88vw)}h1{font-size:18px;margin:0 0 6px}
p{color:#7a7168;font-size:13px;margin:0 0 12px}input{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #ebe4da;border-radius:8px}
button{margin-top:10px;width:100%;font:inherit;padding:8px;border:0;border-radius:8px;background:#b4442c;color:#fff}.err{color:#b91c1c;min-height:1.4em;margin:6px 0 0}</style></head>
<body><form method="post" action="/p/${id}"><h1>这个出行方案设了访问口令</h1><p>口令由发起人设置，问一下发给你链接的人。</p>
<input name="code" autocomplete="off" autofocus required><div class="err">${message}</div><button>查看方案</button></form></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

// 方案页的 HTML 是编辑者的浏览器生成后上传的，不能当作本站的可信代码：放进沙箱（独立的匿名来源），
// 读不到本站的 localStorage（里面有编辑链接）和 Cookie；只放行地图要用的脚本、样式和瓦片，不能发请求、不能提交表单
const SHARE_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation-by-user-activation',
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  'img-src data: https://cdnjs.cloudflare.com https://*.is.autonavi.com',
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

async function sharePage(request, env, url, id) {
  const { value: html, metadata } = await env.DATA.getWithMetadata(`page:${id}`);
  if (html === null || html === undefined) {
    return new Response('方案页不存在：可能还没发布、已停止分享，或者换了新链接', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
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

async function tripAmap(request, env, url, room, key, sub) {
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
  }, key));
  if (!grant.ok) return grant;
  const { mode, amapKey, granted: tripGranted, limit: tripLimit, usedBefore, invite } = await grant.json();
  let granted = tripGranted;
  let limitError = { status: '0', info: 'TRIP_DAILY_LIMIT', error: `这个行程今天的高德调用已到上限（${tripLimit} 次），明天再试` };
  if (mode === 'owner' && granted) {
    const ownerLimit = limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT);
    const res = await usageOf(env).fetch(internal('/owner-take', { n: granted, limit: ownerLimit, invite, fresh: usedBefore === 0 }));
    const { granted: ownerGranted, reason } = await res.json();
    if (ownerGranted < granted) {
      limitError = {
        INVITE_DISABLED: { status: '0', info: 'INVITE_DISABLED', error: '建这个行程用的邀请码已停用，不能再用站点的公共额度；改用自己的高德 Key 就能继续' },
        OWNER_RESERVED: { status: '0', info: 'OWNER_RESERVED', error: '站点今天的公共额度快用完了，剩下的优先留给已经在算的行程；改用自己的高德 Key 能马上继续，或者明天再来' },
      }[reason] || { status: '0', info: 'OWNER_DAILY_LIMIT', error: '站点今天共用的高德额度已用完。明天再试，或者改用自己的高德 Key' };
    }
    granted = ownerGranted;
  }
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
  for (const i of open.slice(granted)) results[i] = limitError;
  // 没命中缓存的按每秒 AMAP_QPS 个发；被限流的等一会儿再试一次
  let todo = open.slice(0, granted);
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
    if (path === '/init') return this.init(await request.json());
    const meta = await this.storage.get('meta');
    if (!meta || meta.keyHash !== (await sha256(request.headers.get('x-trip-key') || ''))) {
      return json({ error: '编辑链接无效或已失效', status: '0', info: 'UNAUTHORIZED' }, 401);
    }
    if (!meta.shareId && meta.pageAt) { // v3 之前发布过的行程：方案页沿用 /p/<行程 id>，重新发布时更新的还是大家手里的那个链接
      meta.shareId = meta.id;
      await this.storage.put('meta', meta);
    }
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;
    if (path === '/auth') return json({ name: meta.name, mode: meta.mode });
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
      for (const ws of this.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() || {}).clientId !== body.clientId) {
          try { ws.close(4001, 'key rotated'); } catch { /* 已经断了 */ }
        }
      }
      return json({ ok: true });
    }
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

  async init({ id, name, mode, amapKey, keyHash, invite = null, tripLimit = null }) {
    if (await this.storage.get('meta')) return json({ error: '行程已存在' }, 409);
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
      name: meta.name, mode: meta.mode, expiresAt: meta.deadline,
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
      granted, limit, usedBefore: used, used: used + granted,
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

// ---------- 全站计数：新建行程的频率、站长 Key 的每日用量 ----------

export class Usage {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    const today = beijingDay();
    if (path === '/create') {
      const saved = (await this.ctx.storage.get('create')) || {};
      const stats = saved.day === today ? saved : { day: today, total: 0, ips: {} };
      if (stats.total >= CREATE_PER_DAY) return json({ error: '今天新建的行程太多了，明天再试' }, 429);
      if ((stats.ips[body.ip] || 0) >= CREATE_PER_IP_PER_DAY) return json({ error: '你今天新建的行程太多了，明天再试' }, 429);
      stats.total += 1;
      stats.ips[body.ip] = (stats.ips[body.ip] || 0) + 1;
      await this.ctx.storage.put('create', stats);
      return json({ ok: true });
    }
    if (path === '/share-attempt') {
      const hour = Math.floor(Date.now() / 3600e3);
      const saved = (await this.ctx.storage.get('attempts')) || {};
      const attempts = saved.hour === hour ? saved : { hour, counts: {} };
      attempts.counts[body.id] = (attempts.counts[body.id] || 0) + 1;
      await this.ctx.storage.put('attempts', attempts);
      return attempts.counts[body.id] > SHARE_ATTEMPTS_PER_HOUR ? json({ error: 'too many' }, 429) : json({ ok: true });
    }
    if (path === '/owner-take') {
      const saved = (await this.ctx.storage.get('owner')) || {};
      const used = saved.day === today ? saved.count : 0;
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = body.invite ? invites[body.invite] : null;
      if (body.invite && (!inv || !inv.active)) return json({ granted: 0, used, reason: 'INVITE_DISABLED' });
      if (body.fresh && used >= body.limit * OWNER_RESERVE_RATIO) return json({ granted: 0, used, reason: 'OWNER_RESERVED' });
      const granted = Math.max(0, Math.min(Number(body.n) || 0, body.limit - used));
      if (granted) {
        await this.ctx.storage.put('owner', { day: today, count: used + granted });
        if (inv) {
          inv.usage = inv.usage?.day === today ? { day: today, count: inv.usage.count + granted } : { day: today, count: granted };
          await this.ctx.storage.put('invites', invites);
        }
      }
      return json({ granted, used: used + granted });
    }
    // ---- 邀请码 ----
    if (path === '/invite-use') {
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = invites[String(body.code).toLowerCase()];
      if (!inv) return json({ error: '口令或邀请码不对' }, 401);
      if (!inv.active) return json({ error: '这个邀请码已停用' }, 403);
      if (inv.expiresAt && Date.now() > inv.expiresAt) return json({ error: '这个邀请码已过期' }, 403);
      if (inv.trips.length >= inv.maxTrips) return json({ error: `这个邀请码最多能建 ${inv.maxTrips} 个行程，已经用完了` }, 403);
      inv.trips.push(body.tripId);
      await this.ctx.storage.put('invites', invites);
      return json({ invite: inv.code, tripLimit: inv.tripDailyLimit || null });
    }
    if (path === '/invite-create') {
      const invites = (await this.ctx.storage.get('invites')) || {};
      const code = randomId(8);
      invites[code] = {
        code, note: String(body.note || '').slice(0, 60), maxTrips: Math.max(1, Math.min(Number(body.maxTrips) || 3, 1000)),
        tripDailyLimit: Number(body.tripDailyLimit) > 0 ? Math.min(Number(body.tripDailyLimit), 100000) : null,
        expiresAt: Number(body.days) > 0 ? Date.now() + Number(body.days) * 86400e3 : null,
        active: true, createdAt: Date.now(), trips: [], usage: null,
      };
      await this.ctx.storage.put('invites', invites);
      return json({ invite: invites[code] });
    }
    if (path === '/invite-update') {
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = invites[body.code];
      if (!inv) return json({ error: '没有这个邀请码' }, 404);
      inv.active = Boolean(body.active);
      await this.ctx.storage.put('invites', invites);
      return json({ invite: inv });
    }
    if (path === '/stats') {
      const owner = (await this.ctx.storage.get('owner')) || {};
      const create = (await this.ctx.storage.get('create')) || {};
      const invites = Object.values((await this.ctx.storage.get('invites')) || {})
        .map((inv) => ({ ...inv, usedToday: inv.usage?.day === today ? inv.usage.count : 0 }))
        .sort((a, b) => b.createdAt - a.createdAt);
      return json({
        ownerUsedToday: owner.day === today ? owner.count : 0, ownerLimit: body.ownerLimit,
        createdToday: create.day === today ? create.total : 0, invites,
      });
    }
    return json({ error: 'not found' }, 404);
  }
}

// ---------- 入口 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/api/env') return json({ mode: 'online', ownerKey: Boolean(env.ACCESS_CODE && env.AMAP_KEY) });
      if (pathname === '/api/trips' && request.method === 'POST') return await createTrip(request, env);
      if (pathname.startsWith('/api/admin/')) return await adminApi(request, env, url);
      const trip = pathname.match(/^\/api\/t\/([a-z2-9]+)(\/.*)$/);
      if (trip) return ID_RE.test(trip[1]) ? await tripApi(request, env, url, trip[1], trip[2]) : json({ error: '行程不存在' }, 404);
      if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      const page = pathname.match(/^\/p\/([a-z2-9]{10,12})$/);
      // 方案页：链接本身是访问凭证，可另设口令。10 位是方案页 id，12 位是 v1 单独发布的旧链接
      if (page) return await sharePage(request, env, url, page[1]);
      if (/^\/t\/[a-z2-9]{10}\/?$/.test(pathname)) return env.ASSETS.fetch(new Request(new URL('/edit', url)));
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },
};
