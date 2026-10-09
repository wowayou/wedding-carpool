// 能力表：这个模式能做什么、文案怎么写。启动时由 backend.js 按模式生成一次（initBackend），其他模块只读它，不再判断模式。
// 这里只放对象本身，让界面模块读它时不必依赖 backend.js（backend.js 要用到进度条，进度条也要读它，放在一起会成环）。
export const caps = {};

export function setCaps(next) {
  for (const k of Object.keys(caps)) delete caps[k];
  Object.assign(caps, next);
}
