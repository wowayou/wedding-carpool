# 设计系统

以代码为准：`web/design.css` 放变量和组件，`/design`（`web/pages/design.html`）是在线样式指南，这份文档写规范和理由。方案见 [v3.2 计划](v3.2-plan.md) 的 A、B 两节。

## 原则

- 保留品牌：暖色纸底、赭红强调色。深色跟随系统，不提供切换按钮。
- 不加载网络字体和第三方样式，系统字体栈。
- 卡片用边框，只有浮层（弹窗、抽屉、下拉、轻提示）用阴影。
- 组件类名统一 `c-` 前缀，避免和页面里已有的类名冲突。

## 设计变量

浅色在 `:root`，深色按标准三段写：`@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {…} }` 和 `:root[data-theme=dark] {…}`，两段内容必须一致（构建时检查）。深色设 `color-scheme: dark`。`data-theme=light` 可以强制浅色，示例方案页目前用它，等方案页模板（`share.py`）支持深色后去掉。

| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f7f4ee` | `#161412` | 页面底色 |
| `--surface` | `#ffffff` | `#1f1c19` | 卡片、输入框 |
| `--surface-2` | `#f1ebe1` | `#28241f` | 次级底色、表头、悬停 |
| `--line` / `--line-strong` | `#e5ddd0` / `#cfc4b3` | `#35302a` / `#4a443c` | 分隔线 / 输入框边框 |
| `--ink` / `--ink-2` / `--ink-3` | `#221e1a` / `#5a5148` / `#857b70` | `#efe9e1` / `#bdb4a8` / `#8f867b` | 正文 / 次要文字 / 说明、占位 |
| `--accent` / `--accent-hover` | `#b4442c` / `#9a3722` | `#e47a5f` / `#f08e74` | 品牌、主按钮、链接 |
| `--accent-soft` / `--on-accent` | `#f7e8e2` / `#ffffff` | `#3b241d` / `#1a0f0b` | 强调底色 / 主按钮上的文字 |
| `--drive` `--ride` `--taxi` | `#15803d` `#c2620a` `#6b7280` | `#4ade80` `#f59e0b` `#9ca3af` | 开车 / 坐车、高铁 / 打车 |
| `--dest` `--station` | `#dc2626` `#2563eb` | `#f87171` `#60a5fa` | 目的地 / 车站 |
| `--ok` / `--ok-soft` | `#15803d` / `#ebf6ee` | `#4ade80` / `#13291b` | 成功 |
| `--warn` / `--warn-soft` | `#b45309` / `#fdf2e1` | `#fbbf24` / `#33270f` | 提醒 |
| `--danger` / `--danger-soft` | `#b91c1c` / `#fde9e7` | `#f87171` / `#3a1715` | 危险、错误 |
| `--info` / `--info-soft` | `#1d4ed8` / `#e9effc` | `#93c5fd` / `#16213a` | 信息 |

和计划表唯一的差别：浅色 `--ok-soft` 从 `#e7f4ea` 调成 `#ebf6ee`，因为 `--ok` 在原值上只有 4.42:1，不到 4.5:1。

### 对比度

`web/check-contrast.mjs` 按 WCAG 2.x 公式计算，`npm run build` 时会调用，不达标就让构建失败；`node web/check-contrast.mjs -v` 列出全部数值。要求：正文、次要文字、链接、状态色文字至少 4.5:1；说明文字（`--ink-3`）和不含文字的图形（地图线、标签圆点）至少 3:1。

| 前景 / 背景 | 浅色 | 深色 |
|---|---|---|
| `--ink` / `--bg`、`--surface`、`--surface-2` | 15.08、16.55、13.96 | 15.24、14.06、12.78 |
| `--ink-2` / `--bg`、`--surface`、`--surface-2` | 7.07、7.76、6.55 | 8.98、8.28、7.53 |
| `--ink-3` / `--bg`、`--surface` | 3.78、4.15 | 5.13、4.74 |
| `--accent` / `--bg`、`--surface`、`--accent-soft` | 5.03、5.52、4.63 | 6.34、5.85、4.98 |
| `--on-accent` / `--accent`、`--accent-hover` | 5.52、7.13 | 6.49、7.90 |
| `--ok`、`--warn`、`--danger`、`--info` / 各自的 soft | 4.53、4.53、5.54、5.81 | 8.86、8.75、5.78、8.87 |
| 同上 / `--surface` | 5.02、5.02、6.47、6.70 | 9.73、10.16、6.13、9.40 |
| `--drive`、`--ride`、`--taxi`、`--dest`、`--station` / `--bg` | 4.57、3.79、4.40、4.40、4.71 | 10.54、8.56、7.24、6.64、7.23 |

注意：浅色下 `--ink-3` 在 `--bg` 上只有 3.78:1，只用于占位符和辅助说明，别拿它写需要读的正文。

## 字体、字号、间距

