// SPDX-License-Identifier: AGPL-3.0-or-later
// 静态站点构建的 SITE_ORIGIN / SITE_INDEXABLE：官方构建、自部署（默认不收录）、自部署且显式允许收录。
// 每种模式在子进程里把站点构建到临时目录（环境变量在 web/site-data.mjs 加载时读取，所以要分开进程）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const OFFICIAL = 'https://carpool.eigentime.org';

function build(env) {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const f of ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'demo-shot.png', 'demo-shot.webp']) cpSync(`web/${f}`, join(dir, f));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import { buildSite } from './web/site.mjs'; buildSite(process.argv[1]);", dir], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  return { dir, child, read: (p) => readFileSync(join(dir, p), 'utf8'), has: (p) => existsSync(join(dir, p)) };
}
const htmlFiles = (dir, base = dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? htmlFiles(p, base) : n.endsWith('.html') ? [p.slice(base.length + 1)] : [];
});

test('官方构建：可收录页面没有 noindex，有 sitemap 和 llms，robots 指向官方 sitemap', () => {
  const b = build({});
  try {
    assert.equal(b.child.status, 0, b.child.stderr);
    assert.doesNotMatch(b.read('index.html'), /<meta name="robots"/);
    assert.match(b.read('index.html'), new RegExp(`rel="canonical" href="${OFFICIAL}/"`));
    assert.match(b.read('demo.html'), new RegExp(`rel="canonical" href="${OFFICIAL}/demo"`));
    assert.match(b.read('404.html'), /noindex/);
    assert.match(b.read('robots.txt'), /Allow: \//);
    assert.match(b.read('robots.txt'), new RegExp(`Sitemap: ${OFFICIAL}/sitemap.xml`));
    assert.match(b.read('sitemap.xml'), new RegExp(`<loc>${OFFICIAL}/guide</loc>`));
    assert.match(b.read('sitemap.xml'), new RegExp(`<loc>${OFFICIAL}/guide/method</loc>`));
    assert.match(b.read('llms.txt'), new RegExp(`${OFFICIAL}/guide/method`));
    assert.match(b.read('llms-full.txt'), /计算规则（第 1 版）/);
    assert.match(b.read('guide/method.html'), /href="\/guide\/method"/); // 页脚里的入口
    assert.ok(b.has('llms.txt') && b.has('llms-full.txt'));
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('自部署（换了域名、没设 SITE_INDEXABLE）：全部 noindex、robots 全禁、没有 sitemap 和 llms', () => {
  const b = build({ SITE_ORIGIN: 'https://example.com/' }); // 末尾的斜杠会被去掉
  try {
    assert.equal(b.child.status, 0, b.child.stderr);
    for (const f of htmlFiles(b.dir)) assert.match(b.read(f), /<meta name="robots" content="noindex">/, `${f} 缺少 noindex`);
    assert.equal(b.read('robots.txt'), 'User-agent: *\nDisallow: /\n');
    for (const f of ['sitemap.xml', 'llms.txt', 'llms-full.txt']) assert.ok(!b.has(f), `不该生成 ${f}`);
    assert.match(b.read('index.html'), /rel="canonical" href="https:\/\/example.com\/"/);
    assert.match(b.read('demo.html'), /rel="canonical" href="https:\/\/example.com\/demo"/);
    assert.doesNotMatch(b.read('guide.html'), /<link rel="canonical" href="https:\/\/carpool\.eigentime\.org/);
    assert.match(b.read('guide.html'), /"url": "https:\/\/example.com\/guide/); // 结构化数据里的地址也跟着换
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('自部署且 SITE_INDEXABLE=1：可收录页面没有 noindex，sitemap、robots、llms 里都是自己的域名', () => {
  const b = build({ SITE_ORIGIN: 'https://example.com', SITE_INDEXABLE: '1' });
  try {
    assert.equal(b.child.status, 0, b.child.stderr);
    assert.doesNotMatch(b.read('index.html'), /<meta name="robots"/);
    assert.match(b.read('robots.txt'), /Sitemap: https:\/\/example.com\/sitemap.xml/);
    for (const f of ['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt']) {
      assert.ok(b.has(f), `缺少 ${f}`);
      assert.ok(!b.read(f).includes(OFFICIAL), `${f} 里还有官方域名`);
    }
    assert.match(b.read('sitemap.xml'), /<loc>https:\/\/example.com\/guide<\/loc>/);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('SITE_ORIGIN 写错（没有协议、带路径）会让构建报错', () => {
  for (const bad of ['example.com', 'https://example.com/app']) {
    const b = build({ SITE_ORIGIN: bad });
    try {
      assert.notEqual(b.child.status, 0, `${bad} 应该报错`);
      assert.match(b.child.stderr, /SITE_ORIGIN/);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  }
});
