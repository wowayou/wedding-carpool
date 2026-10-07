// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker 的离线测试：内存版 KV / Durable Object + 假的 fetch，不连 Cloudflare 和高德。运行：npm test
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import pkg from '../package.json' with { type: 'json' };
import worker, { ConfigRoom, Usage } from './worker.js';

const OWN_KEY = 'a'.repeat(32);
let env, upstream, rooms, sockets, sharedInvite;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    alarm: null,
    async get(k) { return structuredClone(map.get(k)); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { return Array.isArray(k) ? k.filter((x) => map.delete(x)).length : map.delete(k); },
    async list({ prefix = '' } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)])); },
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
  background = [];
  sharedInvite = null;
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

// 后台任务（ctx.waitUntil）：测试里收集起来，需要时用 settle() 等它们写完
let background = [];
const settle = async () => { await Promise.all(background); background = []; };
const ctx = { waitUntil: (p) => { background.push(p); } };

const call = (path, { method = 'GET', body, cookie, ip = '1.1.1.1', form, origin, headers } = {}) => worker.fetch(new Request(`https://carpool.test${path}`, {
  method,
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
  headers: { 'cf-connecting-ip': ip, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
}), env, ctx);

// 站长口令不能当邀请码：用公共额度的测试行程都用一个管理页发的邀请码来建
async function ownerInvite() {
  sharedInvite ||= (await createInvite(await adminCookie(), { maxTrips: 1000 })).code;
  return sharedInvite;
}

async function newTrip(body = {}) {
  body = { name: '测试行程', ...body };
  if (!body.amapKey && !body.code) body.code = await ownerInvite();
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
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: 'open-sesame' } })).status, 401); // 站长口令不是邀请码
  assert.equal(upstream.length, 0);
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
  const code = await ownerInvite();
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/trips', { method: 'POST', body: { code } })).status, 200);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code } })).status, 429);
  assert.equal((await call('/api/trips', { method: 'POST', body: { code }, ip: '2.2.2.2' })).status, 200);
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

test('方案页放进沙箱：不和本站同源，不能发请求、不能提交表单', async () => {
  const t = await newTrip();
  const { url } = (await publish(t, '<!doctype html><script>localStorage.x</script>')).share;
  const csp = (await call(url)).headers.get('content-security-policy');
  assert.match(csp, /^sandbox allow-scripts /);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
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
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 404);
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
  const gone = await call(`${t.base}/config`, { cookie: t.cookie });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).info, 'TRIP_GONE'); // 和密钥不对（UNAUTHORIZED）区分开
  assert.equal((await call(url)).status, 404);
});

async function adminCookie() {
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
  const running = await newTrip({ name: '在算的' });
  const later = await newTrip({ name: '后来的' });
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
  assert.deepEqual(await (await call('/api/env')).json(), { mode: 'online', ownerKey: true, version: pkg.version });
});

// ---------- v3.1：编辑口令、管理会话、应急开关、按类别的额度、公开状态 ----------

// 失败路径里 Worker 会故意拖慢（防猜口令）；要连试很多次的测试里把等待跳过
async function withoutDelay(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f) => real(f, 0);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
const setEditCode = (t, code, cookie = t.cookie, clientId = 'c0') => call(`${t.base}/edit-code`, { method: 'POST', cookie, body: { code, client_id: clientId } });
const session = (t, code) => call(`${t.base}/session`, { method: 'POST', body: { key: t.key, code } });
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

