// SPDX-License-Identifier: AGPL-3.0-or-later
// 静态站点的构建：把页面源文件里的占位换成页头、页脚、结构化数据等，写到 dist/。由 web/build.mjs 调用。
//
// 页面源文件里可以写的占位：
//   <!-- head -->                      生成 <meta charset> 之后的整个 <head> 公共部分：title、description、canonical、Open Graph、JSON-LD 等
//   <!-- include:名字 键="值" ... -->  插入 web/partials/名字.html，可以带参数（值里不能有双引号），分部里用 {{键}} 取
//   <!-- crumbs -->                    面包屑（按 site-data.mjs 里这一页的 crumbs）
//   <!-- faq:键 -->                    常见问题列表（同一份数据也生成 FAQPage）
//   <!-- howto:键 -->                  有序步骤列表（同一份数据也生成 HowTo）
//   <!-- changelog -->                 更新记录（读仓库根目录的 CHANGELOG.md，没有就显示「暂无」）
//   {{icon:名字}}、{{icon:名字|额外类名}}  内联图标（引用 /icons.svg）
//   {{cur:/路径}}                     当前页是这个路径（或它的子路径）时输出 aria-current="page"
//   {{curclass:/路径/}}               同上，但输出 " is-current"，给下拉分组用
//   {{version_html}}                  页脚的版本号，package.json 没有 version 就是空
//   <!-- notext -->…<!-- /notext -->  这一段不进 llms-full.txt
// 校验（失败就让构建报错）：所有 JSON-LD 必须能 JSON.parse；FAQPage 的问答要和页面可见文字逐字一致；占位不能残留；站内链接要能打开；设计变量对比度要达标。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkContrast } from './check-contrast.mjs';
import { AUTHOR, FAQS, HOWTO, IMAGE, ORIGIN, PAGES, REPO, SITE_NAME } from './site-data.mjs';

const read = (p) => readFileSync(p, 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unesc = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const partials = {};
const partial = (name) => (partials[name] ??= read(`web/partials/${name}.html`));
const beijingDate = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

// ---------- 版本号和更新记录（E3 负责这两个文件；不存在就兜底，不能让构建失败） ----------
function version() {
  try { return String(JSON.parse(read('package.json')).version || '').trim(); } catch { return ''; }
}

const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, (_, t, u) => `<a href="${u}"${u.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);

// CHANGELOG.md：「## 版本号（日期）」加列表。只支持这几种写法：## 版本、### 小标题、- 列表（缩进两格是子项）、普通段落
function changelogHtml() {
  let md = '';
  try { md = read('CHANGELOG.md'); } catch { /* 还没有这个文件 */ }
  const out = [];
  let open = false, list = 0; // list：当前在第几层列表
  const closeList = () => { while (list > 0) { out.push('</ul>'); list -= 1; } };
  const closeSection = () => { closeList(); if (open) out.push('</section>'); open = false; };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = /^##\s+(.+)$/.exec(line))) {
      closeSection(); open = true;
      out.push(`<section class="c-changelog-entry" id="v-${esc(m[1].replace(/[^\w.]+/g, '-').replace(/^-|-$/g, ''))}"><h2>${inline(m[1])}</h2>`);
    } else if (!open) {
      continue; // 第一个版本之前的标题和说明不显示
    } else if ((m = /^###\s+(.+)$/.exec(line))) {
      closeList(); out.push(`<h3>${inline(m[1])}</h3>`);
    } else if ((m = /^(\s*)[-*]\s+(.+)$/.exec(line))) {
      const depth = m[1].length >= 2 ? 2 : 1;
      while (list < depth) { out.push('<ul>'); list += 1; }
      while (list > depth) { out.push('</ul>'); list -= 1; }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if (line.trim()) {
      closeList(); out.push(`<p>${inline(line.trim())}</p>`);
    }
  }
  closeSection();
  const html = out.join('\n');
  return /<section/.test(html) ? html : '<div class="c-empty"><h3>暂无更新记录</h3><p>第一次发布版本后，这里会列出每个版本改了什么。</p></div>';
}

// ---------- 结构化数据 ----------
const abs = (p) => (p === '/' ? `${ORIGIN}/` : `${ORIGIN}${p}`);
const person = { '@type': 'Person', '@id': `${ORIGIN}/about#author`, name: AUTHOR.name, url: AUTHOR.url };
const personRef = { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url };

function faqLd(key) {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQS[key].map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
}

function jsonLd(kind, page) {
  const [type, key] = kind.split(':');
  const ctx = { '@context': 'https://schema.org' };
  switch (type) {
    case 'webapp':
      return { ...ctx, '@type': 'WebApplication', name: SITE_NAME, url: abs('/'), description: page.description, applicationCategory: 'TravelApplication', operatingSystem: 'Web', inLanguage: 'zh-CN', isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' }, license: 'https://www.gnu.org/licenses/agpl-3.0.html', author: personRef, codeRepository: REPO, image: IMAGE.url };
    case 'faq': return faqLd(key);
    case 'howto': {
      const h = HOWTO[key];
      return { ...ctx, '@type': 'HowTo', name: h.name, description: h.description, inLanguage: 'zh-CN', step: h.steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text, url: `${abs(page.path)}#step-${i + 1}` })) };
    }
    case 'article':
      return { ...ctx, '@type': 'Article', headline: page.title.replace(/ · .*$/, ''), description: page.description, inLanguage: 'zh-CN', dateModified: beijingDate(), mainEntityOfPage: abs(page.path), image: IMAGE.url, author: personRef, publisher: { '@type': 'Organization', name: SITE_NAME, url: abs('/') } };
    case 'about':
      return { ...ctx, '@type': 'AboutPage', name: page.title.replace(/ · .*$/, ''), url: abs(page.path), description: page.description, inLanguage: 'zh-CN', about: { '@type': 'WebApplication', name: SITE_NAME, url: abs('/') } };
    case 'person': return { ...ctx, ...person };
    case 'breadcrumb':
      return { ...ctx, '@type': 'BreadcrumbList', itemListElement: page.crumbs.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(path || page.path) })) };
    default: throw new Error(`${page.path}：不认识的结构化数据类型 ${kind}`);
  }
}

