// ---------- 表单上的操作：搜索与定位、增删成员和车站、改车站名、开关车 ----------

import { backend } from './backend.js';
import { caps } from './caps.js';
import { confirmDialog, toast } from './dialogs.js';
import { pickedRows, refreshDerived, renderForm, rerenderKeepingFocus, syncPicked } from './form.js';
import { showQuota } from './overlay.js';
import { getPath, setPath } from './paths.js';
import { parseShared } from './shared-place.js';
import { state } from './state.js';
import { markDirty } from './sync.js';
import { esc, isQuotaError } from './util.js';

export const candidates = {}; // 每个输入框最近一次的搜索结果

// ---------- 搜索与定位 ----------
// 粘贴来的分享（高德链接、坐标）直接给一个候选，不调用高德；分享文字里的链接和套话去掉后再搜
export async function search(base, textKey) {
  const typed = (getPath(`${base}.${textKey}`) || '').trim();
  const box = document.querySelector(`[data-cands="${base}"]`);
  if (!typed) { toast('先输入要搜索的名称'); return; }
  const shared = base.startsWith('stations.') ? null : parseShared(typed);
  if (shared?.location) {
    candidates[base] = [{ name: shared.name || '分享的位置', detail: `分享的位置，坐标 ${shared.location}（按高德坐标）`, location: shared.location, shared: true }];
    box.innerHTML = `<button data-pick="${base}" data-k="0">${esc(candidates[base][0].name)}<small>${esc(candidates[base][0].detail)}</small></button>`;
    return;
  }
  const q = shared?.query || typed;
  box.innerHTML = '<button disabled>搜索中…</button>';
  try {
    const { results } = await backend.search(q, getPath(`${base}.city`), base.startsWith('stations.'));
    candidates[base] = results;
    box.innerHTML = results.length
      ? results.map((r, k) => `<button data-pick="${base}" data-k="${k}">${esc(r.name)}<small>${esc(r.detail)}</small></button>`).join('')
      : '<button disabled>没找到，换个说法试试</button>';
  } catch (e) {
    box.innerHTML = `<button disabled>${esc(e.message)}</button>`;
    if (caps.quota && isQuotaError(e.message)) showQuota(e.message);
  }
}

export function cityFromDetail(detail) {
  const m = String(detail || '').match(/(?:省|自治区)?([^省市区县]{2,}?市)/);
  return m ? m[1] : '';
}

export function pick(base, k) {
  const r = candidates[base][k];
  setPath(`${base}.location`, r.location);
  const city = r.city || (r.shared ? '' : cityFromDetail(r.detail));
  if (city && !getPath(`${base}.city`)) setPath(`${base}.city`, city);
  if (base === 'venue' && !state.cfg.venue.name && !(r.shared && !r.name)) state.cfg.venue.name = r.name;
  // 粘贴的是一整段分享文字时，地址框里换成认出来的名称，免得留着链接
  const textKey = base === 'venue' ? 'address' : 'from';
  if (r.shared && r.name !== '分享的位置' && /https?:\/\/|\d+\.\d{3,}/.test(getPath(`${base}.${textKey}`) || '')) setPath(`${base}.${textKey}`, r.name);
  state.fitted = false;
  markDirty();
  rerenderKeepingFocus();
  toast(`已定位：${r.name}`);
}

// 计算或推荐时按文字定位到的坐标写回配置，下次不再请求
export function applyResolved(list) {
  let n = 0;
  for (const r of list || []) {
    if (getPath(`${r.path}.location`)) continue;
    setPath(`${r.path}.location`, r.location);
    if (r.city && !getPath(`${r.path}.city`)) setPath(`${r.path}.city`, r.city);
    n += 1;
  }
  if (n) { markDirty(); rerenderKeepingFocus(); }
  return n;
}

