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
const CREATE_PER_DAY = 200;
// 成功结果在 Cloudflare 节点上缓存：地点类变化慢，行车时间和路线跟路况走，缓存短一些
const CACHE_SECONDS = { '/v3/distance': 1200, '/v3/direction/driving': 1200, '/v3/direction/transit/integrated': 3600 };
const BATCH_LIMIT = 40; // 免费套餐单次请求最多 50 个子请求
const AMAP_QPS = 3; // 高德个人 Key 的每秒调用上限按 3 算
const QUOTA_RE = /DAILY_QUERY_OVER_LIMIT|QUOTA_PLAN_RUN_OUT|SERVICE_EXPIRED/;
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
  if (body.code) {
    if (!env.ACCESS_CODE || body.code !== env.ACCESS_CODE) {
      await sleep(800); // 拖慢猜口令
      return json({ error: '创建口令不对' }, 401);
    }
    mode = 'owner';
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
  await roomOf(env, id).fetch(internal('/init', { id, name, mode, amapKey, keyHash: await sha256(key) }));
  return json({ id, key, url: `/t/${id}#k=${key}` });
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
  if (sub === '/page' && request.method === 'POST') return publishPage(request, env, url, room, key, id);
  if (sub === '/key' && request.method === 'POST') { // 改用自己的高德 Key：公共额度用完时可以接着算
    const amapKey = String((await readJson(request, 1024)).amapKey || '').trim();
    const problem = await amapKeyProblem(amapKey);
    if (problem) return json({ error: problem }, 400);
    return room.fetch(internal('/set-key', { amapKey }, key));
  }
  if (sub === '/delete' && request.method === 'POST') {
    const res = await room.fetch(internal('/delete', {}, key));
    if (res.ok) await env.DATA.delete(`page:${id}`);
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

async function publishPage(request, env, url, room, key, id) {
  const { html } = await readJson(request, MAX_PAGE_BYTES);
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) return json({ error: '方案页内容不对' }, 400);
  const res = await room.fetch(internal('/published', {}, key)); // 先鉴权并记下发布时间
  if (!res.ok) return res;
  await env.DATA.put(`page:${id}`, html);
  return json({ url: `/p/${id}`, ...(await res.json()) });
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

async function fetchAmap(origin, item, apiKey, quotaKey, env) {
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
  const { mode, amapKey, granted: tripGranted, limit: tripLimit } = await grant.json();
  let granted = tripGranted;
  let limitError = { status: '0', info: 'TRIP_DAILY_LIMIT', error: `这个行程今天的高德调用已到上限（${tripLimit} 次），明天再试` };
  if (mode === 'owner' && granted) {
    const ownerLimit = limitOf(env, 'OWNER_DAILY_LIMIT', DEFAULT_OWNER_DAILY_LIMIT);
    const res = await usageOf(env).fetch(internal('/owner-take', { n: granted, limit: ownerLimit }));
    const ownerGranted = (await res.json()).granted;
    if (ownerGranted < granted) {
      limitError = { status: '0', info: 'OWNER_DAILY_LIMIT', error: '站点今天共用的高德额度已用完。明天再试，或者新建行程时填自己的高德 Key' };
    }
    granted = ownerGranted;
  }
  const apiKey = mode === 'own' ? amapKey : env.AMAP_KEY;
  const quotaKey = `amap_quota_until:${(await sha256(apiKey || '')).slice(0, 16)}`; // 按 Key 记，互不影响
  const blocked = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003', error: '高德今日配额已用完，北京时间零点前不再调用' };
  if (misses.length && Date.now() < (Number(await env.DATA.get(quotaKey)) || 0)) {
    for (const i of misses) results[i] = blocked;
  } else {
    for (const i of misses.slice(granted)) results[i] = limitError;
    // 没命中缓存的按每秒 AMAP_QPS 个发；被限流的等一会儿再试一次
    let todo = misses.slice(0, granted);
    for (const round of [0, 1]) {
      if (round) {
        todo = todo.filter((i) => QPS_RE.test(String(results[i].info || '')));
        if (todo.length) await sleep(1000);
      }
      for (let k = 0; k < todo.length; k += AMAP_QPS) {
        const started = Date.now();
        const wave = todo.slice(k, k + AMAP_QPS);
        const out = await Promise.all(wave.map((i) => fetchAmap(url.origin, items[i], apiKey, quotaKey, env)));
        wave.forEach((i, j) => { results[i] = out[j]; });
        if (out.some((d) => QUOTA_RE.test(String(d.info || '')))) { // 配额用完：剩下的不再请求
          for (const i of todo.slice(k + AMAP_QPS)) results[i] = blocked;
          todo = [];
          break;
        }
        if (k + AMAP_QPS < todo.length) await sleep(Math.max(0, 1000 - (Date.now() - started)));
      }
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
      meta.pageAt = Date.now();
      await this.storage.put('meta', meta);
      this.broadcast({ type: 'page', at: meta.pageAt });
      return json({ at: meta.pageAt });
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
      await this.storage.deleteAll(); // 配置、历史、用量都清掉；实例没有数据后由平台回收
      return json({ deleted: true });
    }
    return json({ error: 'not found' }, 404);
  }

  async init({ id, name, mode, amapKey, keyHash }) {
    if (await this.storage.get('meta')) return json({ error: '行程已存在' }, 409);
    const now = Date.now();
    await this.storage.put('meta', { id, name, mode, amapKey, keyHash, createdAt: now, pageAt: null });
    await this.storage.put('state', { config: structuredClone(EMPTY_CONFIG), version: 1, at: now, author: '' });
    return json({ ok: true });
  }

  async read(meta) {
    const state = await this.storage.get('state');
    const usage = await this.storage.get('usage');
    return json({
      config: state.config, version: state.version, author: state.author, at: state.at,
      name: meta.name, mode: meta.mode, page: meta.pageAt ? { url: `/p/${meta.id}`, at: meta.pageAt } : null,
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
    return next;
  }

  async rename(meta, { name }) {
    meta.name = String(name || '').trim().slice(0, 60) || meta.name;
    await this.storage.put('meta', meta);
    this.broadcast({ type: 'meta', name: meta.name });
    return json({ name: meta.name });
  }

  async take(meta, { n = 0, limit, ownLimit }) {
    if (meta.mode === 'own') limit = ownLimit;
    const today = beijingDay();
    const usage = await this.storage.get('usage');
    const used = usage?.day === today ? usage.count : 0;
    const granted = Math.max(0, Math.min(Number(n) || 0, limit - used));
    if (granted) await this.storage.put('usage', { day: today, count: used + granted });
    return json({ mode: meta.mode, amapKey: meta.mode === 'own' ? meta.amapKey : null, granted, limit, used: used + granted });
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
    if (path === '/owner-take') {
      const saved = (await this.ctx.storage.get('owner')) || {};
      const used = saved.day === today ? saved.count : 0;
      const granted = Math.max(0, Math.min(Number(body.n) || 0, body.limit - used));
      if (granted) await this.ctx.storage.put('owner', { day: today, count: used + granted });
      return json({ granted, used: used + granted });
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
      const trip = pathname.match(/^\/api\/t\/([a-z2-9]+)(\/.*)$/);
      if (trip) return ID_RE.test(trip[1]) ? await tripApi(request, env, url, trip[1], trip[2]) : json({ error: '行程不存在' }, 404);
      if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      const page = pathname.match(/^\/p\/([a-z2-9]{10,12})$/);
      if (page) {
        // 方案页公开：链接本身就是访问凭证。10 位是行程的固定链接，12 位是旧版单独发布的链接
        const html = await env.DATA.get(`page:${page[1]}`);
        if (!html) return new Response('方案页不存在，可能还没发布', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-robots-tag': 'noindex' },
        });
      }
      if (/^\/t\/[a-z2-9]{10}\/?$/.test(pathname)) return env.ASSETS.fetch(new Request(new URL('/edit', url)));
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },
};