test('编辑口令：设置后新设备要输口令，其他在线连接被请出，错误和缺失都拒绝', async () => {
  const t = await newTrip();
  sockets.forEach((ws, i) => ws.serializeAttachment({ clientId: `c${i}`, name: `人${i}` }));
  assert.equal((await setEditCode(t, 'abc')).status, 400); // 太短
  assert.equal((await setEditCode(t, 'x'.repeat(21))).status, 400); // 太长
  assert.equal((await call(`${t.base}/edit-code`, { method: 'POST', body: { code: 'secret1' } })).status, 401); // 没有会话
  assert.deepEqual(sockets.map((ws) => ws.closed), [null, null]);
  const set = await setEditCode(t, 'secret1');
  assert.equal(set.status, 200);
  assert.deepEqual(sockets.map((ws) => ws.closed), [null, 4003]); // 发起人不断开
  assert.match(set.headers.get('set-cookie'), new RegExp(`^tc_${t.id}=[0-9a-f]{64}; Path=/api/t/${t.id}; HttpOnly; Secure; SameSite=Lax`));
  const mine = `${t.cookie}; ${set.headers.get('set-cookie').split(';')[0]}`;
  assert.equal((await call(`${t.base}/config`, { cookie: mine })).status, 200);
  assert.equal((await (await call(`${t.base}/config`, { cookie: mine })).json()).editCode, true);
  // 另一台设备只有编辑密钥的 Cookie：所有需要鉴权的路径都进不去，包括实时连接
  for (const path of ['/config', '/history', '/amap/v3/distance?a=1']) {
    const res = await call(`${t.base}${path}`, { cookie: t.cookie });
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).info, 'EDIT_CODE_REQUIRED');
  }
  assert.equal((await call(`${t.base}/sync`, { cookie: t.cookie })).status, 401);
  assert.equal((await call(`${t.base}/delete`, { method: 'POST', cookie: t.cookie })).status, 401);
  assert.equal(upstream.length, 0);
  // 客户端自己带内部请求头没用
  const forged = await worker.fetch(new Request(`https://carpool.test${t.base}/config`, { headers: { cookie: t.cookie, 'x-trip-code': 'x' } }), env);
  assert.equal(forged.status, 401);
  // 换会话：没带、带错、带对
  const none = await session(t);
  assert.deepEqual([none.status, (await none.json()).info], [401, 'EDIT_CODE_REQUIRED']);
  const wrong = await withoutDelay(() => session(t, 'secret2'));
  assert.deepEqual([wrong.status, (await wrong.json()).info], [401, 'EDIT_CODE_WRONG']);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const ok = await session(t, ' secret1 ');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.getSetCookie().length, 2);
  assert.equal((await call(`${t.base}/config`, { cookie: cookiesOf(ok) })).status, 200);
  assert.equal(sockets[0].closed, null);
  // 换口令：之前的 Cookie 失效；重置编辑链接不影响口令
  const renewed = await setEditCode(t, 'secret3', cookiesOf(ok));
  assert.equal((await call(`${t.base}/config`, { cookie: cookiesOf(ok) })).status, 401);
  const rotated = await call(`${t.base}/rotate-key`, { method: 'POST', cookie: `${t.cookie}; ${renewed.headers.get('set-cookie').split(';')[0]}`, body: { clientId: 'c0' } });
  const next = await rotated.json();
  const again = await call(`${t.base}/session`, { method: 'POST', body: { key: next.key } });
  assert.equal((await again.json()).info, 'EDIT_CODE_REQUIRED');
  assert.equal((await call(`${t.base}/session`, { method: 'POST', body: { key: next.key, code: 'secret3' } })).status, 200);
});

test('编辑口令：清除后只凭编辑链接就能打开，不再断开其他人', async () => {
  const t = await newTrip();
  sockets.forEach((ws, i) => ws.serializeAttachment({ clientId: `c${i}` }));
  const mine = `${t.cookie}; ${(await setEditCode(t, 'secret1')).headers.get('set-cookie').split(';')[0]}`;
  sockets.forEach((ws) => { ws.closed = null; });
  const cleared = await setEditCode(t, '', mine);
  assert.equal(cleared.status, 200);
  assert.match(cleared.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(sockets.map((ws) => ws.closed), [null, null]);
  assert.equal((await call(`${t.base}/config`, { cookie: t.cookie })).status, 200);
  assert.equal((await session(t)).status, 200);
  assert.equal((await (await call(`${t.base}/config`, { cookie: t.cookie })).json()).editCode, false);
});

test('编辑口令：每个行程每小时最多试错 10 次，下个小时恢复', async () => {
  const t = await newTrip();
  await setEditCode(t, 'secret1');
  await withoutDelay(async () => {
    for (let i = 0; i < 10; i++) assert.equal((await session(t, `bad${i}`)).status, 401);
    const blocked = await session(t, 'secret1'); // 超限后连对的也不收
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).info, 'TOO_MANY_TRIES');
    const realNow = Date.now;
    Date.now = () => realNow() + 3600e3;
    try { assert.equal((await session(t, 'secret1')).status, 200); } finally { Date.now = realNow; }
  });
  const other = await newTrip(); // 别的行程不受影响
  await setEditCode(other, 'secret1');
  assert.equal((await session(other, 'secret1')).status, 200);
});

test('编辑口令：没有编辑密钥的人试口令不计次数，也问不出口令是否存在', async () => {
  const t = await newTrip();
  await setEditCode(t, 'secret1');
  const res = await withoutDelay(() => call(`${t.base}/session`, { method: 'POST', body: { key: 'wrong-key', code: 'secret1' } }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).info, 'UNAUTHORIZED');
  assert.equal((await session(t, 'secret1')).status, 200);
});

