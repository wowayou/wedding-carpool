// Worker 的离线测试：内存版 KV / Durable Object + 假的 fetch，不连 Cloudflare 和高德。运行：npm test
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker, { ConfigRoom, Usage } from './worker.js';

const OWN_KEY = 'a'.repeat(32);
let env, upstream, rooms, sockets;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return structuredClone(map.get(k)); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { return map.delete(k); },
    async deleteAll() { map.clear(); },
  };
}

function fakeSocket() {
  let attachment = null;
  return {
    sent: [],
    send(text) { this.sent.push(JSON.parse(text)); },
    close() {},
    serializeAttachment(v) { attachment = structuredClone(v); },
    deserializeAttachment() { return structuredClone(attachment); },
  };
}

beforeEach(() => {
  const kv = new Map();
  rooms = new Map();
  sockets = [fakeSocket(), fakeSocket()];
  const usage = new Usage({ storage: memoryStorage() });
  env = {
    AMAP_KEY: 'server-key',
    ACCESS_CODE: 'open-sesame',
    DATA: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
    ROOM: {
      idFromName: (name) => name,
      get: (id) => {
        if (!rooms.has(id)) {
          rooms.set(id, new ConfigRoom({ storage: memoryStorage(), getWebSockets: () => sockets, acceptWebSocket() {} }, env));
        }
        return rooms.get(id);
      },
    },
    USAGE: { idFromName: (n) => n, get: () => usage },
  };
  upstream = [];
  globalThis.nextAmapReply = null;
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response(JSON.stringify(globalThis.nextAmapReply || { status: '1', info: 'OK' }));
  };
});

const call = (path, { method = 'GET', body, cookie, ip = '1.1.1.1' } = {}) => worker.fetch(new Request(`https://carpool.test${path}`, {
  method, body: body && JSON.stringify(body), headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
}), env);

async function newTrip(body = { name: '测试行程', code: 'open-sesame' }) {
  const res = await call('/api/trips', { method: 'POST', body });
  assert.equal(res.status, 200, await res.clone().text());
  const trip = await res.json();
  const session = await call(`/api/t/${trip.id}/session`, { method: 'POST', body: { key: trip.key } });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`Path=/api/t/${trip.id}; HttpOnly; Secure; SameSite=Lax`));
  return { ...trip, cookie: cookie.split(';')[0], base: `/api/t/${trip.id}` };
}

const save = (t, body) => call(`${t.base}/config`, { method: 'POST', cookie: t.cookie, body });

test('新建行程：口令、自带 Key、什么都不填', async () => {
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'guess' } })).status, 401);
  assert.equal((await call('/api/trips', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('/api/trips', { method: 'POST', body: { amapKey: 'short' } })).status, 400);
  globalThis.nextAmapReply = { status: '0', info: 'INVALID_USER_KEY' };
  assert.match((await (await call('/api/trips', { method: 'POST', body: { amapKey: OWN_KEY } })).json()).error, /INVALID_USER_KEY/);
  globalThis.nextAmapReply = null;
  const own = await newTrip({ name: '自带', amapKey: OWN_KEY });
  const owner = await newTrip();
  assert.match(owner.url, /^\/t\/[a-z2-9]{10}#k=[a-z2-9]{24}$/);
  assert.equal((await (await call(`${own.base}/config`, { cookie: own.cookie })).json()).mode, 'own');
  assert.equal((await (await call(`${owner.base}/config`, { cookie: owner.cookie })).json()).name, '测试行程');
});

test('同一 IP 每天新建次数有上限', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'open-sesame' } })).status, 200);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'open-sesame' } })).status, 429);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'open-sesame' }, ip: '2.2.2.2' })).status, 200);
});

test('没有编辑链接不能访问行程，换行程的 Cookie 也不行', async () => {
  const a = await newTrip(), b = await newTrip();
  assert.equal((await call(`${a.base}/config`)).status, 401);
  assert.equal((await call(`${a.base}/session`, { method: 'POST', body: { key: 'wrong' } })).status, 401);
  assert.equal((await call(`${a.base}/config`, { cookie: b.cookie.replace(b.id, a.id) })).status, 401);
  assert.equal((await call('/api/t/nope/config')).status, 404);
  assert.equal(upstream.length, 0);
});

test('保存检查版本号，冲突时返回最新配置和作者', async () => {
  const t = await newTrip();
  assert.equal((await (await save(t, { config: { people: [{ name: '老王' }] }, base_version: 1, author: '甲' })).json()).version, 2);
  const res = await save(t, { config: { people: [] }, base_version: 1, author: '乙' });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.deepEqual([data.version, data.author, data.config.people[0].name], [2, '甲', '老王']);
  assert.deepEqual(sockets[0].sent.at(-1), { type: 'config', config: { people: [{ name: '老王' }] }, version: 2, author: '甲' });
});

