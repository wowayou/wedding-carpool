// SPDX-License-Identifier: AGPL-3.0-or-later
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
    alarm: null,
    async get(k) { return structuredClone(map.get(k)); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { return map.delete(k); },
    async deleteAll() { map.clear(); },
    async setAlarm(t) { this.alarm = t; },
    async deleteAlarm() { this.alarm = null; },
  };
}

function fakeSocket() {
  let attachment = null;
  return {
    sent: [],
    closed: null,
    send(text) { this.sent.push(JSON.parse(text)); },
    close(code) { this.closed = code; },
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
      kv,
      async get(k) { return kv.has(k) ? kv.get(k).value : null; },
      async getWithMetadata(k) { return kv.has(k) ? { value: kv.get(k).value, metadata: kv.get(k).metadata ?? null } : { value: null, metadata: null }; },
      async put(k, value, opts = {}) { kv.set(k, { value, metadata: opts.metadata, expiration: opts.expiration }); },
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

const call = (path, { method = 'GET', body, cookie, ip = '1.1.1.1', form } = {}) => worker.fetch(new Request(`https://carpool.test${path}`, {
  method,
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
  headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
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

test('配额按接口类别分别停：搜索配额用完不影响测距和路线', async () => {
  const t = await newTrip();
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    const search = new URL(url).pathname.startsWith('/v5/place/');
    return new Response(JSON.stringify(search ? { status: '0', info: 'QUOTA_PLAN_RUN_OUT' } : { status: '1', info: 'OK' }));
  };
  upstream = [];
  const requests = [
    { path: '/v5/place/around', query: 'q=1' }, { path: '/v3/distance', query: 'q=2' }, { path: '/v5/place/text', query: 'q=3' },
    { path: '/v5/place/around', query: 'q=4' }, { path: '/v3/direction/driving', query: 'q=5' },
  ];
  const first = await (await call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie, body: { requests } })).json();
  assert.deepEqual(first.results.map((r) => r.info), ['QUOTA_PLAN_RUN_OUT', 'OK', 'QUOTA_PLAN_RUN_OUT', 'DAILY_QUERY_OVER_LIMIT', 'OK']);
  assert.match(first.results[3].error, /搜索配额/);
  assert.equal(upstream.length, 4); // 第一波 3 个里发现搜索配额用完，第二波只发路线，剩下的搜索不再发
  upstream = [];
  const again = await (await call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie,
    body: { requests: [{ path: '/v5/place/text', query: 'q=6' }, { path: '/v3/distance', query: 'q=7' }] } })).json();
  assert.deepEqual(again.results.map((r) => r.info), ['DAILY_QUERY_OVER_LIMIT', 'OK']);
  assert.deepEqual(upstream.map((u) => new URL(u).pathname), ['/v3/distance']);
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

const publish = (t, html) => call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html } }).then((r) => r.json());
const shareAction = (t, body) => call(`${t.base}/share`, { method: 'POST', cookie: t.cookie, body }).then((r) => r.json());

test('方案页：用自己的 id（不是行程 id），重新发布覆盖；v1 旧链接继续可用', async () => {
  const t = await newTrip();
  assert.equal((await call(`${t.base}/page`, { method: 'POST', cookie: t.cookie, body: { html: '<p>x</p>' } })).status, 400);
  const first = (await publish(t, '<!doctype html>第一版')).share;
  const second = (await publish(t, '<!doctype html>第二版')).share;
  assert.match(first.url, /^\/p\/[a-z2-9]{10}$/);
  assert.notEqual(first.url, `/p/${t.id}`);
  assert.equal(first.url, second.url);
  assert.match(await (await call(first.url)).text(), /第二版/);
  assert.equal((await (await call(`${t.base}/config`, { cookie: t.cookie })).json()).share.url, first.url);
  assert.ok(env.DATA.kv.get(`page:${first.url.slice(3)}`).expiration > Date.now() / 1000); // 跟着保留期过期
  await env.DATA.put('page:abcdefghijkm', '<!doctype html>旧版');
  assert.match(await (await call('/p/abcdefghijkm')).text(), /旧版/);
  assert.equal((await call('/p/nopenopeno')).status, 404);
  assert.equal((await call(`${t.base}/page`, { method: 'POST', body: { html: '<!doctype html>' } })).status, 401);
});