test('管理会话：随机令牌、24 小时过期、退出所有会话（包括自己的）', async () => {
  const first = await adminCookie(), second = await adminCookie();
  const token = first.slice('adm='.length);
  assert.match(token, /^[a-z2-9]{32}$/);
  assert.notEqual(first, second);
  const login = await call('/api/admin/login', { method: 'POST', body: { code: 'open-sesame' } });
  assert.match(login.headers.get('set-cookie'), /Max-Age=86400/);
  // 老办法（口令的哈希当 Cookie）不再有效
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('admin:open-sesame'));
  const old = `adm=${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  assert.equal((await call('/api/admin/stats', { cookie: old })).status, 401);
  assert.equal((await call('/api/admin/stats', { cookie: 'adm=' })).status, 401);
  // 过期
  const realNow = Date.now;
  Date.now = () => realNow() + 86400e3 + 1000;
  try { assert.equal((await call('/api/admin/stats', { cookie: first })).status, 401); } finally { Date.now = realNow; }
  assert.equal((await call('/api/admin/stats', { cookie: first })).status, 200);
  // 退出所有会话
  const out = await call('/api/admin/logout-all', { method: 'POST', cookie: first });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  for (const cookie of [first, second]) assert.equal((await call('/api/admin/stats', { cookie })).status, 401);
  assert.equal((await call('/api/admin/logout-all', { method: 'POST' })).status, 401);
  const fresh = await adminCookie();
  const stats = await (await call('/api/admin/stats', { cookie: fresh })).json();
  assert.ok(stats.ops.some((o) => o.op === '退出所有管理会话'));
});

test('管理登录限次：同一 IP 15 分钟 5 次，全站每小时 30 次；超限后口令对也不收', async () => {
  const bad = (ip, code = 'nope') => call('/api/admin/login', { method: 'POST', body: { code }, ip });
  await withoutDelay(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await bad('9.9.9.9')).status, 401);
    const blocked = await bad('9.9.9.9', 'open-sesame');
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /试错太多/);
    assert.equal((await bad('8.8.8.8', 'open-sesame')).status, 200); // 别的 IP 不受影响
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60e3;
    try { assert.equal((await bad('9.9.9.9', 'open-sesame')).status, 200); } finally { Date.now = realNow; } // 15 分钟后恢复
    // 全站总数：现有 5 次，再来 25 次凑满 30
    for (let i = 0; i < 25; i++) assert.equal((await bad(`10.0.0.${i}`)).status, 401);
    const all = await bad('10.1.1.1', 'open-sesame');
    assert.equal(all.status, 429);
    assert.match((await all.json()).error, /站点登录/);
  });
});

test('站长口令比较：长度不同、前缀相同、大小写不同都不通过', async () => {
  const bad = (code) => call('/api/admin/login', { method: 'POST', body: { code } });
  await withoutDelay(async () => {
    for (const code of ['open-sesam', 'open-sesame!', '', 'OPEN-SESAME']) assert.equal((await bad(code)).status, 401);
  });
  assert.equal((await bad('open-sesame')).status, 200);
});

test('管理页用公共额度新建行程：要登录，不受单 IP 限制，受全站总数限制', async () => {
  assert.equal((await call('/api/admin/trips', { method: 'POST', body: { name: '站长的' } })).status, 401);
  const cookie = await adminCookie();
  for (let i = 0; i < 12; i++) { // 超过单 IP 每天 10 个
    const res = await call('/api/admin/trips', { method: 'POST', cookie, body: { name: `站长的${i}` } });
    assert.equal(res.status, 200);
    if (i) continue;
    const trip = await res.json();
    assert.match(trip.url, /^\/t\/[a-z2-9]{10}#k=[a-z2-9]{24}$/);
    const s = await call(`/api/t/${trip.id}/session`, { method: 'POST', body: { key: trip.key } });
    const t = { ...trip, base: `/api/t/${trip.id}`, cookie: s.headers.get('set-cookie').split(';')[0] };
    const cfg = await (await call(`${t.base}/config`, { cookie: t.cookie })).json();
    assert.deepEqual([cfg.name, cfg.mode], ['站长的0', 'owner']);
    assert.equal((await call(`${t.base}/amap/v3/distance?a=1`, { cookie: t.cookie })).status, 200); // 用公共额度
  }
  const stats = await (await call('/api/admin/stats', { cookie })).json();
  assert.equal(stats.createdToday, 12);
  // 全站总数：普通用户新建也算进同一个计数
  const usage = env.USAGE.get();
  const saved = await usage.storage.get('create');
  await usage.storage.put('create', { ...saved, total: 200 });
  assert.equal((await call('/api/admin/trips', { method: 'POST', cookie, body: {} })).status, 429);
});

const batchOf = (t, requests) => call(`${t.base}/amap-batch`, { method: 'POST', cookie: t.cookie, body: { requests } }).then((r) => r.json());
const lbs = (n, tag = 'x') => Array.from({ length: n }, (_, i) => ({ path: '/v3/distance', query: `${tag}=${i}` }));
const search = (n, tag = 'y') => Array.from({ length: n }, (_, i) => ({ path: '/v5/place/text', query: `${tag}=${i}` }));
const flags = (cookie, body) => call('/api/admin/flags', { method: 'POST', cookie, body }).then((r) => r.json());
const adminStats = (cookie) => call('/api/admin/stats', { cookie }).then((r) => r.json());

test('应急开关：暂停公共额度只影响用公共额度的行程，恢复后可用', async () => {
  const cookie = await adminCookie();
  const owner = await newTrip(), own = await newTrip({ amapKey: OWN_KEY });
  assert.deepEqual((await flags(cookie, { publicPaused: true })).flags, { publicPaused: true });
  upstream = [];
  const paused = (await batchOf(owner, lbs(2))).results;
  assert.deepEqual(paused.map((r) => r.info), ['PUBLIC_PAUSED', 'PUBLIC_PAUSED']);
  assert.match(paused[0].error, /额度/);
  assert.match(paused[0].error, /自己的高德 Key/);
  assert.equal(upstream.length, 0);
  assert.equal((await call(`${owner.base}/amap/v3/distance?q=1`, { cookie: owner.cookie }).then((r) => r.json())).info, 'PUBLIC_PAUSED');
  assert.deepEqual((await batchOf(own, lbs(1, 'o'))).results.map((r) => r.info), ['OK']); // 自带 Key 不受影响
  assert.equal((await adminStats(cookie)).quota.today.lbs, 0); // 没有花站长的额度
  await flags(cookie, { publicPaused: false });
  assert.deepEqual((await batchOf(owner, lbs(1, 'r'))).results.map((r) => r.info), ['OK']);
  const stats = await adminStats(cookie);
  assert.deepEqual(stats.ops.slice(0, 2).map((o) => o.op), ['恢复公共额度', '暂停公共额度']);
});

test('应急开关：暂停新建行程，邀请码和自带 Key 都拦，管理页新建不拦，恢复后可新建', async () => {
  const cookie = await adminCookie();
  const code = await ownerInvite();
  await flags(cookie, { creationPaused: true });
  for (const body of [{ code }, { amapKey: OWN_KEY }]) {
    const res = await call('/api/trips', { method: 'POST', body });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, '站点暂停了新建行程');
  }
  assert.equal(upstream.length, 0); // 暂停时连验证 Key 的高德请求都不发
  assert.equal((await call('/api/admin/trips', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await adminStats(cookie)).invites[0].trips.length, 0); // 被拦的没占邀请码名额
  await flags(cookie, { creationPaused: false });
  assert.equal((await call('/api/trips', { method: 'POST', body: { code } })).status, 200);
  assert.equal((await call('/api/trips', { method: 'POST', body: { amapKey: OWN_KEY } })).status, 200);
});

test('应急开关：一键停用所有邀请码，已建行程要改用自己的 Key', async () => {
  const cookie = await adminCookie();
  const a = await createInvite(cookie, { note: 'a' }), b = await createInvite(cookie, { note: 'b' });
  const t = await newTrip({ code: a.code });
  await call(`/api/admin/invites/${b.code}`, { method: 'POST', cookie, body: { active: false } });
  assert.equal((await call('/api/admin/invites/disable-all', { method: 'POST' })).status, 401);
  const res = await call('/api/admin/invites/disable-all', { method: 'POST', cookie });
  assert.equal((await res.json()).disabled, 1);
  assert.ok((await adminStats(cookie)).invites.every((inv) => !inv.active));
  assert.equal((await batchOf(t, lbs(1))).results[0].info, 'INVITE_DISABLED');
  assert.equal((await call('/api/trips', { method: 'POST', body: { code: a.code } })).status, 403);
});

test('单个行程停用公共额度：只记 id、新建时间、邀请码、最后使用日、今天用量；可以恢复', async () => {
  const cookie = await adminCookie();
  const inv = await createInvite(cookie, { note: '给小王', maxTrips: 5 });
  const a = await newTrip({ name: '秘密行程A', code: inv.code }), b = await newTrip({ name: '行程B' });
  await save(a, { config: { people: [{ name: '住在某某路的老王' }] }, base_version: 1 });
  await batchOf(a, lbs(3)); await batchOf(b, lbs(1, 'b'));
  const { trips } = await adminStats(cookie);
  assert.deepEqual(trips.map((x) => x.id), [b.id, a.id]); // 最近用过的在前
  const row = trips.find((x) => x.id === a.id);
  assert.deepEqual(Object.keys(row).sort(), ['blocked', 'createdAt', 'id', 'invite', 'lastDay', 'usedToday']);
  assert.deepEqual([row.invite, row.usedToday, row.blocked], [inv.code, 3, false]);
  assert.doesNotMatch(JSON.stringify(trips), /秘密行程|老王/);
  assert.equal((await call(`/api/admin/trip-block/${a.id}`, { method: 'POST', body: { blocked: true } })).status, 401);
  assert.equal((await call('/api/admin/trip-block/abcdefghij', { method: 'POST', cookie, body: { blocked: true } })).status, 404);
  assert.equal((await call(`/api/admin/trip-block/${a.id}`, { method: 'POST', cookie, body: { blocked: true } })).status, 200);
  const blocked = (await batchOf(a, lbs(1, 'z'))).results[0];
  assert.deepEqual([blocked.info, /额度/.test(blocked.error)], ['TRIP_BLOCKED', true]);
  assert.deepEqual((await batchOf(b, lbs(1, 'bb'))).results.map((r) => r.info), ['OK']); // 别的行程不受影响
  assert.equal((await call(`${a.base}/config`, { cookie: a.cookie })).status, 200); // 数据照常能看能改
  await call(`/api/admin/trip-block/${a.id}`, { method: 'POST', cookie, body: { blocked: false } });
  assert.deepEqual((await batchOf(a, lbs(1, 'zz'))).results.map((r) => r.info), ['OK']);
  assert.deepEqual((await adminStats(cookie)).ops.slice(0, 2).map((o) => [o.op, o.target]), [['恢复行程的公共额度', a.id], ['停用行程的公共额度', a.id]]);
});

test('最近用过公共额度的行程最多记 200 个，管理操作最多记 50 条', async () => {
  const cookie = await adminCookie();
  const usage = env.USAGE.get();
  const make = (i) => ({ id: `fill${String(i).padStart(6, 'a')}`, createdAt: 1, invite: null, lastDay: '2026-01-01', usedToday: 1, blocked: false });
  await usage.storage.put('trips', Array.from({ length: 200 }, (_, i) => make(i)));
  const t = await newTrip();
  await batchOf(t, lbs(1));
  const { trips } = await adminStats(cookie);
  assert.equal(trips.length, 200);
  assert.equal(trips[0].id, t.id);
  for (let i = 0; i < 60; i++) await flags(cookie, { publicPaused: i % 2 === 0 });
  assert.equal((await adminStats(cookie)).ops.length, 50);
});

test('额度按类别记：今天和本月分开，月预算用完那一类停下', async () => {
  env.OWNER_MONTHLY_LBS_BUDGET = '6';
  env.OWNER_MONTHLY_SEARCH_BUDGET = '2';
  env.OWNER_DAILY_LIMIT = '100';
  const cookie = await adminCookie();
  const t = await newTrip();
  const first = await batchOf(t, [...lbs(3), ...search(3)]);
  assert.deepEqual(first.results.map((r) => r.info), ['OK', 'OK', 'OK', 'OK', 'OK', 'MONTHLY_BUDGET']);
  assert.match(first.results[5].error, /额度/);
  assert.match(first.results[5].error, /地点搜索/);
  let stats = await adminStats(cookie);
  assert.deepEqual([stats.quota.today, stats.quota.month, stats.quota.budgets], [{ lbs: 3, search: 2 }, { lbs: 3, search: 2 }, { lbs: 6, search: 2 }]);
  assert.equal(stats.ownerUsedToday, 5);
  assert.equal(stats.quota.days.length, 30);
  const second = await batchOf(t, [...lbs(5, 'l2'), ...search(1, 's2')]); // 路线类还剩 3 个，搜索类已满
  assert.deepEqual(second.results.map((r) => r.info), ['OK', 'OK', 'OK', 'MONTHLY_BUDGET', 'MONTHLY_BUDGET', 'MONTHLY_BUDGET']);
  assert.match(second.results[3].error, /路线和测距/);
});

test('额度按类别记：隔月清零，只留 35 天', async () => {
  env.OWNER_DAILY_LIMIT = '1000';
  const usage = env.USAGE.get();
  const realNow = Date.now;
  const day = (offset) => new Date(realNow() + offset * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
  // 手工放几天旧数据：40 天前（应被清掉）、昨天
  await usage.storage.put('daily', { [day(-40)]: { lbs: 9, search: 9 }, [day(-1)]: { lbs: 4, search: 1 } });
  const t = await newTrip();
  await batchOf(t, lbs(1));
  const stored = await usage.storage.get('daily');
  assert.deepEqual(Object.keys(stored).sort(), [day(-1), day(0)].sort());
  const cookie = await adminCookie();
  const stats = await adminStats(cookie);
  assert.deepEqual(stats.quota.days.slice(0, 2).map((d) => [d.day, d.lbs, d.search]), [[day(0), 1, 0], [day(-1), 4, 1]]);
  const sameMonth = day(0).slice(0, 7) === day(-1).slice(0, 7);
  assert.deepEqual(stats.quota.month, sameMonth ? { lbs: 5, search: 1 } : { lbs: 1, search: 0 });
  // 40 天后：本月累计只剩新的一天
  Date.now = () => realNow() + 40 * 86400e3;
  try {
    const late = await adminCookie();
    assert.deepEqual((await adminStats(late)).quota.month, { lbs: 0, search: 0 });
  } finally { Date.now = realNow; }
});

test('每日全站上限、八成预留仍按两类合计算', async () => {
  env.OWNER_DAILY_LIMIT = '5';
  const t = await newTrip();
  const res = await batchOf(t, [...lbs(3), ...search(3)]);
  assert.deepEqual(res.results.map((r) => r.info), ['OK', 'OK', 'OK', 'OK', 'OK', 'OWNER_DAILY_LIMIT']);
  const later = await newTrip();
  assert.equal((await batchOf(later, lbs(1, 'later'))).results[0].info, 'OWNER_RESERVED');
});

const status = (init) => call('/api/status', init);

test('公开额度状态：ok、tight、out（当天用完或路线类月预算用完）、paused', async () => {
  env.OWNER_DAILY_LIMIT = '10';
  const cookie = await adminCookie();
  const res = await status();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await res.json(), { public: { level: 'ok', usedPct: 0, searchMonthPct: 0 }, creating: true });
  const t = await newTrip();
  await batchOf(t, [...lbs(5), ...search(1)]);
  assert.deepEqual((await (await status()).json()).public, { level: 'ok', usedPct: 60, searchMonthPct: Math.round(100 / 4500) });
  await batchOf(t, lbs(2, 'more')); // 8/10
  assert.deepEqual((await (await status()).json()).public, { level: 'tight', usedPct: 80, searchMonthPct: Math.round(100 / 4500) });
  await batchOf(t, lbs(5, 'rest')); // 满了
  assert.deepEqual((await (await status()).json()).public.level, 'out');
  assert.equal((await (await status()).json()).public.usedPct, 100);
  await flags(cookie, { publicPaused: true, creationPaused: true });
  assert.deepEqual((await (await status()).json()).creating, false);
  assert.equal((await (await status()).json()).public.level, 'paused');
  await flags(cookie, { publicPaused: false, creationPaused: false });
  // 路线类月预算用完也算 out，哪怕今天全站上限还没到
  env.OWNER_DAILY_LIMIT = '1000';
  env.OWNER_MONTHLY_LBS_BUDGET = '9';
  assert.equal((await (await status()).json()).public.level, 'out');
  env.OWNER_MONTHLY_LBS_BUDGET = '10';
  assert.equal((await (await status()).json()).public.level, 'ok');
});

test('公开额度状态：不需要登录，只有这几个字段，不泄露行程和邀请码；节点缓存 60 秒，管理开关立即清缓存', async () => {
  const store = new Map();
  globalThis.caches = { default: {
    async match(req) { return store.get(req.url)?.clone(); },
    async put(req, res) { store.set(req.url, res); },
    async delete(req) { return store.delete(req.url); },
  } };
  try {
    const cookie = await adminCookie();
    const t = await newTrip();
    await batchOf(t, lbs(1));
    const body = await (await status()).json();
    assert.deepEqual(Object.keys(body).sort(), ['creating', 'public']);
    assert.deepEqual(Object.keys(body.public).sort(), ['level', 'searchMonthPct', 'usedPct']);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${t.id}|${sharedInvite}`));
    await batchOf(t, lbs(40, 'many')); // 缓存期内的变化看不到
    assert.equal((await (await status()).json()).public.usedPct, body.public.usedPct);
    await flags(cookie, { publicPaused: true }); // 开关会清缓存
    assert.equal((await (await status()).json()).public.level, 'paused');
  } finally { delete globalThis.caches; }
});

