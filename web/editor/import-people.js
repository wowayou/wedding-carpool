// ---------- 从别的行程导入成员：同一群人再出行时（比如同一个宿舍的人先后结婚），出发地、开不开车、空座都带过来 ----------
// 来源：这台设备打开过的行程（在线版），或者以前导出的 JSON 文件。导入的成员加在现有成员后面，不替换；整份替换用「更多」里的「导入配置」。

import { request } from './backend.js';
import { caps } from './caps.js';
import { toast } from './dialogs.js';
import { closeDrawer, openDrawer } from './drawer.js';
import { renderForm } from './form.js';
import { state } from './state.js';
import { markDirty } from './sync.js';
import { $, esc, isPlain, store } from './util.js';

// 只带跟着人走的：出发地和坐标、开不开车、空座、绕路上限、同行人数、到家附近接、返程开不开车和绕路上限、备注。
// 车次、到站用时、回程车次、离场时间、只考虑的站跟着这次的车站和日期变，不带
export const PERSON_KEYS = ['name', 'from', 'location', 'city', 'car_seats', 'max_detour_min', 'party', 'pickup_at_home',
  'return_drives', 'return_max_detour_min', 'note'];
export const portable = (p) => Object.fromEntries(PERSON_KEYS.filter((k) => p[k] !== undefined && p[k] !== '').map((k) => [k, structuredClone(p[k])]));

const loaded = { label: '', people: [] }; // 最近取到的来源

// 别的行程的配置：先直接取（这台设备打开过它，Cookie 可能还在），不行再用记住的编辑链接换一次 Cookie。
// 用最底层的 request，不走编辑页自己的出错处理：那个行程打不开不能把当前行程的页面盖住
export async function fetchTripConfig(id, key) {
  let { res, data } = await request(`/api/t/${id}/config`);
  if (res.status === 401 && data.info === 'UNAUTHORIZED' && key) {
    const session = await request(`/api/t/${id}/session`, { key, code: '' });
    ({ res, data } = session.res.ok ? await request(`/api/t/${id}/config`) : session);
  }
  if (data.info === 'TRIP_GONE') throw new Error('这个行程已经删除或到期了，可以用以前导出的 JSON 文件导入');
  if (/^EDIT_CODE_/.test(data.info || '')) throw new Error('这个行程设了编辑口令：先打开它输一次口令再回来导入，或者用导出的 JSON 文件');
  if (data.info === 'UNAUTHORIZED') throw new Error('这台设备记住的编辑链接已经失效（可能被重置过），可以用导出的 JSON 文件导入');
  if (!res.ok) throw new Error(data.error || '没取到这个行程的成员');
  return data.config;
}

// 导出的 JSON：{ name, config } 或者直接是配置
export function peopleOfFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('不是这个工具导出的配置（JSON 格式不对）'); }
  const cfg = data?.config || data;
  if (!isPlain(cfg) || !Array.isArray(cfg.people)) throw new Error('不是这个工具导出的配置');
  return { label: data?.name || cfg.venue?.name || '导出的文件', people: cfg.people.filter(isPlain) };
}

export function openImportPeople() {
  const recent = caps.hasTrip ? store.get('carpool_trips', []).filter((t) => t.id !== state.tripId) : [];
  openDrawer('从别的行程导入成员', `
    <p class="muted">同一群人再出行时用：出发地、开不开车、空座、绕路上限、同行人数都带过来；车次、离场时间跟着这次的车站和日期变，不带。导入的成员加在现有成员后面。</p>
    ${caps.hasTrip ? `<h3 class="sec">这台设备打开过的行程</h3>
      ${recent.length ? `<div class="ip-trips">${recent.map((t) => `<button class="c-btn c-btn--sm" data-ip-trip="${esc(t.id)}">${esc(t.name || '未命名行程')}</button>`).join('')}</div>`
        : '<p class="muted">这台设备上还没有别的行程。</p>'}` : ''}
    <h3 class="sec">以前导出的配置</h3>
    <button class="c-btn c-btn--sm" data-ip-file>选择 JSON 文件</button><input type="file" accept=".json,application/json" data-ip-input hidden>
    <div id="ipOut" aria-live="polite"></div>`, 'import-people');
}

export async function loadFromTrip(id) {
  const t = store.get('carpool_trips', []).find((x) => x.id === id);
  $('#ipOut').innerHTML = '<div class="c-empty">正在取成员…</div>';
  try {
    const config = await fetchTripConfig(id, t?.key);
    showPeople({ label: t?.name || '这个行程', people: (config?.people || []).filter(isPlain) });
  } catch (e) {
    showError(e.message);
  }
}

export async function loadFromFile(file) {
  try { showPeople(peopleOfFile(await file.text())); } catch (e) { showError(e.message); }
}

function showError(msg) {
  $('#ipOut').innerHTML = `<div class="c-alert c-alert--danger" role="alert"><svg class="c-icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-alert"/></svg><div>${esc(msg)}</div></div>`;
}

const describe = (p) => [p.car_seats !== undefined ? `开车，空 ${p.car_seats} 座` : '不开车', Number(p.party) > 1 ? `${p.party} 人同行` : '',
  p.from ? `从 ${p.from}` : (p.location ? '已定位' : '没填出发地')].filter(Boolean).join(' · ');

function showPeople({ label, people }) {
  Object.assign(loaded, { label, people });
  const have = new Set(state.cfg.people.map((p) => (p.name || '').trim()).filter(Boolean));
  $('#ipOut').innerHTML = people.length ? `<h3 class="sec">「${esc(label)}」的成员（${people.length} 位）</h3>
    ${people.map((p, k) => {
      const dup = have.has((p.name || '').trim());
      return `<label class="c-pick-row${dup ? ' is-off' : ''}"><input type="checkbox" data-ip-pick="${k}"${dup ? ' disabled' : ' checked'}>
        <span>${esc(p.name || '未命名')}<small>${dup ? '已经有同名的成员，不导入' : esc(describe(p))}</small></span></label>`;
    }).join('')}
    <div class="row" style="margin-top:var(--sp-3)"><button class="c-btn c-btn--primary" data-ip-go>导入选中的成员</button></div>`
    : `<p class="muted">「${esc(label)}」里还没有成员。</p>`;
}

export function importPicked() {
  const picked = [...document.querySelectorAll('[data-ip-pick]:checked')].map((el) => loaded.people[Number(el.dataset.ipPick)]).filter(Boolean);
  if (!picked.length) { toast('先勾选要导入的成员'); return; }
  state.cfg.people.push(...picked.map(portable));
  markDirty();
  renderForm();
  closeDrawer();
  toast(`导入了 ${picked.length} 位成员。车次要按这次的候选车站重新填`, 4000);
}