test('v3 之前发布过方案页的行程：沿用 /p/<行程 id>，重新发布更新同一个链接', async () => {
  const t = await newTrip();
  const storage = rooms.get(t.id).storage;
  const meta = await storage.get('meta');
  delete meta.shareId; delete meta.shareCode; delete meta.deadline; delete meta.invite; delete meta.tripLimit;
  meta.pageAt = Date.now() - 86400e3; // v2 的样子：发布过，方案页存在 page:<行程 id>，没有元数据和过期时间
  await storage.put('meta', meta);
  await env.DATA.put(`page:${t.id}`, '<!doctype html>v2 发布的');
  const cfg = await (await call(`${t.base}/config`, { cookie: t.cookie })).json();
  assert.equal(cfg.share.url, `/p/${t.id}`);
  assert.ok(cfg.expiresAt > Date.now());
  const { share } = await publish(t, '<!doctype html>v3 重新发布');
  assert.equal(share.url, `/p/${t.id}`);
  assert.match(await (await call(`/p/${t.id}`)).text(), /v3 重新发布/);
  assert.ok(env.DATA.kv.get(`page:${t.id}`).expiration > Date.now() / 1000);
  const moved = (await shareAction(t, { action: 'new-link' })).share.url; // 想和行程 id 分开，可以换链接
  assert.notEqual(moved, `/p/${t.id}`);
  assert.equal((await call(`/p/${t.id}`)).status, 404);
  assert.match(await (await call(moved)).text(), /v3 重新发布/);
});

const unpublished = async () => { // v2 时没发布过的行程：第一次发布用新的随机 id
  const t = await newTrip();
  const storage = rooms.get(t.id).storage;
  const meta = await storage.get('meta');
  delete meta.shareId;
  await storage.put('meta', meta);
  return t;
};

test('v3 之前没发布过的行程：第一次发布用单独的方案页 id', async () => {
  const t = await unpublished();
  assert.equal((await (await call(`${t.base}/config`, { cookie: t.cookie })).json()).share.url, null);
  const { share } = await publish(t, '<!doctype html>第一次');
  assert.match(share.url, /^\/p\/[a-z2-9]{10}$/);
  assert.notEqual(share.url, `/p/${t.id}`);
});

test('方案页访问口令：先要口令，对了才能看；试错有上限', async () => {
  const t = await newTrip();
  const { url } = (await publish(t, '<!doctype html>方案内容')).share;
  assert.equal((await shareAction(t, { action: 'code', code: '2468' })).share.code, '2468');
  const locked = await call(url);
  assert.equal(locked.status, 401);
  assert.doesNotMatch(await locked.text(), /方案内容/);
  assert.equal((await call(url, { method: 'POST', form: { code: '1111' } })).status, 401);
  const ok = await call(url, { method: 'POST', form: { code: '2468' } });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), new RegExp(`Path=${url}; HttpOnly; Secure`));
  assert.match(await (await call(url, { cookie })).text(), /方案内容/);
  for (let i = 0; i < 19; i++) await call(url, { method: 'POST', form: { code: String(i) } });
  assert.equal((await call(url, { method: 'POST', form: { code: '2468' } })).status, 429);
  await shareAction(t, { action: 'code', code: '' }); // 取消口令
  assert.equal((await call(url)).status, 200);
});

test('停止分享、换方案页链接', async () => {
  const t = await newTrip();
  const { url } = (await publish(t, '<!doctype html>方案')).share;
  const moved = (await shareAction(t, { action: 'new-link' })).share;
  assert.notEqual(moved.url, url);
  assert.equal((await call(url)).status, 404);
  assert.equal((await call(moved.url)).status, 200);
  const stopped = (await shareAction(t, { action: 'stop' })).share;
  assert.equal(stopped.url, null);
  assert.equal((await call(moved.url)).status, 404);
});

test('重置编辑链接：旧密钥和旧 Cookie 失效，除发起人外的实时连接断开', async () => {
  const t = await newTrip();
  const room = rooms.get(t.id);
  sockets.forEach((ws, i) => ws.serializeAttachment({ clientId: `c${i}`, name: `人${i}` }));
  const res = await call(`${t.base}/rotate-key`, { method: 'POST', cookie: t.cookie, body: { clientId: 'c0' } });
  const { key, url } = await res.json();
  assert.match(url, new RegExp(`^/t/${t.id}#k=${key}$`));
  assert.deepEqual(sockets.map((ws) => ws.closed), [null, 4001]);
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 401);
  assert.equal((await call(`${t.base}/session`, { method: 'POST', body: { key: t.key } })).status, 401);
  assert.equal((await call(`${t.base}/config`, { cookie: res.headers.get('set-cookie').split(';')[0] })).status, 200);
  assert.ok(room);
});

test('数据保留期：出行日期后 60 天和最后编辑后 180 天取较晚的；到期前顺延，到期后删除', async () => {
  const t = await newTrip();
  const room = rooms.get(t.id);
  await publish(t, '<!doctype html>方案');
  const day = 86400e3;
  assert.ok(Math.abs(room.ctx.storage.alarm - (Date.now() + 180 * day)) < 60e3); // 没填出行日期：按 180 天没人编辑
  await save(t, { config: { options: { travel_date: '2099-01-10' } }, base_version: 1 });
  const travel = Date.UTC(2099, 0, 10) - 8 * 3600e3;
  assert.equal(room.ctx.storage.alarm, travel + 60 * day);
  assert.equal((await (await call(`${t.base}/config`, { cookie: t.cookie })).json()).expiresAt, travel + 60 * day);
  await room.alarm(); // 还没到期：顺延，不删
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 200);
  const realNow = Date.now;
  Date.now = () => travel + 61 * day;
  try { await room.alarm(); } finally { Date.now = realNow; }
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 401);
  assert.equal([...env.DATA.kv.keys()].filter((k) => k.startsWith('page:')).length, 0);
  assert.equal(sockets[0].sent.at(-1).type, 'deleted');
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
  const { url } = (await publish(t, '<!doctype html>方案')).share;
  assert.equal((await call(`${t.base}/delete`, { method: 'POST' })).status, 401);
  assert.equal((await call(`${t.base}/delete`, { method: 'POST', cookie: t.cookie })).status, 200);
  assert.equal(sockets[0].sent.at(-1).type, 'deleted');
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 401);
  assert.equal((await call(url)).status, 404);
});