test('额度类报错文案都含「额度」，编辑页靠它弹出改用自己的 Key', async () => {
  const cookie = await adminCookie();
  const t = await newTrip();
  await flags(cookie, { publicPaused: true });
  assert.match((await batchOf(t, lbs(1))).results[0].error, /额度/);
  await flags(cookie, { publicPaused: false });
  env.OWNER_MONTHLY_LBS_BUDGET = '1';
  await batchOf(t, lbs(1, 'a'));
  assert.match((await batchOf(t, lbs(1, 'b'))).results[0].error, /额度/);
});

const SECURITY = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=15552000', 'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};
const assertSecure = (res, extra = {}) => {
  for (const [k, v] of Object.entries({ ...SECURITY, ...extra })) assert.equal(res.headers.get(k), v, k);
};

test('Worker 生成的响应都带安全头', async () => {
  assertSecure(await call('/api/env'));
  assertSecure(await call('/api/nothing'));
  assertSecure(await call('/p/nopenopeno')); // 404 文本
  const t = await newTrip();
  assertSecure(await call(`${t.base}/config`, { cookie: t.cookie }));
  const edit = await call(`/t/${t.id}`); // 来自 ASSETS 的响应头只读，也要能补上
  assertSecure(edit, { 'content-security-policy': "frame-ancestors 'none'" });
  assertSecure(await call('/privacy'));
  assert.equal((await call('/privacy')).headers.get('content-security-policy'), null); // 静态页的 CSP 在 meta 里
  // 方案页：保留自己的沙箱 CSP 和更严的 referrer-policy，其余补齐
  const share = (await publish(t, '<!doctype html><p>hi</p>')).share;
  const page = await call(share.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /^sandbox /);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=15552000');
  // 口令页
  await shareAction(t, { action: 'code', code: 'abc' });
  assertSecure(await call(share.url));
});

