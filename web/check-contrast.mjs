// SPDX-License-Identifier: AGPL-3.0-or-later
// 检查 web/design.css 里设计变量的对比度（WCAG 2.x），构建时会调用，不达标就让构建失败。
// 单独运行：node web/check-contrast.mjs [-v]   （-v 列出每一对的数值，写规范时用）
// 同时检查「系统深色」和「手动深色」两段变量完全一致，避免改一处漏一处。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEXT = 4.5; // 正文、次要文字、链接、状态色文字
const AUX = 3; // 说明文字（--ink-3）和非文字的图形（地图线、标签点）

// [前景, 背景, 下限, 用途]
export const PAIRS = [
  ['ink', 'bg', TEXT, '正文'], ['ink', 'surface', TEXT, '正文（卡片）'], ['ink', 'surface-2', TEXT, '正文（次级底色）'],
  ['ink-2', 'bg', TEXT, '次要文字'], ['ink-2', 'surface', TEXT, '次要文字（卡片）'], ['ink-2', 'surface-2', TEXT, '次要文字（次级底色）'],
  ['ink-3', 'bg', AUX, '说明、占位'], ['ink-3', 'surface', AUX, '说明、占位（卡片）'],
  ['accent', 'bg', TEXT, '链接、品牌文字'], ['accent', 'surface', TEXT, '链接（卡片）'], ['accent', 'accent-soft', TEXT, '强调底色上的品牌文字'],
  ['accent-hover', 'bg', TEXT, '链接悬停'],
  ['on-accent', 'accent', TEXT, '主按钮文字'], ['on-accent', 'accent-hover', TEXT, '主按钮悬停文字'],
  ['ok', 'ok-soft', TEXT, '成功标签'], ['warn', 'warn-soft', TEXT, '提醒标签'], ['danger', 'danger-soft', TEXT, '危险标签'], ['info', 'info-soft', TEXT, '信息标签'],
  ['ok', 'surface', TEXT, '成功文字'], ['warn', 'surface', TEXT, '提醒文字'], ['danger', 'surface', TEXT, '错误文字'], ['info', 'surface', TEXT, '信息文字'],
  ['drive', 'bg', AUX, '开车（图形）'], ['ride', 'bg', AUX, '坐车（图形）'], ['taxi', 'bg', AUX, '打车（图形）'],
  ['dest', 'bg', AUX, '目的地（图形）'], ['station', 'bg', AUX, '车站（图形）'],
];

function blocks(css) {
  const grab = (re) => {
    const m = re.exec(css);
    if (!m) throw new Error(`design.css 里找不到变量段：${re}`);
    return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((x) => [x[1], x[2].toLowerCase()]));
  };
  return {
    light: grab(/^:root \{([^}]*)\}/m),
    darkAuto: grab(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme=light\]\) \{([^}]*)\}/),
    darkManual: grab(/^:root\[data-theme=dark\] \{([^}]*)\}/m),
  };
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export function checkContrast(css, { verbose = false } = {}) {
  const { light, darkAuto, darkManual } = blocks(css);
  const problems = [];
  for (const k of new Set([...Object.keys(darkAuto), ...Object.keys(darkManual)])) {
    if (darkAuto[k] !== darkManual[k]) problems.push(`深色两段变量不一致：--${k}（${darkAuto[k]} / ${darkManual[k]}）`);
  }
  const rows = [];
  for (const [theme, vars] of [['浅色', light], ['深色', { ...light, ...darkManual }]]) {
    for (const [fg, bg, min, use] of PAIRS) {
      if (!vars[fg] || !vars[bg]) { problems.push(`缺少变量 --${fg} 或 --${bg}`); continue; }
      const r = ratio(vars[fg], vars[bg]);
      rows.push({ theme, fg, bg, min, use, r, fgHex: vars[fg], bgHex: vars[bg] });
      if (r < min) problems.push(`${theme} --${fg}（${vars[fg]}）在 --${bg}（${vars[bg]}）上对比度 ${r.toFixed(2)}，低于 ${min}（${use}）`);
    }
  }
  if (verbose) for (const x of rows) console.log(`${x.theme}\t--${x.fg} on --${x.bg}\t${x.r.toFixed(2)}\t(>= ${x.min})\t${x.use}`);
  return { problems, rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems } = checkContrast(readFileSync(new URL('./design.css', import.meta.url), 'utf8'), { verbose: process.argv.includes('-v') });
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('对比度检查通过');
}
