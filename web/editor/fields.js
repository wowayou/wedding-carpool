// ---------- 配置项定义（config-fields.json：默认值、范围、单位、中文名只在那里写一处） ----------
// 在线/试玩由构建产物提供，本地版由 ui.py 提供；启动时先加载，再画表单
let FIELDS = {};
// 用定义列表（config-fields.json 的 fields）换掉当前定义。启动时用它，测试里也用它换成改过的定义
export function setFields(list) {
  FIELDS = Object.fromEntries(list.map((f) => [f.path, f]));
}
export async function loadFields() {
  const res = await fetch('/config-fields.json');
  if (!res.ok) throw new Error(`加载配置项定义失败（${res.status}）`);
  setFields((await res.json()).fields);
}
// 表单里的路径 people.3.max_detour_min → 定义里的 people[].max_detour_min；各站的用时 people.3.rail_min.某站 → people[].rail_min
export const fieldOf = (path) => {
  const p = String(path).replace(/^(people|stations)\.\d+(?=\.|$)/, '$1[]');
  const parent = FIELDS[p.replace(/\.[^.]*$/, '')];
  return FIELDS[p] || (parent?.type === 'map' ? parent : undefined);
};
export const defaultOf = (path) => fieldOf(path)?.default;
export const noteOf = (path) => fieldOf(path)?.default_note || '';
// 输入框占位：写明的示例，否则是默认值（没有固定默认值的不显示）
export const placeholderOf = (path) => { const f = fieldOf(path); return f?.placeholder ?? (f && f.default !== undefined && typeof f.default !== 'object' ? String(f.default) : ''); };

