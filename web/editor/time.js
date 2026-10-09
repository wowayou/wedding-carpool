// ---------- 时间：统一按北京时间（UTC+8）显示，不依赖浏览器所在的时区 ----------
export const BJ_MS = 8 * 3600e3;
export const bj = (ms) => new Date(ms + BJ_MS); // 用它的 getUTC* 取北京时间的年月日时分
export const pad2 = (n) => String(n).padStart(2, '0');
export const bjDate = (ms) => { const d = bj(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
export const bjMonthDayTime = (ms) => { const d = bj(ms); return `${d.getUTCMonth() + 1}-${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };

export function fmtMin(m) { return m >= 60 ? `${Math.floor(m / 60)}小时${String(m % 60).padStart(2, '0')}分` : `${m}分钟`; }
export function fmtTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  if (now - ts < 60e3) return '刚刚';
  if (now - ts < 3600e3) return `${Math.floor((now - ts) / 60e3)} 分钟前`;
  return bjMonthDayTime(ts);
}

export const fmtDate = bjDate;