test('SHARE_CSP 允许沙箱里的方案页加载站点图标', async () => {
  const t = await newTrip();
  const share = (await publish(t, '<!doctype html><p>hi</p>')).share;
  assert.match((await call(share.url)).headers.get('content-security-policy'), /img-src [^;]*https:\/\/carpool\.eigentime\.org/);
});

test('改动状态的请求：跨站 Origin 被拒，同源和不带 Origin 的放行', async () => {
  const evil = 'https://evil.example';
  const same = 'https://carpool.test';
  const r = await call('/api/trips', { method: 'POST', body: {}, origin: evil });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, '只接受本站发起的请求');
  assertSecure(r);
  assert.equal((await call('/api/trips', { method: 'POST', body: {}, origin: same })).status, 400); // 过了校验，被后面的参数检查拒绝
  assert.equal((await call('/api/trips', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { code: 'x' }, origin: evil })).status, 403);
  const t = await newTrip();
  assert.equal((await call(`${t.base}/config`, { method: 'POST', cookie: t.cookie, body: { name: 'x' }, origin: evil })).status, 403);
  assert.equal((await call(`${t.base}/share`, { method: 'DELETE', cookie: t.cookie, origin: evil })).status, 403);
  // 口令表单
  const url = (await publish(t, '<!doctype html><p>hi</p>')).share.url;
  await shareAction(t, { action: 'code', code: 'abc' });
  assert.equal((await call(url, { method: 'POST', form: { code: 'abc' }, origin: evil })).status, 403);
  assert.equal((await call(url, { method: 'POST', form: { code: 'abc' }, origin: same })).status, 303);
  assert.equal((await call(url, { method: 'POST', form: { code: 'abc' } })).status, 303);
  // 读请求不受影响
  assert.equal((await call('/api/env', { origin: evil })).status, 200);
});

