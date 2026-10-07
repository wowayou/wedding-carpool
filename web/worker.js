// 婚礼拼车的 Cloudflare Worker：口令登录、高德接口代理、配置实时同步、方案页存储。
// 计算本身在浏览器里跑（Pyodide，见 web/pyworker.js），这里不做重活。
//
// 绑定：ROOM（Durable Object，存配置并通过 WebSocket 广播改动）、DATA（KV，方案页和配额标记）、
// ASSETS（静态文件 dist/）；密钥：AMAP_KEY、ACCESS_CODE。

// 只放行计算用到的高德接口，Key 由这里加上
const AMAP_PATHS = new Set([
  '/v3/geocode/geo', '/v3/geocode/regeo', '/v5/place/text', '/v5/place/around', '/v5/place/polygon',
  '/v3/distance', '/v3/direction/driving', '/v3/direction/transit/integrated',
]);
const COOKIE = 'carpool_auth';
const MAX_CONFIG_BYTES = 200 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TTL_SECONDS = 180 * 24 * 3600; // 方案页保留半年
// 高德配额类错误：记下来，到北京时间次日零点前不再转发，免得继续调用
const QUOTA_RE = /DAILY_QUERY_OVER_LIMIT|QUOTA_PLAN_RUN_OUT|SERVICE_EXPIRED/;
const QUOTA_KEY = 'amap_quota_until';
const EMPTY_CONFIG = { venue: { name: '' }, options: { max_detour_min: 30, max_stops: 2 }, stations: [], people: [] };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Cookie 里存口令的哈希；换口令后旧 Cookie 自动失效
const authToken = (env) => sha256(`wedding-carpool:${env.ACCESS_CODE}`);

async function isAuthed(request, env) {
  if (!env.ACCESS_CODE) return false;
  const cookie = request.headers.get('cookie') || '';
  const value = cookie.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value === (await authToken(env));
}

async function readJson(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw new Error('内容太大');
  return JSON.parse(text);
}

function randomId(length = 12) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');
}

