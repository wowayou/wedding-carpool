// 模块之间的「事件」：下层模块通知上层模块，而不去 import 它（import 只能往下，不能成环）。
// 目前的事件：
//   rendered   表单重画完（form.js 发出；推荐车站的抽屉开着时，suggest.js 据此同步设置面板）
//   drawer     侧边面板开关（drawer.js 发出，参数 { open, keepSug }；sug-layer.js 据此显示或隐藏找站过程）
//   meta       别人改了行程名称（sync.js 发出；trip.js 据此刷新标题）
//   share      方案页的发布状态变了（sync.js 发出；menu.js 据此刷新「更多」）
//   reload     断线期间别人改过、本地没有改动，需要重新载入（sync.js 发出；trip.js 据此重新取配置）
//   conflicts  合并时同一格两边都改了（sync.js 发出；conflict.js 据此弹出提示）
export const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}

export function emit(name, ...args) {
  for (const fn of handlers.get(name) || []) fn(...args);
}

// 测试用：清掉所有订阅
export function clearHandlers() {
  handlers.clear();
}