test('500 错误不泄露内部信息，4xx 的提示原样返回', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a);
  try {
    env.DATA.getWithMetadata = async () => { throw new Error('KV 内部错误 secret-detail'); };
    const r = await call('/p/abcdefghij');
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.doesNotMatch(text, /secret-detail/);
    assert.match(text, /服务器出错了，请稍后再试/);
    assertSecure(r);
    assert.ok(logged.length >= 1 && String(logged[0][1]).includes('secret-detail'));
  } finally { console.error = orig; }
  const bad = await call('/api/trips', { method: 'POST', body: { amapKey: 'short' } });
  assert.equal(bad.status, 400);
  assert.notEqual((await bad.json()).error, '服务器出错了，请稍后再试');
});

// ---------- v3.2：服务端汇总统计、404 页面、TRIP_GONE、版本号 ----------

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const HTML = { accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA };
const adminTraffic = async (cookie) => (await (await call('/api/admin/stats', { cookie })).json()).traffic;
const todayStats = async () => (await adminTraffic(await adminCookie())).days[0];

test('统计：页面访问、爬虫、来源各自计数；爬虫不算页面访问', async () => {
  for (const path of ['/', '/demo', '/guide', '/guide/station', '/for/wedding', '/privacy', '/about', '/guide/']) await call(path, { headers: HTML });
  await call('/', { headers: { ...HTML, referer: 'https://www.zhihu.com/question/1?x=secret' } });
  await call('/?from=XHS-note', { headers: { ...HTML, referer: 'https://carpool.test/guide' } }); // 站内来源不记
  await call('/?from=bad%20value!', { headers: HTML });
  await call('/', { headers: { accept: '*/*', 'user-agent': BROWSER_UA } }); // Accept 不含 html：不算
  await call('/', { method: 'POST', headers: HTML }); // 不是 GET：不算
  await call('/t/abcdefghij', { headers: HTML }); // 编辑页不算页面访问
  await call('/', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
  await call('/guide', { headers: { accept: '*/*', 'user-agent': 'Mozilla/5.0; compatible; GPTBot/1.1' } });
  await call('/about', { headers: { accept: '*/*', 'user-agent': 'python-requests/2.31' } });
  await call('/about', { headers: { accept: '*/*' } }); // 没有 UA：其他爬虫
  await settle();
  const day = await todayStats();
  assert.equal(day.pages, 11);
  assert.equal(day.paths['/'], 4);
  assert.equal(day.paths['/guide'], 2); // /guide 和 /guide/ 归到一起
  assert.deepEqual(day.bots, { googlebot: 1, gptbot: 1, other: 2 });
  assert.deepEqual(day.refs, { 'zhihu.com': 1 }); // 只有域名，没有路径和参数
  assert.deepEqual(day.froms, { 'xhs-note': 1 });
  assert.ok(!JSON.stringify(day).includes('secret') && !JSON.stringify(day).includes('1.1.1.1'));
});

test('统计：新建行程按来源分、发布方案页、方案页被打开、当天有计算的行程数', async () => {
  await newTrip({ amapKey: OWN_KEY });
  const t = await newTrip(); // 邀请码
  await call('/api/admin/trips', { method: 'POST', cookie: await adminCookie(), body: { name: '管理页建的' } });
  await call(`${t.base}/amap/v3/distance?a=1`, { cookie: t.cookie });
  await call(`${t.base}/amap/v3/distance?a=2`, { cookie: t.cookie }); // 同一天第二次：不重复计
  const { url } = (await publish(t, '<!doctype html>方案')).share;
  await call(url, { headers: HTML });
  await call(url, { headers: { 'user-agent': 'Googlebot/2.1' } }); // 爬虫打开不算
  await settle();
  const day = await todayStats();
  assert.deepEqual(day.creates, { invite: 1, own: 1, admin: 1 });
  assert.equal(day.active, 1);
  assert.equal(day.publishes, 1);
  assert.equal(day.shareViews, 1);
});

test('统计：不存在的页面不计数', async () => {
  env.ASSETS = { fetch: async () => new Response('nope', { status: 404 }) };
  await call('/guide/nothing', { headers: HTML });
  await settle();
  assert.equal((await todayStats()).pages, 0);
});

test('统计：来源域名、from 每天每类最多 50 个不同值，其余计入「其他」', async () => {
  for (let i = 0; i < 55; i++) await call(`/?from=s${i}`, { headers: { ...HTML, referer: `https://site${i}.example.com/` } });
  await call('/?from=s3', { headers: HTML }); // 已记录的值照常累加
  await settle();
  const day = await todayStats();
  assert.equal(Object.keys(day.refs).length, 51);
  assert.equal(day.refs['其他'], 5);
  assert.equal(Object.keys(day.froms).length, 51);
  assert.equal(day.froms.s3, 2);
  assert.equal(day.froms['其他'], 5);
});

test('统计：只留 35 天，新的一天写入时清掉更早的；接口返回近 30 天', async () => {
  const storage = env.USAGE.get().storage;
  const dayOf = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  await storage.put(`st:${dayOf(34)}`, { pages: 7, paths: {}, bots: {}, refs: {}, froms: {}, creates: { invite: 0, own: 0, admin: 0 }, active: 0, publishes: 0, shareViews: 0 });
  await storage.put(`st:${dayOf(36)}`, { pages: 9 });
  await storage.put(`st:${dayOf(100)}`, { pages: 9 });
  await call('/', { headers: HTML });
  await settle();
  const keys = [...(await storage.list({ prefix: 'st:' })).keys()];
  assert.deepEqual(keys, [`st:${dayOf(34)}`, `st:${dayOf(0)}`]);
  const { days } = await adminTraffic(await adminCookie());
  assert.equal(days.length, 30);
  assert.equal(days[0].pages, 1);
  assert.equal(days[1].pages, 0); // 没有记录的天补零
});

test('统计：页面响应不等计数写完，计数出错也不影响页面', async () => {
  let started = false;
  env.USAGE = { idFromName: (n) => n, get: () => ({ fetch: () => { started = true; return new Promise(() => {}); } }) }; // 永远不返回
  const res = await call('/guide', { headers: HTML });
  assert.equal(await res.text(), 'asset:/guide');
  assert.ok(started);
  assert.equal(background.length, 1); // 交给 waitUntil 了
  env.USAGE = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('坏了'); } }) };
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(await (await call('/about', { headers: HTML })).text(), 'asset:/about');
    await background[1]; // 写失败被吞掉，不抛出
  } finally { console.error = realError; }
});

