# 设计系统

以代码为准：`web/design.css` 放变量和组件，`/design`（`web/pages/design.html`）是在线样式指南，这份文档写规范和理由。方案见 [v3.2 计划](v3.2-plan.md) 的 A、B 两节。

## 原则

- 保留品牌：暖色纸底、赭红强调色。深色跟随系统，不提供切换按钮。
- 不加载网络字体和第三方样式，系统字体栈。
- 卡片用边框，只有浮层（弹窗、抽屉、下拉、轻提示）用阴影。
- 组件类名统一 `c-` 前缀，避免和页面里已有的类名冲突。
- **定稿的界面改动，先改这份规范，再改页面**（站长 2026-10-09 的要求）。规范改了、页面没改，或页面改了、规范没改，都算没做完；测试会核对规范里点名的函数和类名真实存在。

## 设计变量

浅色在 `:root`，深色按标准三段写：`@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {…} }` 和 `:root[data-theme=dark] {…}`，两段内容必须一致（构建时检查）。深色设 `color-scheme: dark`。`data-theme=light` 可以强制浅色。方案页模板（`share.py`）已经内嵌同一套变量并支持深色，示例方案页不再需要它。方案页在 CSP 沙箱里展示，不能引用 `/design.css`，所以变量内嵌在模板里，`test_carpool.py` 会解析 `design.css` 逐个比对，改颜色时两处要一起改。

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
- 浮层：弹窗 `dialog.c-modal`、抽屉 `dialog.c-drawer`（都用原生 `<dialog>`，`showModal()` 自带焦点管理和 Esc 关闭）、轻提示 `c-toasts` 加 `c-toast`。编辑页和管理页用它们替换了 `alert` / `confirm` / `prompt`：各封装成 `confirmDialog`、`promptDialog`、`alertDialog` 和 `toast`，确认按钮 `[data-dialog-ok]`、取消 `[data-dialog-cancel]`、输入框 `[data-dialog-input]`、错误提示 `[data-dialog-error]`；删除、重置、停用这类危险操作用 `c-btn--danger c-btn--solid`。
- 设置面板、估算和结果列表（v3.8，编辑页「推荐车站」抽屉用，用法见「交互规范」）：
  - `c-settings`：设置面板外壳，含 `__bar`（一行摘要加「改设置」按钮）、`__sum`、`__panel`、`__group`（`fieldset` 加 `legend`）、`__grid`、`__field`（`--wide` 占满一行）、`__foot`（展开时 `is-editing` 让它贴底）、`__actions`；
  - `c-unit-input`（`__unit`）：带单位的输入框；`c-choices`（`--stack` 竖排）：一组选项；
  - `c-estimate`：估算条；`c-why`（`--info`）：主按钮不能点的原因；`c-callout__list`：提示框里的列表；
  - `c-pick-row`：整行可点的勾选结果行（`is-off` 标灰）；`c-tags`：标签行，配合 `c-tag--best`、`c-tag--over` 两种标签；
  - `c-fold`（`__title`、`__row`）：默认收起、按原因分组的折叠区。
- 地图：`.leaflet-pane svg` 取消 `max-width`，页面自建的 Leaflet pane 里的 svg 不会被全局的 `svg { max-width: 100% }` 压成 0 宽。
- 数据展示：`c-table-wrap` + `c-table`（窄屏横向滚动）、`c-tabs`、`c-steps`（`--row` 为横排）、`c-progress`（用 `--value`）、`c-empty`、`c-skeleton`。
- 页面结构：站点页头 `c-site-header`（含手机菜单 `c-nav-toggle`、「场景」下拉 `c-nav__group`；右侧操作区 `c-nav__actions` 放「试玩」次要按钮和「新建行程」主按钮；导航当前页用 `--accent` 下划线标出）、页脚 `c-site-footer`（上半 `__top`：左边 `__intro` 是品牌、介绍和带下划线箭头的引导行 `__cta`，右边 `__cols` 四列链接，栏目标题加粗；`__bottom` 是底部小字；最下面是大字标 `c-wordmark`；页脚和页面同为 `--bg`，只靠细线分开，打印时整个隐藏）、精简页头 `c-bar`、面包屑 `c-breadcrumb`；`c-container`、`c-prose`、`c-section`、`c-hero`、`c-faq`、`c-figure`。
- 图标：`web/partials/icons.svg` 是 sprite，24 网格、1.75 描边、`currentColor`。模板里写 `{{icon:car}}`，生成 `<svg class="c-icon"><use href="/icons.svg#i-car"/></svg>`。现有：car、train、taxi、pin、station、copy、external、print、menu、close、check、alert、info、plus、trash、map、edit、arrow-right、chevron-down、heart、users、briefcase、github。不用 emoji 当图标。

