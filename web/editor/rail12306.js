// ---- 12306 查询链接：用站名表在本地拼出来，不发请求 ----

import { outboundOn, state } from './state.js';
import { bjDate } from './time.js';

let railPromise = null, railData = null;
// 站名表只取一次；取到以后 link12306 才有结果（取不到就退化成空表）
export function load12306() {
  railPromise ??= fetch('/stations12306.json').then((r) => r.json()).catch(() => ({ stations: {}, cities: {} })).then((data) => (railData = data));
  return railPromise;
}
export function originCity(p, data) {
  const text = `${p.city || ''} ${p.from || ''}`;
  let best = '';
  for (const city of Object.keys(data.cities)) if (city.length > best.length && text.includes(city)) best = city;
  return best;
}
export function link12306(p, stationName, back = false) {
  if (!railData) return '';
  const data = railData;
  const station = stationName.replace(/站$/, '');
  const city = originCity(p, data);
  const date = (back ? state.cfg.return?.date : '') || (outboundOn() ? state.cfg.options?.travel_date : '') || bjDate(Date.now() + 864e5);
  const home = city ? `${encodeURIComponent(city)},${data.cities[city]}` : '';
  const st = data.stations[station] ? `${encodeURIComponent(station)},${data.stations[station]}` : '';
  const [fs, ts] = back ? [st, home] : [home, st]; // 返程反过来：从车站回家
  return `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${fs}&ts=${ts}&date=${encodeURIComponent(date)}&flag=N,N,Y`;
}

// ---- 火车票开售日 ----
// 12306 的预售期是 15 天（含乘车当天），也就是乘车日前 14 天开售；春运按往年规律是春节前 15 天到后 24 天（以铁路部门公布为准）。
// 和计算核心 reporting.py 的 PRESALE_DAYS、SPRING_FESTIVAL 一样，test_carpool.py 核对两边一致；规定变了两处一起改
export const PRESALE_DAYS = 15;
export const SPRING_FESTIVAL = { 2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03' };
const DAY_MS = 864e5;

// 乘车日期（YYYY-MM-DD，也认 /）→ { sale: 开售日的 YYYY-MM-DD, saleLabel: 「1月30日（周六）」, spring: 是否在春运期间 }；写不对返回 null
export function ticketSale(date) {
  const m = String(date || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const day = new Date(t);
  if (day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return null;
  const sale = new Date(t - (PRESALE_DAYS - 1) * DAY_MS);
  const festival = SPRING_FESTIVAL[+m[1]] ? Date.parse(`${SPRING_FESTIVAL[+m[1]]}T00:00:00Z`) : NaN; // 春节最早在 1 月下旬，春运不跨到上一年
  return {
    sale: sale.toISOString().slice(0, 10),
    saleLabel: `${sale.getUTCMonth() + 1}月${sale.getUTCDate()}日（周${'日一二三四五六'[sale.getUTCDay()]}）`,
    spring: Number.isFinite(festival) && t >= festival - 15 * DAY_MS && t <= festival + 24 * DAY_MS,
  };
}

// 日期输入框下面的一句提示；today 是北京时间的 YYYY-MM-DD，开售日已过就写「已经开售」
export function saleHint(date, today) {
  const s = ticketSale(date);
  if (!s) return '';
  const head = s.sale <= today ? `火车票 ${s.saleLabel}已经开售，尽早买` : `火车票 ${s.saleLabel}开售（12306 提前 ${PRESALE_DAYS} 天，含乘车当天）`;
  return head + (s.spring ? '。这天在春运期间，热门方向开售后很快卖完：开售当天准点买，买不到就提交候补' : '');
}
