// Worker 的离线测试：内存 KV + 假的 fetch，不连 Cloudflare 和高德。运行：node --test web/
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker, { ConfigRoom } from './worker.js';

let env, upstream, room, sockets;

// 假的 Durable Object 运行环境：内存存储 + 记录发出消息的连接
function fakeSocket() {
  return { sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() {} };
}

beforeEach(() => {
  const store = new Map();
  const doStore = new Map();
  sockets = [fakeSocket(), fakeSocket()];
  env = {
    AMAP_KEY: 'server-key',
    ACCESS_CODE: 'open-sesame',
    DATA: {
      async get(key, type) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
      async put(key, value) { store.set(key, value); },
    },
    ASSETS: { fetch: async () => new Response('static') },
    ROOM: { idFromName: () => 'main', get: () => ({ fetch: (req) => room.fetch(req) }) },
  };
  room = new ConfigRoom({
    storage: { async get(k) { return doStore.get(k); }, async put(k, v) { doStore.set(k, structuredClone(v)); } },
    getWebSockets: () => sockets,
  }, env);
  upstream = [];
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response(JSON.stringify(globalThis.nextAmapReply || { status: '1', info: 'OK' }));
  };
  globalThis.nextAmapReply = null;
});

const call = (path, { method = 'GET', body, cookie } = {}) => worker.fetch(new Request(`https://carpool.test${path}`, {
  method, body: body && JSON.stringify(body), headers: cookie ? { cookie } : {},
}), env);

async function login() {
  const res = await call('/api/login', { method: 'POST', body: { code: 'open-sesame' } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  return cookie.split(';')[0];
}

test('没登录不能读配置、不能用高德代理', async () => {
  assert.equal((await call('/api/config')).status, 401);
  assert.equal((await call('/api/amap/v3/distance?origins=1,1')).status, 401);
  assert.equal(upstream.length, 0);
  assert.equal((await call('/api/env')).status, 200);
});

test('口令错误被拒，正确后能读写配置', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { code: 'guess' } })).status, 401);
  const cookie = await login();
  assert.deepEqual((await (await call('/api/config', { cookie })).json()).config.people, []);
  await call('/api/config', { method: 'POST', cookie, body: { config: { people: [{ name: '老王' }] }, base_version: 1 } });
  assert.equal((await (await call('/api/config', { cookie })).json()).config.people[0].name, '老王');
});

test('高德代理只放行白名单接口，并由服务端加 Key', async () => {
  const cookie = await login();
  assert.equal((await call('/api/amap/v3/ip', { cookie })).status, 403);
  await call('/api/amap/v3/distance?origins=1,1&key=client-key', { cookie });
  assert.equal(upstream.length, 1);
  const url = new URL(upstream[0]);
  assert.equal(url.origin + url.pathname, 'https://restapi.amap.com/v3/distance');
  assert.deepEqual(url.searchParams.getAll('key'), ['server-key']);
});

test('配额用完后停止转发，直到北京时间次日零点', async () => {
  const cookie = await login();
  globalThis.nextAmapReply = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' };
  await call('/api/amap/v3/distance?origins=1,1', { cookie });
  const until = Number(await env.DATA.get('amap_quota_until'));
  assert.ok(until > Date.now() && until - Date.now() <= 86400e3);
  assert.equal(new Date(until).getUTCHours(), 16); // 北京时间 0 点 = UTC 16 点
  const blocked = await call('/api/amap/v3/distance?origins=1,1', { cookie });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).info, 'DAILY_QUERY_OVER_LIMIT'); // Python 端据此抛 QuotaError
  assert.equal(upstream.length, 1);
});

const save = (cookie, body) => call('/api/config', { method: 'POST', cookie, body });

test('批量请求并发转发，白名单和配额同样生效', async () => {
  const cookie = await login();
  const batch = (requests) => call('/api/amap-batch', { method: 'POST', cookie, body: { requests } });
  const data = await (await batch([
    { path: '/v3/distance', query: 'origins=1,1&key=client-key' },
    { path: '/v3/ip', query: '' },
    { path: '/v5/place/text', query: 'keywords=西站' },
  ])).json();
  assert.equal(data.results.length, 3);
  assert.equal(data.results[1].info, 'PATH_NOT_ALLOWED');
  assert.equal(upstream.length, 2);
  assert.ok(upstream.every((u) => new URL(u).searchParams.getAll('key').join() === 'server-key'));
  assert.equal((await batch(new Array(41).fill({ path: '/v3/distance', query: '' }))).status, 400);
  globalThis.nextAmapReply = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT' };
  await batch([{ path: '/v3/distance', query: 'a=1' }]);
  const blocked = await (await batch([{ path: '/v3/distance', query: 'a=2' }])).json();
  assert.equal(blocked.results[0].info, 'DAILY_QUERY_OVER_LIMIT');
  assert.equal(upstream.length, 3); // 配额用完后不再转发
  assert.equal((await call('/api/amap-batch', { method: 'POST', body: { requests: [] } })).status, 401);
});