test('方案页不存在：返回 404 的 HTML 页面，说明原因，给首页入口，引用 /design.css', async () => {
  const res = await call('/p/nopenopeno');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const html = await res.text();
  assert.match(html, /href="\/design\.css"/);
  assert.match(html, /已经停止分享/);
  assert.match(html, /<a class="c-btn[^"]*" href="\/">回到首页/);
});

test('口令页：引用 /design.css，表单和字段不变', async () => {
  const t = await newTrip();
  const { url } = (await publish(t, '<!doctype html>方案内容')).share;
  await shareAction(t, { action: 'code', code: '2468' });
  const html = await (await call(url)).text();
  assert.match(html, /href="\/design\.css"/);
  assert.match(html, new RegExp(`<form class="c-card" method="post" action="${url}">`));
  assert.match(html, /name="code"/);
});

test('行程已删除或到期：接口返回 TRIP_GONE，和密钥不对（UNAUTHORIZED）区分', async () => {
  const t = await newTrip();
  const wrong = await call(`${t.base}/session`, { method: 'POST', body: { key: 'wrong' } });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).info, 'UNAUTHORIZED');
  await call(`${t.base}/delete`, { method: 'POST', cookie: t.cookie });
  const session = await call(`${t.base}/session`, { method: 'POST', body: { key: t.key } });
  assert.equal(session.status, 404);
  assert.equal((await session.json()).info, 'TRIP_GONE');
  assert.equal((await (await call('/api/t/abcdefghij/session', { method: 'POST', body: { key: 'x' } })).json()).info, 'TRIP_GONE'); // 从没建过的 id 一样
});

test('/api/env 返回版本号（取自 package.json）', async () => {
  const res = await (await call('/api/env')).json();
  assert.match(res.version, /^\d+\.\d+\.\d+$/);
  assert.equal(res.version, pkg.version);
});