async function adminCookie() {
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { code: 'nope' } })).status, 401);
  const res = await call('/api/admin/login', { method: 'POST', body: { code: 'open-sesame' } });
  assert.match(res.headers.get('set-cookie'), /Path=\/api\/admin; HttpOnly; Secure; SameSite=Strict/);
  return res.headers.get('set-cookie').split(';')[0];
}
const createInvite = (cookie, body) => call('/api/admin/invites', { method: 'POST', cookie, body }).then((r) => r.json()).then((d) => d.invite);

test('管理页：没有站长口令不能看、不能发邀请码', async () => {
  assert.equal((await call('/api/admin/stats')).status, 401);
  assert.equal((await call('/api/admin/invites', { method: 'POST', body: {} })).status, 401);
  const cookie = await adminCookie();
  const stats = await (await call('/api/admin/stats', { cookie })).json();
  assert.deepEqual([stats.ownerUsedToday, stats.ownerLimit, stats.invites.length], [0, 4000, 0]);
});

test('邀请码：建行程有次数上限，口令不对或过期都拒绝', async () => {
  const cookie = await adminCookie();
  const inv = await createInvite(cookie, { note: '给小王', maxTrips: 2 });
  assert.match(inv.code, /^[a-z2-9]{8}$/);
  for (let i = 0; i < 2; i++) await newTrip({ name: `行程${i}`, code: inv.code.toUpperCase() }); // 大小写都行
  const full = await call('/api/trips', { method: 'POST', body: { code: inv.code } });
  assert.equal(full.status, 403);
  assert.match((await full.json()).error, /最多能建 2 个/);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'wrongcode' } })).status, 401);
  const old = await createInvite(cookie, { days: 1 });
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 86400e3;
  try { assert.match((await (await call('/api/trips', { method: 'POST', body: { code: old.code } })).json()).error, /过期/); }
  finally { Date.now = realNow; }
  const stats = await (await call('/api/admin/stats', { cookie })).json();
  assert.equal(stats.invites.find((x) => x.code === inv.code).trips.length, 2);
});

test('邀请码的每日上限、停用后不能再用公共额度', async () => {
  const cookie = await adminCookie();
  const inv = await createInvite(cookie, { maxTrips: 5, tripDailyLimit: 2 });
  const t = await newTrip({ name: '邀请来的', code: inv.code });
  const batch = (n, tag) => call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie,
    body: { requests: Array.from({ length: n }, (_, i) => ({ path: '/v3/distance', query: `${tag}=${i}` })) } }).then((r) => r.json());
  assert.deepEqual((await batch(3, 'a')).results.map((r) => r.info), ['OK', 'OK', 'TRIP_DAILY_LIMIT']);
  let stats = await (await call('/api/admin/stats', { cookie })).json();
  assert.equal(stats.invites[0].usedToday, 2);
  const t2 = await newTrip({ name: '邀请来的2', code: inv.code });
  await call(`/api/admin/invites/${inv.code}`, { method: 'POST', cookie, body: { active: false } });
  const off = await call(`${t2.base}/amap/v3/distance?b=1`, { cookie: t2.cookie }).then((r) => r.json());
  assert.equal(off.info, 'INVITE_DISABLED');
  assert.match(off.error, /自己的高德 Key/);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: inv.code } })).status, 403);
  stats = await (await call('/api/admin/stats', { cookie })).json();
  assert.equal(stats.invites[0].active, false);
});

test('公共额度用过八成后，当天还没用过的行程暂停分配，已经在算的继续', async () => {
  env.OWNER_DAILY_LIMIT = '10';
  const running = await newTrip({ name: '在算的', code: 'open-sesame' });
  const later = await newTrip({ name: '后来的', code: 'open-sesame' });
  const batch = (t, n, tag) => call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie,
    body: { requests: Array.from({ length: n }, (_, i) => ({ path: '/v3/distance', query: `${tag}=${i}` })) } }).then((r) => r.json());
  await batch(running, 8, 'r'); // 用到 80%
  const reserved = (await batch(later, 1, 'l')).results[0];
  assert.equal(reserved.info, 'OWNER_RESERVED');
  assert.deepEqual((await batch(running, 3, 's')).results.map((r) => r.info), ['OK', 'OK', 'OWNER_DAILY_LIMIT']);
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
