// ---------- 表单上的操作：搜索与定位、增删成员和车站、改车站名、开关车 ----------

import { backend } from './backend.js';
import { caps } from './caps.js';
import { confirmDialog, toast } from './dialogs.js';
import { refreshDerived, renderForm, rerenderKeepingFocus } from './form.js';
import { showQuota } from './overlay.js';
import { getPath, setPath } from './paths.js';
import { state } from './state.js';
import { markDirty } from './sync.js';
import { esc, isQuotaError } from './util.js';

export const candidates = {}; // 每个输入框最近一次的搜索结果

// ---------- 搜索与定位 ----------
export async function search(base, textKey) {
  const q = (getPath(`${base}.${textKey}`) || '').trim();
  const box = document.querySelector(`[data-cands="${base}"]`);
  if (!q) { toast('先输入要搜索的名称'); return; }
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
  const city = r.city || cityFromDetail(r.detail);
  if (city && !getPath(`${base}.city`)) setPath(`${base}.city`, city);
  if (base === 'venue' && !state.cfg.venue.name) state.cfg.venue.name = r.name;
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