- 字体栈：`-apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`；等宽 `ui-monospace, "SF Mono", Menlo, Consolas, monospace`。时刻、次数、金额用 `font-variant-numeric: tabular-nums`（类 `c-tnum`）。
- 字号 12 / 13 / 14 / 16 / 18 / 22 / 28 / 36 px（`--fs-*`）。正文 15px（内容页的 `c-prose` 用 16px），行高 1.65，标题行高 1.3 并 `text-wrap: balance`。
- 间距 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64（`--sp-1` 到 `--sp-8`）。圆角：控件 8、卡片 12、标签 999。
- 断点 640、960（页头在 800 以下收成菜单）。动效 150ms ease-out，`prefers-reduced-motion` 时关掉。
- 焦点：所有可交互元素 `:focus-visible` 有 2px 品牌色焦点框，偏移 2px。

## 组件

都在 `design.css`，示例见 `/design`。

- 按钮 `c-btn`：`--primary`、默认（次要）、`--ghost`、`--danger`（`--solid` 为实心）、`--link`；`--sm`、`--lg`；`.is-loading`、`disabled`。
- 表单：`c-input`、`c-select`、`c-textarea`、`c-check`（`--pill`）、`c-switch`、`c-field`（`__label`、`__hint`、`__error`，出错时加 `has-error`）。
- 容器：`c-card`（`--drive` `--ride` `--taxi` `--accent` 左边色条）、`c-tag`（`--ok` `--warn` `--danger` `--info` `--accent` `--drive` `--ride` `--taxi`）、`c-alert`（`--info` `--ok` `--warn` `--danger`）、`c-callout`。
- 浮层：弹窗 `dialog.c-modal`、抽屉 `dialog.c-drawer`（都用原生 `<dialog>`，`showModal()` 自带焦点管理和 Esc 关闭）、轻提示 `c-toasts` 加 `c-toast`。第二期用它们替换编辑页的 `alert` / `confirm` / `prompt`。
- 数据展示：`c-table-wrap` + `c-table`（窄屏横向滚动）、`c-tabs`、`c-steps`（`--row` 为横排）、`c-progress`（用 `--value`）、`c-empty`、`c-skeleton`。
- 页面结构：站点页头 `c-site-header`（含手机菜单 `c-nav-toggle`、「场景」下拉 `c-nav__group`）、页脚 `c-site-footer`、精简页头 `c-bar`、面包屑 `c-breadcrumb`；`c-container`、`c-prose`、`c-section`、`c-hero`、`c-faq`、`c-figure`。
- 图标：`web/partials/icons.svg` 是 sprite，24 网格、1.75 描边、`currentColor`。模板里写 `{{icon:car}}`，生成 `<svg class="c-icon"><use href="/icons.svg#i-car"/></svg>`。现有：car、train、taxi、pin、station、copy、external、print、menu、close、check、alert、info、plus、trash、map、edit、arrow-right、chevron-down、heart、users、briefcase、github。不用 emoji 当图标。

## 页面模板和构建

页头页脚只写一份，在 `web/partials/`：`header.html`、`footer.html`、`header-lite.html`（编辑页和管理页的精简页头，参数 `title`、`actions`）、`head-common.html`、`site-script.html`（页头交互，内嵌脚本，构建时算哈希放进 CSP）。页面源文件里写占位，`web/site.mjs` 在构建时替换：

- `<!-- head -->`：`<meta charset>`、公共 meta、title、description、canonical、Open Graph、Twitter 卡片、JSON-LD。
- `<!-- include:header -->`、`<!-- include:footer -->`、`<!-- include:header-lite title="…" actions='…' -->`。
- `<!-- crumbs -->`（面包屑）、`<!-- faq:键 -->`、`<!-- howto:键 -->`、`<!-- changelog -->`。
- `{{icon:名字}}`；导航当前项由页面路径自动判断；页脚版本号取 `package.json` 的 `version`，没有就省略；更新记录读根目录 `CHANGELOG.md`，没有就显示「暂无」。
- `<!-- notext -->…<!-- /notext -->`：这段不进 `llms-full.txt`。

页面清单、常见问题和指南步骤在 `web/site-data.mjs`。常见问题和步骤同一份数据既生成页面上的文字，又生成 FAQPage、HowTo 结构化数据，所以两边逐字一致。新加页面：在 `PAGES` 里加一项，写源文件，构建会自动加进 sitemap（`index: true` 时）和 CSP。

构建时的校验，失败就让构建报错：设计变量对比度；所有 JSON-LD 能 `JSON.parse`；FAQPage 和 HowTo 的文字在页面上找得到；占位没有残留；可收录页面没有 `noindex`、不收录页面有；每页有 `<main id="main">`；站内链接和锚点指向的页面、文件存在。

`/design` 和 `404` 是 `noindex`，不进 sitemap。`404.html` 不设 canonical，因为它会在任意错误地址下显示。

## 文案规范

- 站在用户一侧，口语、简短。定位是「先定个大方向、心里有个底」，细节同行的人再商量；别写得像精确承诺。
- 按钮用动词开头：「新建行程」「发布方案页」「计算方案」。
- 报错说清楚出了什么问题、怎么办，不只说「失败」。
- 引号用「」；说「不开车」，不说「无车」。
- 数字带单位，时间用 24 小时制。
- 不编造功能：拿不准的细节，去读 README 和代码确认。