test('历史版本：同一人连续保存合并，换人另起一条，可以查看和恢复', async () => {
  const t = await newTrip();
  await save(t, { config: { v: 'a' }, base_version: 1, author: '甲', note: '改了目的地' });
  await save(t, { config: { v: 'b' }, base_version: 2, author: '甲', note: '加了老王' });
  await save(t, { config: { v: 'c' }, base_version: 3, author: '乙', note: '改了座位' });
  let { history } = await (await call(`${t.base}/history`, { cookie: t.cookie })).json();
  assert.deepEqual(history.map((h) => [h.version, h.author, h.notes]), [[4, '乙', ['改了座位']], [3, '甲', ['改了目的地', '加了老王']]]);
  assert.equal((await (await call(`${t.base}/history/3`, { cookie: t.cookie })).json()).config.v, 'b');
  assert.equal((await call(`${t.base}/history/2`, { cookie: t.cookie })).status, 404); // 被合并掉的中间版本
  const restored = await (await call(`${t.base}/restore`, { method: 'POST', cookie: t.cookie, body: { version: 3, author: '乙' } })).json();
  assert.deepEqual([restored.version, restored.config.v], [5, 'b']);
  ({ history } = await (await call(`${t.base}/history`, { cookie: t.cookie })).json());
  assert.equal(history[0].restore, true);
  assert.equal(sockets[1].sent.at(-1).restored, 3);
});

test('高德代理：只放行白名单，按行程用对应的 Key', async () => {
  const owner = await newTrip(), own = await newTrip({ amapKey: OWN_KEY });
  upstream = [];
  assert.equal((await call(`${owner.base}/amap/v3/ip`, { cookie: owner.cookie })).status, 403);
  await call(`${owner.base}/amap/v3/distance?origins=1,1&key=client-key`, { cookie: owner.cookie });
  await call(`${own.base}/amap-batch`, { method: 'POST', cookie: own.cookie, body: { requests: [{ path: '/v3/distance', query: 'a=1' }] } });
  assert.deepEqual(upstream.map((u) => new URL(u).searchParams.getAll('key').join()), ['server-key', OWN_KEY]);
  assert.equal((await call(`${owner.base}/amap/v3/distance`)).status, 401);
});

test('行程每日上限和站长 Key 全站上限', async () => {
  env.TRIP_DAILY_LIMIT = '2';
  env.OWNER_DAILY_LIMIT = '3';
  const a = await newTrip(), b = await newTrip(), own = await newTrip({ amapKey: OWN_KEY });
  const batch = (t, n, tag) => call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie,
    body: { requests: Array.from({ length: n }, (_, i) => ({ path: '/v3/distance', query: `${tag}=${i}` })) } }).then((r) => r.json());
  assert.deepEqual((await batch(a, 3, 'a')).results.map((r) => r.info), ['OK', 'OK', 'TRIP_DAILY_LIMIT']);
  assert.deepEqual((await batch(b, 2, 'b')).results.map((r) => r.info), ['OK', 'OWNER_DAILY_LIMIT']);
  assert.deepEqual((await batch(own, 3, 'c')).results.map((r) => r.info), ['OK', 'OK', 'OK']); // 自带 Key 不占站长额度，也不受行程上限 2 的限制
  assert.equal((await (await call(`${a.base}/config`, { cookie: a.cookie })).json()).usage, 2);
});

test('配额用完按 Key 分别停：站长 Key 用完不影响自带 Key 的行程', async () => {
  const owner = await newTrip(), own = await newTrip({ amapKey: OWN_KEY });
  globalThis.nextAmapReply = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT' };
  await call(`${owner.base}/amap/v3/distance?a=1`, { cookie: owner.cookie });
  globalThis.nextAmapReply = null;
  upstream = [];
  assert.equal((await (await call(`${owner.base}/amap/v3/distance?a=2`, { cookie: owner.cookie })).json()).info, 'DAILY_QUERY_OVER_LIMIT');
  assert.equal(upstream.length, 0);
  assert.equal((await (await call(`${own.base}/amap/v3/distance?a=3`, { cookie: own.cookie })).json()).info, 'OK');
});