async function login(request, env) {
  const body = await readJson(request, 1024).catch(() => ({}));
  if (!env.ACCESS_CODE || body.code !== env.ACCESS_CODE) {
    await new Promise((r) => setTimeout(r, 800)); // 拖慢猜口令
    return json({ error: '口令不对' }, 401);
  }
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=${await authToken(env)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=2592000`,
  });
}

function nextBeijingMidnight(now = Date.now()) {
  const day = 86400e3, offset = 8 * 3600e3;
  return (Math.floor((now + offset) / day) + 1) * day - offset;
}

// 成功结果在 Cloudflare 节点上缓存：地点类变化慢，行车时间和路线跟路况走，缓存短一些
const CACHE_SECONDS = { '/v3/distance': 1200, '/v3/direction/driving': 1200, '/v3/direction/transit/integrated': 3600 };
const BATCH_LIMIT = 40; // 免费套餐单次请求最多 50 个子请求
const AMAP_QPS = 3; // 高德个人 Key 的每秒调用上限按 3 算，批量请求按这个节奏发
const QPS_RE = /QPS|TOO_FREQUENT/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTA_BLOCKED = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003', error: '高德今日配额已用完，北京时间零点前不再调用' };

async function quotaBlocked(env) {
  return Date.now() < (Number(await env.DATA.get(QUOTA_KEY)) || 0);
}

// 调一次高德（先查缓存），返回解析后的 JSON；出错也返回 { status: '0', ... }，由浏览器端决定怎么处理
function cacheKeyOf(origin, path, query) {
  const params = new URLSearchParams(query);
  params.delete('key');
  return new Request(`${origin}/__amap_cache${path}?${params}`);
}

async function cached(origin, path, query) {
  const cache = globalThis.caches?.default; // 只在 Cloudflare 上有；自定义域名下才生效
  const hit = cache && (await cache.match(cacheKeyOf(origin, path, query)));
  return hit ? hit.json() : null;
}

async function fetchAmap(origin, path, query, env) {
  if (!AMAP_PATHS.has(path)) return { status: '0', info: 'PATH_NOT_ALLOWED' };
  const hit = await cached(origin, path, query);
  if (hit) return hit;
  const cache = globalThis.caches?.default;
  const cacheKey = cacheKeyOf(origin, path, query);
  const params = new URLSearchParams(query);
  params.set('key', env.AMAP_KEY);
  let text;
  try {
    text = await (await fetch(`https://restapi.amap.com${path}?${params}`)).text();
  } catch (err) {
    return { status: '0', info: 'NETWORK_ERROR', error: `连不上高德：${err.message}` };
  }
  let data;
  try { data = JSON.parse(text); } catch { return { status: '0', info: 'BAD_RESPONSE' }; }
  if (QUOTA_RE.test(String(data.info || ''))) {
    await env.DATA.put(QUOTA_KEY, String(nextBeijingMidnight()));
  } else if (String(data.status) === '1' && cache) {
    await cache.put(cacheKey, new Response(text, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS[path] ?? 7 * 86400}` },
    }));
  }
  return data;
}

async function proxyAmap(url, env) {
  const path = url.pathname.slice('/api/amap'.length);
  if (!AMAP_PATHS.has(path)) return json({ status: '0', info: 'PATH_NOT_ALLOWED' }, 403);
  if (await quotaBlocked(env)) return json(QUOTA_BLOCKED, 429);
  const data = await fetchAmap(url.origin, path, url.search, env);
  return json(data, data.info === 'NETWORK_ERROR' ? 502 : 200);
}

// 批量：浏览器一次发来一组请求，这里并发去取，省掉逐个跨洋往返
async function amapBatch(request, env, url) {
  const { requests } = await readJson(request, 200 * 1024);
  if (!Array.isArray(requests) || requests.length > BATCH_LIMIT) return json({ error: `一次最多 ${BATCH_LIMIT} 个请求` }, 400);
  if (await quotaBlocked(env)) return json({ results: requests.map(() => QUOTA_BLOCKED) });
  const items = requests.map((r) => ({ path: String(r.path), query: String(r.query || '') }));
  const results = await Promise.all(items.map((r) => cached(url.origin, r.path, r.query)));
  // 没命中缓存的按每秒 AMAP_QPS 个发；被限流的等一会儿再试一次
  for (const round of [0, 1]) {
    const todo = results.map((r, i) => (r === null || (round && QPS_RE.test(String(r.info || ''))) ? i : -1)).filter((i) => i >= 0);
    if (round && todo.length) await sleep(1000);
    for (let k = 0; k < todo.length; k += AMAP_QPS) {
      const started = Date.now();
      const wave = todo.slice(k, k + AMAP_QPS);
      const out = await Promise.all(wave.map((i) => fetchAmap(url.origin, items[i].path, items[i].query, env)));
      wave.forEach((i, j) => { results[i] = out[j]; });
      if (out.some((d) => QUOTA_RE.test(String(d.info || '')))) {
        return json({ results: results.map((r) => r ?? QUOTA_BLOCKED) }); // 配额用完：剩下的不再请求
      }
      if (k + AMAP_QPS < todo.length) await sleep(Math.max(0, 1000 - (Date.now() - started)));
    }
  }
  return json({ results });
}

async function api(request, env, url) {
  const { pathname } = url;
  if (pathname === '/api/env') return json({ mode: 'online' });
  if (pathname === '/api/login' && request.method === 'POST') return login(request, env);
  if (!(await isAuthed(request, env))) return json({ error: '需要口令', status: '0', info: 'UNAUTHORIZED' }, 401);

  if (pathname === '/api/config' || pathname === '/api/sync') {
    const room = env.ROOM.get(env.ROOM.idFromName('main')); // 只有一个行程，所有人连同一个实例
    if (request.method === 'POST') {
      const body = await readJson(request, MAX_CONFIG_BYTES);
      if (!body.config || typeof body.config !== 'object') return json({ error: '配置格式不对' }, 400);
      return room.fetch(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }));
    }
    return room.fetch(request);
  }
  if (pathname === '/api/amap-batch' && request.method === 'POST') return amapBatch(request, env, url);
  if (pathname.startsWith('/api/amap/')) return proxyAmap(url, env);
  if (pathname === '/api/pages' && request.method === 'POST') {
    const { html } = await readJson(request, MAX_PAGE_BYTES);
    if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) return json({ error: '方案页内容不对' }, 400);
    const id = randomId();
    await env.DATA.put(`page:${id}`, html, { expirationTtl: PAGE_TTL_SECONDS });
    return json({ url: `/p/${id}`, file: `方案页 ${id}` });
  }
  return json({ error: 'not found' }, 404);
}

// 配置的唯一存放处：保存时检查版本号，防止互相覆盖；保存成功后推给所有在线的人。
export class ConfigRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 客户端心跳由运行时直接回复，不唤醒实例
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async load() {
    let state = await this.ctx.storage.get('state');
    if (!state) { // 第一次用：沿用以前存在 KV 里的配置
      state = { config: (await this.env.DATA.get('config', 'json')) || EMPTY_CONFIG, version: 1 };
      await this.ctx.storage.put('state', state);
    }
    return state;
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except);
  }

  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const ws of this.sockets(except)) {
      try { ws.send(text); } catch { /* 已断开的连接由 webSocketClose 清理 */ }
    }
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/api/sync') {
      if (request.headers.get('upgrade') !== 'websocket') return json({ error: '需要 WebSocket 连接' }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'hello', version: (await this.load()).version }));
      this.broadcast({ type: 'presence', online: this.sockets().length });
      return new Response(null, { status: 101, webSocket: client });
    }
    const state = await this.load();
    if (request.method === 'GET') return json({ config: state.config, version: state.version, file: '在线版' });
    const { config, base_version: base, client_id: clientId } = await request.json();
    if (base !== undefined && base !== state.version) {
      // 别人先保存了：把最新的给回去，由浏览器合并后再存
      return json({ error: '配置已被别人更新', conflict: true, config: state.config, version: state.version }, 409);
    }
    const next = { config, version: state.version + 1 };
    await this.ctx.storage.put('state', next);
    this.broadcast({ type: 'config', config, version: next.version, client_id: clientId });
    return json({ saved: '在线版', version: next.version });
  }

  webSocketMessage() { /* 客户端只发心跳，已由自动回复处理 */ }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* 已经关了 */ }
    this.broadcast({ type: 'presence', online: this.sockets(ws).length }, ws);
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011, 'error');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        return json({ error: err.message || String(err) }, 400);
      }
    }
    if (url.pathname.startsWith('/p/')) {
      // 方案页公开：链接里的随机 id 就是访问凭证，舍友不用口令
      const html = await env.DATA.get(`page:${url.pathname.slice(3)}`);
      if (!html) return new Response('方案页不存在或已过期', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=60', 'x-robots-tag': 'noindex' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
