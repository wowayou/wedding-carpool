// Worker 的离线测试：内存 KV + 假的 fetch，不连 Cloudflare 和高德。运行：node --test web/
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from './worker.js';

let env, upstream;
beforeEach(() => {
  const store = new Map();
  env = {
    AMAP_KEY: 'server-key',
    ACCESS_CODE: 'open-sesame',
    DATA: {
      async get(key, type) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
      async put(key, value) { store.set(key, value); },
    },
    ASSETS: { fetch: async () => new Response('static') },
  };
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
  await call('/api/config', { method: 'POST', cookie, body: { config: { people: [{ name: '老王' }] } } });
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
