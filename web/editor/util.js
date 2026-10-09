// 通用小工具：选元素、转义、深拷贝、本地存储。不依赖其他模块；导入时不碰页面（用到时才读 document 和 localStorage）。
export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clone = (x) => (x === undefined ? undefined : structuredClone(x));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isPlain = (x) => x && typeof x === 'object' && !Array.isArray(x);
export const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ } } };

export const themeVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const parseLoc = (loc) => { const [lng, lat] = String(loc || '').split(',').map(Number); return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null; };

export const isQuotaError = (msg) => /额度|配额|上限/.test(String(msg));

