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
