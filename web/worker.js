// 婚礼拼车的 Cloudflare Worker：口令登录、高德接口代理、配置和方案页存储。
// 计算本身在浏览器里跑（Pyodide，见 web/pyworker.js），这里不做重活。
//
// 绑定：DATA（KV）、ASSETS（静态文件 dist/）；密钥：AMAP_KEY、ACCESS_CODE。

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

async function proxyAmap(url, env) {
  const path = url.pathname.slice('/api/amap'.length);
  if (!AMAP_PATHS.has(path)) return json({ status: '0', info: 'PATH_NOT_ALLOWED' }, 403);
  const blockedUntil = Number(await env.DATA.get(QUOTA_KEY)) || 0;
  if (Date.now() < blockedUntil) {
    return json({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003',
      error: '高德今日配额已用完，北京时间零点前不再调用' }, 429);
  }
  const target = new URL(`https://restapi.amap.com${path}`);
  for (const [k, v] of url.searchParams) if (k !== 'key') target.searchParams.append(k, v);
  target.searchParams.set('key', env.AMAP_KEY);
  try {
    const res = await fetch(target);
    const text = await res.text();
    let info = '';
    try { info = String(JSON.parse(text).info || ''); } catch { /* 非 JSON 原样返回 */ }
    if (QUOTA_RE.test(info)) await env.DATA.put(QUOTA_KEY, String(nextBeijingMidnight()));
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (err) {
    return json({ error: `连不上高德：${err.message}` }, 502);
  }
}

async function api(request, env, url) {
  const { pathname } = url;
  if (pathname === '/api/env') return json({ mode: 'online' });
  if (pathname === '/api/login' && request.method === 'POST') return login(request, env);
  if (!(await isAuthed(request, env))) return json({ error: '需要口令', status: '0', info: 'UNAUTHORIZED' }, 401);

  if (pathname === '/api/config') {
    if (request.method === 'GET') return json({ config: (await env.DATA.get('config', 'json')) || EMPTY_CONFIG, file: '在线版' });
    if (request.method === 'POST') {
      const { config } = await readJson(request, MAX_CONFIG_BYTES);
      if (!config || typeof config !== 'object') return json({ error: '配置格式不对' }, 400);
      await env.DATA.put('config', JSON.stringify(config));
      return json({ saved: '在线版' });
    }
  }
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