// ---------- 增删改 ----------
export function addItem(kind) {
  if (caps.fixedSample) return;
  if (kind === 'station') state.cfg.stations.push({ name: '' });
  if (kind === 'driver') state.cfg.people.push({ name: '', from: '', car_seats: 3 });
  if (kind === 'rider') state.cfg.people.push({ name: '', from: '' });
  markDirty();
  renderForm();
}

export async function deleteItem(path) {
  const [list, idx] = path.split('.');
  const item = state.cfg[list][Number(idx)];
  if (!await confirmDialog(caps.text.deleteHint, { title: `删除${list === 'people' ? '成员' : '车站'}「${item?.name || '未命名'}」？`, okText: '删除', danger: true })) return;
  state.cfg[list].splice(Number(idx), 1);
  if (list === 'stations') state.cfg.people.forEach((p) => ['rail_min', 'trains', 'return_trains'].forEach((k) => p[k] && delete p[k][item.name]));
  markDirty();
  renderForm();
}

// 勾选的几个车站一起删；它们的车次、用时一起清掉，和单个删除一样
export async function deleteStations() {
  const rows = new Set(pickedRows());
  const doomed = state.cfg.stations.filter((_, i) => rows.has(i));
  if (!doomed.length) { toast('先勾选要删除的车站'); return; }
  const names = doomed.map((s) => s.name || '未命名').join('、');
  if (!await confirmDialog(`${names}。这些站的车次和用时会一起删掉。${caps.text.deleteHint}`, { title: `删除 ${doomed.length} 个候选站？`, okText: '删除', danger: true })) return;
  state.cfg.stations = state.cfg.stations.filter((_, i) => !rows.has(i));
  const left = new Set(state.cfg.stations.map((s) => s.name));
  for (const s of doomed) {
    if (left.has(s.name)) continue; // 同名的站还留着一个，它的车次不能删
    state.cfg.people.forEach((p) => ['rail_min', 'trains', 'return_trains'].forEach((k) => p[k] && delete p[k][s.name]));
  }
  state.pickedStations.clear();
  markDirty();
  renderForm();
  toast(`删掉了 ${doomed.length} 个候选站`);
}

export function renameStation(i, input) {
  const oldName = input.dataset.old, newName = input.value.trim();
  if (oldName === newName) return;
  for (const p of state.cfg.people) {
    for (const key of ['rail_min', 'trains', 'return_trains']) {
      if (p[key] && oldName in p[key]) {
        if (newName) p[key][newName] = p[key][oldName];
        delete p[key][oldName];
      }
    }
  }
  // 原地改：名字相关的 data 属性、标签和无障碍文字，不重建表单
  input.dataset.old = newName;
  syncPicked(); // 勾选按站名记，改名后跟着换
  for (const el of document.querySelectorAll('#form [data-station]')) {
    if (el.dataset.station !== oldName) continue;
    el.dataset.station = newName;
    const label = el.getAttribute('aria-label');
    if (label && label.startsWith(oldName)) el.setAttribute('aria-label', newName + label.slice(oldName.length));
    if (!newName && 'value' in el && !el.matches('input[data-station-name]')) el.value = ''; // 站名清空后，这一站的车次、用时已被删掉
    const row = el.closest('.rail-row');
    const name = row && row.firstElementChild;
    if (name && name.tagName === 'SPAN') { name.textContent = newName; name.title = newName; }
  }
  markDirty();
  refreshDerived();
}

export function toggleCar(i, on) {
  const p = state.cfg.people[i];
  if (on) { p.car_seats = 3; delete p.pickup_at_home; delete p.party; delete p.return_trains; }
  else { delete p.car_seats; delete p.max_detour_min; }
  markDirty();
  renderForm();
}

export function setStationValue(i, key, station, value) {
  const p = state.cfg.people[i];
  p[key] ??= {};
  if (value === '') delete p[key][station]; else p[key][station] = value;
  if (!Object.keys(p[key]).length) delete p[key];
  markDirty();
}