## 交互规范

按编辑页（`ui.html`）现在实际的做法写，v3.8 的「推荐车站」是最完整的一例。每条写「什么时候用、怎么做、为什么」，并指出代码在哪。v3.10 拆编辑页时按这份来：拆分只换文件，不改这里写的行为。改这里写的行为，先改本节，再改页面。

### 抽屉和弹窗

- **侧边抽屉**：放「看着、改着、同时还要看地图」的内容，比如历史版本、更多、推荐车站。`openDrawer(title, html, panel)` 打开、`closeDrawer()` 关闭，页面里是 `aside#drawer`。它**不是模态**：地图和左边的表单仍然可以操作，不加遮罩，不抢焦点；`Esc` 关闭（没有弹窗开着时）。`panel` 参数标明开的是哪个面板，其他功能（比如地图图层）靠 `sugOpen()` 这类判断自己该不该显示。为什么：找站要一边调设置一边看地图上的圈，模态会挡住它。
- **弹窗**：只放「要用户确认或必须先处理的事」，比如删除、停止分享、换链接、出错、校验清单。用原生 `<dialog>` 加 `showModal()`，焦点管理和 `Esc` 由浏览器负责。页面里统一走 `openDialog()`，再包成 `confirmDialog()`、`promptDialog()`、`alertDialog()`；不用原生 `alert`、`confirm`、`prompt`（测试会拦）。确认键 `[data-dialog-ok]`，取消 `[data-dialog-cancel]`。
- **轻提示**：不需要回应的结果，比如「已复制」「加了 2 个车站」，用 `toast()`；错误用 `kind` 为 `danger`，停留更久。需要用户做决定的，不要用轻提示。
- `design.css` 里的 `dialog.c-drawer` 是模态抽屉（`showModal()`，有遮罩），需要盖住页面时才用，目前只在 `/design` 有示例；编辑页的抽屉要非模态，所以自己用 `.drawer` 实现，样式相近。新页面先想清楚要不要挡住后面的内容，再选。

### 设置面板

用于「有默认值、多数人不用改、但要能改」的一组参数。样式是 `c-settings` 一族。

- **折叠成一行摘要**：平时只显示一句话（`sgSummary()` 拼出来的，比如「目的地周边 90 公里 · 沿 2 位车主的路线每 30 公里搜 25 公里」），右边一个「改设置」按钮，点了展开成「收起设置」；改过的项数显示成 `c-tag--accent` 的「改了 N 项」。按钮有 `aria-expanded` 和 `aria-controls`。为什么：默认值能用，别让用户先读 13 项设置才能开始。展开时焦点移到第一个输入框。
- **分组**：用 `<fieldset class="c-settings__group">` 加 `<legend>`，一组 3 到 6 项（`SG_GROUPS`）；字段在组里按 `c-settings__grid` 自适应排列，长的选项用 `c-settings__field--wide` 占满一行。如果组标题和第一项的名字重复，第一项的名字只留给读屏（`c-sr-only`，参数 `quiet`），不显示两遍。
- **字段由 `config-fields.json` 生成**：中文名、默认值、范围、单位、可选项、说明都取自它，`sgFieldHtml()` 按类型出控件，页面里不写第二份（测试会查）。改定义，界面跟着变。只在页面里放「怎么分组、哪些项只在某个选择下才有意义」（`SG_ALONG_ONLY`）这类布局信息。
- **只存和默认值不同的项**：`setSuggest()` 写进 `cfg.options.suggest`，改回默认就删掉，全是默认时整个 `suggest` 都不留。为什么：以后调默认值，没改过设置的人自动跟着走；配置文件和历史版本里也干净。清空输入框等于回到默认。
- **超范围就地提示，不拦截**：`sgProblems()` 在输入框下面用 `c-field__error` 写明「要在 30 到 150 公里之间，现在会按 150 算」，输入框标红（`has-error`）、`aria-invalid`。后端会夹紧到范围内，所以不阻止输入，只把「会按多少算」说清楚。两项之间对不上的组合（比如搜索半径小于间隔的一半）同样处理。
- **带单位的输入框**：`c-unit-input`，单位写在框里右侧，只是视觉（`aria-hidden`），读屏靠标签和说明；数字框设 `inputmode`，手机上弹数字键盘。
- **选项**：单选只有 2 项时用胶囊（`c-choices` 加 `c-check--pill`），选项文字长（超过 10 个字）就竖排（`c-choices--stack`）；3 项以上的单选用 `c-select`；多选用胶囊；开关用 `c-switch`。多选和单选都包在带 `aria-labelledby` 的 `role="group"` 或 `role="radiogroup"` 里。
- **「恢复默认」**：放在面板底部，没改过时不能点（`disabled`），点了删掉整个 `suggest` 并重画。
- **别处改了设置**（一起编辑的人、导入、恢复历史）：抽屉开着时用 `sgSyncFromCfg()` 同步，正在输入的那一格不动。