const ldScript = (obj) => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).replace(/</g, '\\u003c')}\n</script>`;

function headHtml(page) {
  const canonical = abs(page.path);
  const lines = ['<meta charset="utf-8">', partial('head-common').trim()];
  if (!page.ownHead) {
    lines.push(`<title>${esc(page.title)}</title>`, `<meta name="description" content="${esc(page.description)}">`);
    if (page.path !== '/404') lines.push(`<link rel="canonical" href="${canonical}">`); // 404 页会在任意错误地址下显示，不设规范地址
    if (!page.index) lines.push('<meta name="robots" content="noindex">');
    if (page.index) {
      lines.push(
        `<meta property="og:type" content="${page.og || 'website'}">`, `<meta property="og:title" content="${esc(page.title)}">`,
        `<meta property="og:description" content="${esc(page.description)}">`, `<meta property="og:url" content="${canonical}">`,
        '<meta property="og:locale" content="zh_CN">', `<meta property="og:site_name" content="${SITE_NAME}">`,
        `<meta property="og:image" content="${IMAGE.url}">`, `<meta property="og:image:width" content="${IMAGE.width}">`, `<meta property="og:image:height" content="${IMAGE.height}">`,
        `<meta property="og:image:alt" content="${esc(IMAGE.alt)}">`,
        '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(page.title)}">`,
        `<meta name="twitter:description" content="${esc(page.description)}">`, `<meta name="twitter:image" content="${IMAGE.url}">`,
      );
    }
  }
  for (const kind of page.ld || []) lines.push(ldScript(jsonLd(kind, page)));
  return lines.join('\n');
}

// ---------- 页面里的组件 ----------
const crumbsHtml = (page) => (page.crumbs
  ? `<nav class="c-breadcrumb" aria-label="面包屑"><ol>${page.crumbs.map(([name, path], i) => (i === page.crumbs.length - 1
    ? `<li aria-current="page">${esc(name)}</li>` : `<li><a href="${path}">${esc(name)}</a></li>`)).join('')}</ol></nav>` : '');

const faqHtml = (key) => {
  if (!FAQS[key]) throw new Error(`没有这组常见问题：${key}`);
  return `<div class="c-faq">\n${FAQS[key].map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}\n</div>`;
};

function howtoHtml(key) {
  if (!HOWTO[key]) throw new Error(`没有这组步骤：${key}`);
  return `<ol class="c-steps">\n${HOWTO[key].steps.map((s, i) => `<li id="step-${i + 1}"><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></li>`).join('\n')}\n</ol>`;
}

