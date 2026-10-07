// 页面里三方合并函数的测试：从 ui.html 里取出 merge3 单独跑。运行：npm test
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('../ui.html', import.meta.url), 'utf8');
const src = ['clone', 'same', 'isPlain'].map((n) => html.match(new RegExp(`const ${n} = .*;`))[0]).join('\n')
  + '\n' + html.match(/function merge3[\s\S]*?\n}\n/)[0];
const merge3 = new Function(src + '; return merge3;')();
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