### 先估算，再调用

用于「调一次要花额度或很久」的操作（高德地点搜索按次数算）。

- **设置一改就估算**：`scheduleSugEstimate()` 防抖 600 毫秒（`SG_ESTIMATE_DELAY`）再调 `runSugEstimate()`，估算会查车主路线、算出圈数和搜索次数，但不做地点搜索（`plan_only`），所以不花搜索次数，试玩模式也能用。用 `sug.seq` 让还在路上的旧估算作废；正在找的时候不估，找完再估。
- **结果放进 `aria-live="polite"` 的区域**（`#sgEst`）：用 `c-estimate` 写一句话「这次大约要 N 次地点搜索（单次上限 M）」，读屏会读到变化。
- **超上限时主按钮不能点，并写明原因**：`c-alert--warn` 写「这次至少要 106 次，超过单次上限 20 次（分别来自哪些圈）。把范围调小，或者把上限调高」；主按钮 `disabled`，原因同时写在按钮下面的 `c-why` 里。不能点一定要有原因，不能只是灰着。「翻页多的话可能到上限」只是提醒，不拦。
- **估算失败不卡住**：`c-alert--danger` 写「估算没成功：原因」加「重试估算」（`data-sg-retry-est`），估算失败时主按钮仍然可点（`c-why` 只在超上限、试玩、估算中这几种情况出现）；额度用完走 `showQuota()`。
- 估算期间显示灰字「正在估算…」，主按钮写明「正在估算，估完才能开始」。
- 填的内容没变时，重新打开抽屉沿用上次估算。

### 长操作的进度条

- 超过几秒的操作（计算方案、找站）：开始时 `startProgress(title)`，阶段变化时 `updateProgress()`，结束（成功、失败都要）`stopProgress()`，放在 `finally` 里。
- 页面顶部的条显示「标题：阶段 N/M · 已用 X 秒」；知道总数时画比例，不知道时画来回走的 `indeterminate` 条。抽屉里的操作，同样的文字也写进抽屉里的 `#drawerProgress`，用户盯着抽屉时也看得到。
- 为什么：第一次要查几十个点，可能一两分钟；有阶段、有计时，用户才知道没卡死。要多久说实话，不编百分比。
- 静态页面里的进度条是 `c-progress`（用 `--value`，加 `role="progressbar"`）。

### 地图上的过程图层

用于「把算法过程摊开给用户看」，比如找站的搜索圈和取样路线。

- **自建 pane，压在方案图层下面**：`map.createPane('sugPane')`，`zIndex` 350：Leaflet 自带的 `overlayPane`（方案路线）是 400，标记在 600，瓦片在 200，所以过程图层在地图上面、结果下面，不会盖住结果。图层里的东西 `interactive: false`，不抢点击。
- **颜色从语义变量取**：用 `themeVar('--station')`、`themeVar('--drive')` 在画的时候读当前主题的值，不写死色值；系统主题变化时重画（`drawSugLayer()`）。圈用浅色填充加细边，没搜的圈虚线加淡；路线用点线，和方案的实线区分。
- **svg 要取消最大宽度**：`design.css` 有全局的 `svg { max-width: 100% }`，Leaflet 只给自带的 `overlayPane` 取消了它，自建 pane 里的 svg 会被压成 0 宽。所以 `design.css` 里有 `.leaflet-pane svg { max-width: none }`，新建 pane 不用再处理。
- **图例**：图层显示时，地图图例多出对应的几行（`.legend-sug`，点线、浅色圈各一行）；图层隐藏时图例也隐藏。
- **开关**：抽屉里有一个 `c-switch`「在地图上显示找站过程」，默认开；`sug.layerOn` 记着，关了就从地图上拿掉。
- **什么时候显示，什么时候清**：`syncSugLayer()` 统一决定，规则是「开关开着，并且抽屉开在这个面板上（或手机上点了『去地图上看』）」。关抽屉就隐藏；重新计算方案时 `clearSugLayer()` 清掉，免得和方案的路线混在一起。
- **手机上**：抽屉盖住整个屏幕，地图看不到。抽屉里多一个「去地图上看」（`data-sg-map`，宽屏用 CSS 隐藏），点了收起抽屉、切到地图页签、保留图层，并用 `toast()` 说怎么回来。