const iconHtml = (name, extra = '') => `<svg class="c-icon${extra ? ` ${extra}` : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
const isCurrent = (cur, path) => (path.endsWith('/') ? cur.startsWith(path) : cur === path || cur.startsWith(`${path}/`));

function expand(html, page, params = {}, depth = 0) {
  if (depth > 4) throw new Error('include 嵌套太深');
  let out = html.replace(/<!--\s*include:([\w-]+)((?:\s+\w+=(?:"[^"]*"|'[^']*'))*)\s*-->/g, (_, name, attrs) => {
    const p = Object.fromEntries([...attrs.matchAll(/(\w+)=(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], m[2] ?? m[3]]));
    return expand(partial(name), page, p, depth + 1);
  });
  out = out.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in params ? params[k] : all));
  return out;
}

export function render(src, page) {
  let html = src.replace(/<!--\s*head\s*-->/, () => headHtml(page));
  html = expand(html, page);
  const v = version();
  html = html
    .replace(/<!--\s*crumbs\s*-->/g, () => crumbsHtml(page))
    .replace(/<!--\s*faq:(\w+)\s*-->/g, (_, k) => faqHtml(k))
    .replace(/<!--\s*howto:(\w+)\s*-->/g, (_, k) => howtoHtml(k))
    .replace(/<!--\s*changelog\s*-->/g, () => changelogHtml())
    .replace(/\{\{icon:([\w-]+)(?:\|([^}]*))?\}\}/g, (_, n, c) => iconHtml(n, c))
    .replace(/\{\{cur:([^}]+)\}\}/g, (_, p) => (isCurrent(page.path, p) ? ' aria-current="page"' : ''))
    .replace(/\{\{curclass:([^}]+)\}\}/g, (_, p) => (isCurrent(page.path, p) ? ' is-current' : ''))
    .replace(/\{\{version_html\}\}/g, v ? ` 版本 <a href="/changelog">v${esc(v.replace(/^v/, ''))}</a>。` : '');
  return html;
}

// ---------- 校验 ----------
const textOf = (html) => unesc(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

function validate(page, html) {
  const where = `${page.out}：`;
  const left = /\{\{[^}]*\}\}|<!--\s*(include|faq|howto|crumbs|head|changelog)\b/.exec(html.replace(/<script\b(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, ''));
  if (left) throw new Error(`${where}有没替换的占位 ${left[0]}`);
  const body = textOf(html);
  const kinds = [];
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(json); } catch (e) { throw new Error(`${where}JSON-LD 不是合法的 JSON：${e.message}`); }
    if (data['@context'] !== 'https://schema.org') throw new Error(`${where}JSON-LD 缺少 @context`);
    kinds.push(data['@type']);
    if (data['@type'] === 'FAQPage') {
      for (const q of data.mainEntity) {
        for (const t of [q.name, q.acceptedAnswer.text]) if (!body.includes(t.replace(/\s+/g, ' '))) throw new Error(`${where}FAQPage 的文字在页面上找不到：${t.slice(0, 30)}…`);
      }
    }
    if (data['@type'] === 'HowTo') {
      for (const s of data.step) for (const t of [s.name, s.text]) if (!body.includes(t)) throw new Error(`${where}HowTo 的文字在页面上找不到：${t.slice(0, 30)}…`);
    }
  }
  for (const kind of page.ld || []) {
    const need = { webapp: 'WebApplication', faq: 'FAQPage', howto: 'HowTo', article: 'Article', about: 'AboutPage', person: 'Person', breadcrumb: 'BreadcrumbList' }[kind.split(':')[0]];
    if (!kinds.includes(need)) throw new Error(`${where}缺少 ${need} 结构化数据`);
    const [type, key] = kind.split(':');
    if (type === 'faq' && !html.includes(`<div class="c-faq">`)) throw new Error(`${where}声明了 faq:${key}，但页面上没有放 <!-- faq:${key} -->`);
    if (type === 'howto' && !html.includes('<ol class="c-steps">')) throw new Error(`${where}声明了 howto:${key}，但页面上没有放 <!-- howto:${key} -->`);
  }
  if (!/<main\b[^>]*id="main"/.test(html)) throw new Error(`${where}缺少 <main id="main">`);
  if (page.index === false && !/<meta name="robots" content="noindex"/.test(html)) throw new Error(`${where}不收录的页面要有 noindex`);
  if (page.index && /noindex/.test(html)) throw new Error(`${where}可收录的页面不能有 noindex`);
}

// 站内链接：以 / 开头的 href 和 src 必须指向 dist 里存在的页面或文件（/t/、/p/、/api/ 由 Worker 处理，不查）
function checkLinks(dist, pages) {
  const ids = new Map();
  for (const page of pages) ids.set(page.path, [...readFileSync(join(dist, page.out), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const page of pages) {
    const html = readFileSync(join(dist, page.out), 'utf8');
    for (const [, url] of html.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)) {
      const [pathAndQuery, hash] = url.split('#');
      const path = pathAndQuery.split('?')[0];
      if (/^\/(t|p|api)\//.test(path) || path === '//') continue;
      const exists = /\.\w+$/.test(path) ? existsSync(join(dist, path)) : path === '/' || existsSync(join(dist, `${path}.html`));
      if (!exists) throw new Error(`${page.out}：链接 ${url} 指向的页面或文件不存在`);
      const target = pages.find((x) => x.path === path);
      if (hash && target && !ids.get(target.path).includes(hash)) throw new Error(`${page.out}：链接 ${url} 的锚点 #${hash} 在目标页面上不存在`);
    }
  }
}

