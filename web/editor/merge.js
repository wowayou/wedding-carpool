// ---------- 改动摘要（写进历史版本） ----------

import { clone, isPlain, same } from './util.js';

export function describeChanges(a, b) {
  if (!a || !b) return '';
  const out = [];
  if (!same(a.venue, b.venue)) out.push('改了目的地');
  if (!same(a.options, b.options)) out.push('改了选项');
  const names = (list) => (list || []).map((x) => x.name || '');
  const sa = names(a.stations), sb = names(b.stations);
  const added = sb.filter((n) => !sa.includes(n)), removed = sa.filter((n) => !sb.includes(n));
  if (added.length) out.push('加了车站 ' + added.join('、'));
  if (removed.length) out.push('删了车站 ' + removed.join('、'));
  const pa = new Map((a.people || []).map((p) => [p.name, p])), pb = new Map((b.people || []).map((p) => [p.name, p]));
  for (const [n] of pb) if (!pa.has(n)) out.push(`加了${n ? '成员 ' + n : '一位成员'}`);
  for (const [n] of pa) if (!pb.has(n)) out.push(`删了${n ? '成员 ' + n : '一位成员'}`);
  for (const [n, p] of pb) if (pa.has(n) && !same(pa.get(n), p)) out.push(`改了 ${n || '成员'}`);
  if (!out.length && !same(a, b)) out.push('小改动');
  return out.slice(0, 4).join('；') + (out.length > 4 ? ' 等' : '');
}

// ---------- 三方合并：只有我改了用我的，只有对方改了用对方的；同一处都改了以我为准，并记下冲突 ----------
export function merge3(base, mine, theirs, path = '', conflicts = null) {
  if (same(mine, base)) return clone(theirs);
  if (same(theirs, base) || same(mine, theirs)) return clone(mine);
  if (isPlain(base) && isPlain(mine) && isPlain(theirs)) {
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const v = merge3(base[k], mine[k], theirs[k], path ? `${path}.${k}` : k, conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if ([base, mine, theirs].every(Array.isArray) && mine.length >= base.length && theirs.length >= base.length) {
    // 没人删东西：原有的逐条合并，两边新加的都接在后面
    const n = base.length;
    return [...base.map((_, i) => merge3(base[i], mine[i], theirs[i], `${path}.${i}`, conflicts)),
      ...clone(mine.slice(n)), ...clone(theirs.slice(n))];
  }
  if (conflicts) conflicts.push({ path, mine: clone(mine), theirs: clone(theirs) });
  return clone(mine);
}