### 结果列表

- **先汇总，后明细**：先一句话汇总（搜了多少、找到多少、去掉多少及原因），再写「这次的设置」，再是说明和提醒，最后才是逐条结果。用户先知道「大概怎么回事」，再看细节。
- **每人一个标签，按语义着色**（`sgTags()`，样式在 `c-tags`、`c-tag`）：该项里最好的用 `c-tag--accent c-tag--best`（强调色加粗），可用的用 `c-tag--ok`，超过上限的用 `c-tag--over`（灰底虚线，并写「超过上限」），所有人都超限的行整行加 `is-off`（`c-pick-row`）并加 `c-tag--danger`「车主都要绕很远」，量不出来的用无色 `c-tag`。含义不能只靠颜色：超限有文字、虚线边框，最好的有加粗；`title` 里写完整算法。
- **「没列出的」折叠起来，按原因分组**：`c-fold`，标题带总数，展开后每组一个小标题（`c-fold__title`，写原因和个数），括号里的补充说明写在标题下面，每个有坐标的可以单独「加入」；没有坐标的只列名字和原因，提示用「+ 手动添加」。`sgGroupBy()` 负责分组。为什么：这些是「系统为什么没给你」，要查得到，但不该挤占主要结果。
- **勾选加入**：结果行整行可点（`c-pick-row`）；已在候选里的禁用并标「已在候选站」；默认勾哪些由后端算好；确认键「加入选中的车站」，加完关抽屉并 `toast()` 说下一步。

### 记住上次结果，设置改了就提示更新

- 结果记在 `sug.result`，同时记下产生它的设置（`sug.resultKey`）；关了抽屉再开，仍显示上次的结果，不白找一遍。
- 设置和结果对不上时，顶部显示 `c-alert--info`（`role="status"`）：「设置改过了，点『重新找』更新。下面还是上一次的结果。」主按钮文字改成「重新找」。不自动重找，因为它花额度。
- 同样的做法用在方案上：`isStale()` 为真时，`updateStale()` 显示过期提示（`#stale`）并在「方案」页签上标感叹号（`updatePlanDot()`），要发布过期的方案会先 `confirmDialog()`。

### 出错和重试

- **报错说清楚出了什么、怎么办**，不只写「失败」。统一入口 `reportError(action, e)`：额度用完走 `showQuota()`（可以当场改用自己的高德 Key，已经停下，没有继续调用）；计算环境没加载出来（`envFail`）用 `confirmDialog()` 给「重试」，并说明填的内容都还在；其他用 `alertDialog()`，标题写「某某失败」。
- 抽屉里的区块出错：用 `c-alert--danger` 就地显示，旁边放重试按钮；不弹窗打断。已填的内容不能因为出错而丢。
- 保存失败：`alertDialog()`，标题「保存失败」；改动还在页面里，保存键上的「保存*」仍在，可以再点。

### 空状态

- `c-empty`：图标或一句话说明「现在没有什么」，再说「下一步做什么」，必要时带一个按钮。例：没有方案时 `renderEmptyPlan()` 引导去「填写」；没找到站时「可以手动添加，或者看下面没列出的站」；历史为空写「还没有历史版本」。
- 加载中也用它（「加载中…」），或 `c-skeleton`。不留空白。

### 危险操作要确认

- 删除、重置、停用、让旧链接失效这类不能撤销（或撤销代价大）的操作，一律先 `confirmDialog(..., { danger: true })`：确认键是 `c-btn--danger c-btn--solid`，写明后果（「所有人手里的旧链接立即失效」），**焦点默认落在「取消」上**。最重的（删除整个行程）用 `promptDialog()`，要求输入名称才能点。
- 可以找回的，在确认里写明在哪找回（「在线版可以在『历史』里找回」「点『恢复示例』可以找回」）。

### 试玩模式里不能用的功能