// ---------- llms-full.txt：把页面正文转成纯文本 ----------
function mainText(html) {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html);
  if (!m) return '';
  return unesc(m[1]
    .replace(/<!--\s*notext\s*-->[\s\S]*?<!--\s*\/notext\s*-->/g, '')
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<nav class="c-breadcrumb"[\s\S]*?<\/nav>/g, '')
    .replace(/<p class="c-eyebrow">[\s\S]*?<\/p>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<li[^>]*>\s*<h([1-4])[^>]*>/g, (_, n) => `\n\n${'#'.repeat(Number(n) + 1)} `)
    .replace(/<h([1-4])[^>]*>/g, (_, n) => `\n\n${'#'.repeat(Number(n) + 1)} `)
    .replace(/<\/h[1-4]>/g, '\n\n')
    .replace(/<summary[^>]*>/g, '\n\n### ')
    .replace(/<\/summary>/g, '\n\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<\/(p|div|section|article|details|ul|ol|table|figure)>/g, '\n\n')
    .replace(/<\/tr>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(td|th)>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ')).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 主流程 ----------
export function buildSite(dist = 'dist') {
  const css = read('web/design.css');
  const { problems } = checkContrast(css);
  if (problems.length) throw new Error(`design.css 对比度检查没通过：\n${problems.join('\n')}`);

  cpSync('web/design.css', `${dist}/design.css`);
  cpSync('web/partials/icons.svg', `${dist}/icons.svg`);
  const today = beijingDate();
  const csp = {};
  const texts = {};
  for (const page of PAGES) {
    const html = render(read(page.src), page);
    validate(page, html);
    const file = join(dist, page.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    csp[page.out] = page.csp || '';
    texts[page.path] = mainText(html);
  }
  checkLinks(dist, PAGES);

  // sitemap：所有可收录的页面，lastmod 取构建日期（北京时间）
  const urls = PAGES.filter((p) => p.index).map((p) => `  <url><loc>${abs(p.path)}</loc><lastmod>${today}</lastmod></url>`).join('\n');
  writeFileSync(`${dist}/sitemap.xml`, read('web/sitemap.xml').replace('<!-- urls -->', urls));
  // llms.txt 原样复制；llms-full.txt 里的 {{text:/路径}} 换成该页正文，{{faq:键}} 换成问答全文
  cpSync('web/llms.txt', `${dist}/llms.txt`);
  const full = read('web/llms-full.txt')
    .replace(/\{\{text:([^}]+)\}\}/g, (_, p) => { if (!(p in texts)) throw new Error(`llms-full.txt：没有页面 ${p}`); return texts[p]; })
    .replace(/\{\{faq:(\w+)\}\}/g, (_, k) => FAQS[k].map(([q, a]) => `### ${q}\n\n${a}`).join('\n\n'))
    .replace(/\{\{date\}\}/g, today);
  if (/\{\{[^}]*\}\}/.test(full)) throw new Error('llms-full.txt 有没替换的占位');
  writeFileSync(`${dist}/llms-full.txt`, full);
  return { csp };
}
