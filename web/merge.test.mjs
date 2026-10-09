// SPDX-License-Identifier: AGPL-3.0-or-later
// 编辑页三方合并函数（web/editor/merge.js）的测试：直接 import merge3 跑。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from './editor/merge.js';
test('配置三方合并', () => {
const base = { venue: { name: '饭店' }, people: [{ name: '老王', car_seats: 3 }, { name: '小陈' }] };
// 改不同字段：都保留
assert.deepEqual(merge3(base, { ...base, venue: { name: '新饭店' } }, { ...base, people: [base.people[0], { name: '小陈', note: '晚到' }] }),
  { venue: { name: '新饭店' }, people: [{ name: '老王', car_seats: 3 }, { name: '小陈', note: '晚到' }] });
// 我改老王座位，对方加了一个人：都保留
assert.deepEqual(merge3(base, { ...base, people: [{ name: '老王', car_seats: 2 }, { name: '小陈' }] },
  { ...base, people: [...base.people, { name: '新人' }] }).people,
  [{ name: '老王', car_seats: 2 }, { name: '小陈' }, { name: '新人' }]);
// 两边各加一个人：都保留
assert.equal(merge3(base, { ...base, people: [...base.people, { name: 'A' }] }, { ...base, people: [...base.people, { name: 'B' }] }).people.length, 4);
// 同一字段都改：以我的为准
assert.equal(merge3(base, { ...base, venue: { name: '我改的' } }, { ...base, venue: { name: '他改的' } }).venue.name, '我改的');
// 我删字段、对方没动：删掉
assert.deepEqual(merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }), { a: 1 });
// 对方删了一个人、我没改：跟对方
assert.equal(merge3(base, base, { ...base, people: [base.people[0]] }).people.length, 1);
});

test('同一格都改了：以我的为准，并记下冲突供提示', () => {
  const base = { people: [{ name: '老王', car_seats: 3 }], venue: { name: 'A' } };
  const conflicts = [];
  const out = merge3(base, { people: [{ name: '老王', car_seats: 2 }], venue: { name: 'A' } },
    { people: [{ name: '老王', car_seats: 4 }], venue: { name: 'B' } }, '', conflicts);
  assert.deepEqual(out, { people: [{ name: '老王', car_seats: 2 }], venue: { name: 'B' } });
  assert.deepEqual(conflicts, [{ path: 'people.0.car_seats', mine: 2, theirs: 4 }]);
});
