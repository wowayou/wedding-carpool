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

// v3.6 页眉页脚：大字标不占读屏、不写死颜色；页眉操作区有「试玩」和「新建行程」
test('页脚大字标：SVG 不占读屏，fill 和 stroke 不写死色值', () => {
  const b = build({});
  try {
    assert.equal(b.child.status, 0, b.child.stderr);
    for (const f of ['index.html', 'guide.html', '404.html']) {
      const html = b.read(f);
      const svgs = [...html.slice(html.indexOf('<footer')).matchAll(/<svg\b[^>]*class="c-wordmark__svg[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0]);
      assert.equal(svgs.length, 2, `${f}：桌面和手机各一份大字标`);
      for (const svg of svgs) {
        assert.match(svg, /^<svg\b[^>]*aria-hidden="true"/, `${f}：大字标 SVG 要有 aria-hidden`);
        assert.match(svg, /focusable="false"/);
        assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bstyle=/, `${f}：SVG 里不能写死颜色或内联样式`);
        for (const [, v] of svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) assert.match(v, /^(currentColor|none|var\(--[\w-]+\))$/, `${f}：fill/stroke 只能用 currentColor 或变量，不能是 ${v}`);
      }
    }
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('页眉操作区有「试玩」(/try) 和「新建行程」(/#create)，页脚有试玩引导', () => {
  const b = build({});
  try {
    assert.equal(b.child.status, 0, b.child.stderr);
    for (const f of ['index.html', 'privacy.html', '404.html']) {
      const html = b.read(f);
      const actions = /<div class="c-nav__actions">([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
      assert.match(actions, /href="\/try"/, `${f}：页眉缺 /try`);
      assert.match(actions, /href="\/#create"/, `${f}：页眉缺 /#create`);
      assert.match(html, /class="c-site-footer__cta" href="\/try"/, `${f}：页脚缺试玩引导`);
    }
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

// 静态页面的 CSP 在构建时（web/build.mjs）检查：script-src 只能是本站、cdnjs 和内嵌脚本的哈希
test('方案页的 CSP 不放行第三方统计脚本（隐私页写了 Cloudflare 自动注入的会被拦下）', () => {
  const worker = readFileSync('web/worker.js', 'utf8');
  const share = worker.slice(worker.indexOf('const SHARE_CSP'), worker.indexOf('];', worker.indexOf('const SHARE_CSP')));
  assert.match(share, /"script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com"/);
  assert.doesNotMatch(worker, /cloudflareinsights/);
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

// 试玩页（/try）：构建时把编辑页复制成 try.html，CSP 一致，示例数据一起进 dist。
// 要跑完整构建（会重写 dist/）；依赖缓存（.cache/vendor）不在时需要联网下载，这里直接跳过
test('构建产物里有试玩页 try.html 和 try-trip.json，CSP 与编辑页一致', { skip: !existsSync('.cache/vendor') && '没有依赖缓存，先 npm run build 一次' }, () => {
  const child = spawnSync(process.execPath, ['web/build.mjs'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const edit = readFileSync('dist/edit.html', 'utf8'), tryPage = readFileSync('dist/try.html', 'utf8');
  assert.equal(tryPage, edit); // 同一个文件：模式由页面按路径判断
  const csp = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp(tryPage));
  assert.equal(csp(tryPage), csp(edit));
  assert.match(csp(tryPage), /script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  assert.match(tryPage, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(tryPage, /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/); // CDN 地址已换成 /vendor/
  assert.deepEqual(JSON.parse(readFileSync('dist/try-trip.json', 'utf8')), JSON.parse(readFileSync('web/try-trip.json', 'utf8')));
  assert.match(readFileSync('wrangler.jsonc', 'utf8'), /"run_worker_first": \[[^\]]*"\/try"/);
});
