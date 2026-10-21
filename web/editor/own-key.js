// ---------- 自己的高德 Key：只存在这台设备的浏览器里（localStorage），本站服务器不保存、不经手 ----------
// 读写都包在 try/catch 里：隐私模式或禁用存储时读不到，当作没填。首页（web/landing.html）有一份同样的验证逻辑，
// QUOTA_RE / QPS_RE 要和 web/worker.js 里的一致（web/ui.test.mjs 核对）。

import { bjDate } from './time.js';
import { store } from './util.js';

export const KEY_STORE = 'carpool_amap_key';
const USAGE_STORE = 'carpool_own_usage'; // { 行程编号: { day, count } }：每个行程今天在这台设备上发了多少次高德请求
const KEY_RE = /^[0-9a-f]{32}$/i;
export const QUOTA_RE = /DAILY_QUERY_OVER_LIMIT|QUOTA_PLAN_RUN_OUT|SERVICE_EXPIRED/;
export const QPS_RE = /QPS|TOO_FREQUENT/;

export const ownKey = () => { const k = store.get(KEY_STORE, ''); return typeof k === 'string' && KEY_RE.test(k) ? k : ''; };
export const saveOwnKey = (key) => store.set(KEY_STORE, key);
export const clearOwnKey = () => { try { localStorage.removeItem(KEY_STORE); } catch { /* 隐私模式 */ } };
export const keyTail = (key) => key.slice(-4);

// 用一次真实调用确认 Key 可用（浏览器直连高德）；配额用完、频率超限不算 Key 无效。返回错误说明，可用时返回空
export async function verifyKey(key) {
  if (!KEY_RE.test(key)) return '高德 Key 应该是 32 位的字母和数字';
  const check = await fetch(`https://restapi.amap.com/v3/geocode/geo?${new URLSearchParams({ address: '北京市', key })}`, { credentials: 'omit' })
    .then((r) => r.json()).catch(() => null);
  if (!check) return '暂时连不上高德，稍后再试';
  const info = String(check.info || '');
  if (String(check.status) !== '1' && !QUOTA_RE.test(info) && !QPS_RE.test(info)) {
    return `这个高德 Key 用不了（${info}）。需要「Web服务」类型的 Key，且不能设置 IP 白名单`;
  }
  return '';
}

// 每个行程今天在这台设备上的用量：计算线程（Web Worker）读不到 localStorage，页面每次调用时把这里的数传进去，算的过程中线程再把新总数报回来
export function ownUsage(tripId) {
  const today = bjDate(Date.now());
  const saved = store.get(USAGE_STORE, {})[tripId];
  return { day: today, count: saved && saved.day === today ? saved.count : 0 };
}

export function noteOwnUsage(tripId, { day, count }) {
  const today = bjDate(Date.now());
  if (day !== today) return;
  // 只留今天的；别的标签页报的比已有的少就不往回退
  const all = Object.fromEntries(Object.entries(store.get(USAGE_STORE, {})).filter(([, v]) => v && v.day === today));
  all[tripId] = { day, count: Math.max(count, all[tripId]?.count || 0) };
  store.set(USAGE_STORE, all);
}