- **照常显示，但不能点，并写明原因**：试玩（`mode === 'try'`）不保存、不调用高德。「开始找」仍在，`disabled`，下面用 `c-why--info` 写「试玩不能实际搜索，新建行程后就能用」；设置、估算、地图上的搜索圈可以正常看，因为它们不花额度。
- 不要把功能藏起来：用户要知道有这个功能，以及怎么才能用上。原因里给出路。
- 判断只看 `mode`，不要在各处另写「是不是试玩」的变体。

### 表单什么时候校验

- **格式问题随时提示**（车次、时间、日期、数字范围、重名）：改动后稍等 450 毫秒（`decorateSoon()`）再标，免得边打字边报错；在输入框旁用 `c-field__error` 加红框，不弹窗。
- **缺少的内容**（没填名字、出发地）不一开始就红满屏：点了「计算方案」或「保存」失败后（`showRequired`）才标出来。
- 点了以后有问题，用 `problemsDialog()` 弹出可点的清单，点一条 `jumpTo()` 到那个输入框（手机上先切到「填写」，滚到中间、聚焦并闪一下）。
- 只提醒不拦的问题标 `soft`，不挡计算。
- 范围类的参数见上面的「设置面板」：就地提示，不拦。

### 占位文字显示默认值

- 有默认值的输入框，`placeholder` 写默认值本身（来自 `config-fields.json` 的 `default`），不写「请输入」。空着就表示「用默认」，所以才能「只存和默认值不同的项」。
- 占位文字颜色是 `--ink-3`，对比度只有 3 到 4.5:1，**只用来写默认值，别在里面写需要读的说明**；说明写在 `c-field__hint`。
- 标签始终显示在输入框上面，不拿占位文字当标签。

### 手机宽度下的约定

- 断点 960：宽屏填写、地图、方案三块同时显示；窄屏变成底部三个页签，`setPane()` 切换（`narrow` 媒体查询）。算完方案自动切到「方案」；要定位到字段先切到「填写」。
- 抽屉在手机上占满宽度（`min(420px, 100vw)`），所以要看地图的功能要有出口（「去地图上看」）。
- 弹窗在 640 以下占满宽度减 24px，按钮等分。
- 触控目标至少 32px 高（`c-btn--sm`），主要按钮 40px。底部要避开手机的安全区（`safe-area-inset-bottom`）。
- 设置面板展开时，估算和主按钮贴在抽屉底部（`c-settings.is-editing` 的 `c-settings__foot`，`position: sticky`），改一项就能看到估算怎么变，不用滚回去。
- 不依赖悬停：`title` 里的补充信息，重要的内容必须也写在页面文字里。

### 键盘操作和焦点

- 所有可交互元素有 `:focus-visible` 的 2px 焦点框（`design.css` 全局）；整行可点的行（`c-pick-row`）用 `:has(input:focus-visible)` 给整行画框，折叠区的 `summary` 同理。
- 弹窗打开时焦点落在输入框，没有输入框时落在确认键（危险操作落在取消）；`Esc` 取消；关闭后回到原来的位置由浏览器的 `<dialog>` 处理。
- 抽屉不抢焦点，`Esc` 关闭；展开设置时，焦点移到第一个输入框。
- 开关用 `role="switch"`，单选组用 `role="radiogroup"`，都带 `aria-labelledby`；提示变化的区域用 `aria-live="polite"`，弹出的轻提示在 `role="status"` 里；错误用 `aria-describedby` 关联到输入框。
- 点击目标不能是 `div`：用 `button`、`label`、`a`，这样键盘和读屏天然能用。

## 页面模板和构建

大字标 `c-wordmark`：页脚底部内嵌 SVG，单线画小写 carpool，桌面一行（`__svg--wide`），640px 以下分两行（`__svg--stack`），两份都带 `aria-hidden="true"`、`focusable="false"`。颜色规则：线条 `c-wordmark__line` 用 `--ink`，两个 o 是圆盘（`--station`、`--drive`）加中心小圆点（`--dest`、`--ride`），一条路线从 c 的起笔贯穿到 l 的收笔（两个 o 像站点串在路线上），只在起点和终点放 `--accent` 小圆点；桌面版的路线沿基线走，到 p 下方向下绕一个 U 形回环，p 的竖线落在回环底部；a、r 的竖线和 r 的肩是挂在基线上的独立笔画，r 的肩不和 p 相连（连起来会读成「canpool」）；手机版两行各一条路线，终点分别在 r 的肩端和 l 顶，起点在 p 的下伸底端，整幅字标没有十字交叉；**只用语义变量，SVG 里不写死色值**（深色模式自动跟着变），构建测试会检查。静态，不加动画。

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