test('批量里被限流的会等一下再试一次', async () => {
  const cookie = await login();
  let calls = 0;
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    calls += 1;
    const reply = calls === 1 ? { status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10019' } : { status: '1', info: 'OK' };
    return new Response(JSON.stringify(reply));
  };
  const data = await (await call('/api/amap-batch', { method: 'POST', cookie, body: { requests: [
    { path: '/v3/distance', query: 'a=1' }, { path: '/v3/distance', query: 'a=2' },
  ] } })).json();
  assert.deepEqual(data.results.map((r) => r.status), ['1', '1']);
  assert.equal(upstream.length, 3);
});

test('配额在批量中途用完时，剩下的不再请求', async () => {
  const cookie = await login();
  globalThis.nextAmapReply = { status: '0', info: 'DAILY_QUERY_OVER_LIMIT' };
  const requests = Array.from({ length: 7 }, (_, i) => ({ path: '/v3/distance', query: `a=${i}` }));
  const data = await (await call('/api/amap-batch', { method: 'POST', cookie, body: { requests } })).json();
  assert.equal(upstream.length, 3); // 第一波 3 个之后就停了
  assert.ok(data.results.every((r) => r.info === 'DAILY_QUERY_OVER_LIMIT'));
});

test('第一次读配置时沿用 KV 里的旧配置', async () => {
  await env.DATA.put('config', JSON.stringify({ people: [{ name: '旧配置' }] }));
  const cookie = await login();
  const data = await (await call('/api/config', { cookie })).json();
  assert.equal(data.config.people[0].name, '旧配置');
  assert.equal(data.version, 1);
});

test('保存成功后版本号加一，并推送给所有在线的人', async () => {
  const cookie = await login();
  const res = await save(cookie, { config: { people: [{ name: '老王' }] }, base_version: 1, client_id: 'a' });
  assert.equal((await res.json()).version, 2);
  for (const ws of sockets) {
    assert.deepEqual(ws.sent.at(-1), { type: 'config', config: { people: [{ name: '老王' }] }, version: 2, client_id: 'a' });
  }
});

test('版本号过期的保存被拒绝，并返回最新配置供合并', async () => {
  const cookie = await login();
  await save(cookie, { config: { people: [{ name: '先存的' }] }, base_version: 1, client_id: 'a' });
  const res = await save(cookie, { config: { people: [{ name: '后存的' }] }, base_version: 1, client_id: 'b' });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.config.people[0].name, '先存的');
  assert.equal(data.version, 2);
  assert.equal((await (await call('/api/config', { cookie })).json()).config.people[0].name, '先存的');
});

test('有人断开时广播在线人数', async () => {
  room.webSocketClose(sockets[0], 1000, 'bye');
  assert.deepEqual(sockets[1].sent.at(-1), { type: 'presence', online: 1 });
  assert.equal(sockets[0].sent.length, 0);
});

test('不是 WebSocket 的同步请求被拒', async () => {
  const cookie = await login();
  assert.equal((await call('/api/sync', { cookie })).status, 426);
  assert.equal((await call('/api/sync')).status, 401);
});

test('方案页发布后不用口令就能看', async () => {
  const cookie = await login();
  assert.equal((await call('/api/pages', { method: 'POST', cookie, body: { html: '<script>x</script>' } })).status, 400);
  const { url } = await (await call('/api/pages', { method: 'POST', cookie, body: { html: '<!doctype html><p>方案</p>' } })).json();
  assert.match(url, /^\/p\/[a-z2-9]{12}$/);
  const page = await call(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /方案/);
  assert.equal((await call('/p/nope')).status, 404);
  assert.equal((await call('/api/pages', { method: 'POST', body: { html: '<!doctype html>' } })).status, 401);
});
