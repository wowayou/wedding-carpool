// SPDX-License-Identifier: AGPL-3.0-or-later
// 标签互相遮挡时的取舍（沿用编辑页 map.js 的 declutter 规则）：按优先级（数字小的在前）逐个放，
// 和已经放下的矩形重叠就隐藏；同一优先级保持原来的先后顺序。items：[{ priority, rect: { left, top, right, bottom } }]，返回每项是否显示
export function declutter(items) {
  const order = items.map((it, i) => [it.priority ?? 5, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const shown = new Array(items.length).fill(false);
  const placed = [];
  for (const [, i] of order) {
    const r = items[i].rect;
    if (placed.some((p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top)) continue;
    placed.push(r);
    shown[i] = true;
  }
  return shown;
}