test('批量里被限流的等一下再试一次', async () => {
  const t = await newTrip();
  let calls = 0;
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? { status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' } : { status: '1', info: 'OK' }));
  };
  const data = await (await call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie,
    body: { requests: [{ path: '/v3/distance', query: 'a=1' }, { path: '/v3/distance', query: 'a=2' }] } })).json();
  assert.deepEqual(data.results.map((r) => r.status), ['1', '1']);
});

test('方案页：每个行程一个固定链接，重新发布覆盖；旧链接继续可用', async () => {
  const t = await newTrip();
  assert.equal((await call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html: '<p>x</p>' } })).status, 400);
  const first = await (await call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html: '<!doctype html>第一版' } })).json();
  await call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html: '<!doctype html>第二版' } });
  assert.equal(first.url, `/p/${t.id}`);
  assert.match(await (await call(first.url)).text(), /第二版/);
  assert.equal((await (await call(`${t.base}/config`, { cookie: t.cookie })).json()).page.url, first.url);
  await env.DATA.put('page:abcdefghijkm', '<!doctype html>旧版');
  assert.match(await (await call('/p/abcdefghijkm')).text(), /旧版/);
  assert.equal((await call('/p/nopenopeno')).status, 404);
  assert.equal((await call(`${t.base}/page`, { method: 'POST', body: { html: '<!doctype html>' } })).status, 401);
});

test('在线名单和正在编辑的格子', async () => {
  const t = await newTrip();
  const room = rooms.get(t.id);
  sockets.forEach((ws) => ws.serializeAttachment({}));
  room.webSocketMessage(sockets[0], JSON.stringify({ type: 'join', clientId: 'c1', name: '老王' }));
  room.webSocketMessage(sockets[1], JSON.stringify({ type: 'join', clientId: 'c2', name: '小陈' }));
  room.webSocketMessage(sockets[1], JSON.stringify({ type: 'focus', path: 'people.0.car_seats' }));
  assert.deepEqual(sockets[0].sent.at(-1).people, [
    { clientId: 'c1', name: '老王', focus: null }, { clientId: 'c2', name: '小陈', focus: 'people.0.car_seats' },
  ]);
  room.webSocketClose(sockets[0], 1000, 'bye');
  assert.deepEqual(sockets[1].sent.at(-1).people.map((p) => p.name), ['小陈']);
  room.webSocketMessage(sockets[1], 'not json'); // 乱发的消息忽略
});

test('额度用完后改用自己的 Key：校验 Key、重置用量、之后走新 Key', async () => {
  env.TRIP_DAILY_LIMIT = '1';
  const t = await newTrip();
  const one = (q) => call(`${t.base}/amap/v3/distance?${q}`, { cookie: t.cookie }).then((r) => r.json());
  await one('a=1');
  assert.equal((await one('a=2')).info, 'TRIP_DAILY_LIMIT');
  assert.equal((await call(`${t.base}/key`, { method: 'POST', cookie: t.cookie, body: { amapKey: 'bad' } })).status, 400);
  assert.equal((await call(`${t.base}/key`, { method: 'POST', body: { amapKey: OWN_KEY } })).status, 401);
  assert.equal((await (await call(`${t.base}/key`, { method: 'POST', cookie: t.cookie, body: { amapKey: OWN_KEY } })).json()).mode, 'own');
  assert.equal(sockets[0].sent.at(-1).mode, 'own');
  upstream = [];
  assert.equal((await one('a=3')).info, 'OK');
  assert.equal(new URL(upstream.at(-1)).searchParams.get('key'), OWN_KEY);
});

test('删除行程：数据和方案页都清掉，之后链接失效', async () => {
  const t = await newTrip();
  await call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html: '<!doctype html>方案' } });
  assert.equal((await call(`${t.base}/delete`, { method: 'POST' })).status, 401);
  assert.equal((await call(`${t.base}/delete`, { method: 'POST', cookie: t.cookie })).status, 200);
  assert.equal(sockets[0].sent.at(-1).type, 'deleted');
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 401);
  assert.equal((await call(`/p/${t.id}`)).status, 404);
});

test('WebSocket 只接受本站来源', async () => {
  const t = await newTrip();
  const ws = (origin) => worker.fetch(new Request(`https://carpool.test${t.base}/sync`, {
    headers: { cookie: t.cookie, upgrade: 'websocket', origin },
  }), env);
  assert.equal((await ws('https://evil.example')).status, 403);
});

test('页面路由：首页、行程编辑页', async () => {
  assert.equal(await (await call('/')).text(), 'asset:/');
  assert.equal(await (await call('/t/abcdefghij')).text(), 'asset:/edit');
  assert.deepEqual(await (await call('/api/env')).json(), { mode: 'online', ownerKey: true });
});
