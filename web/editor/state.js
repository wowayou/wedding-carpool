// 各模块共享的可变状态：都放在这里，用对象的属性读写（ES 模块里不能给 import 进来的变量重新赋值）。
// 只在这里放「多个模块都要读写」的东西；只有一个模块用的状态留在那个模块里。
export const state = {
  cfg: null, // 当前配置（行程）
  dirty: false, // 有没存的改动
  synced: null, // 在线版：上一次和服务器对齐的配置，三方合并的基准
  version: null, // 在线版：服务器上的版本号
  tripId: null, // 在线版：行程编号
  result: null, // 最近一次算出的方案
  resultHash: null, // 算方案时的配置指纹，用来判断方案是否过期
  active: 0, // 去程选中的方案
  activeBack: 0, // 返程选中的方案
  viewLeg: 'out', // 地图正在画去程（out）还是返程（back）
  peers: [], // 在线的人
  fitted: false, // 预览地图已经缩放过
  showRequired: false, // 点过「计算方案」以后，才把缺少的必填项标出来
};

export const trip = {}; // 行程信息（名称、保留期、方案页、口令……）；本地版只有 file
export const me = { clientId: Math.random().toString(36).slice(2), name: '' };

// 推荐车站的界面状态（设置面板、估算、结果）。设置面板、地图图层、抽屉都要读，所以放在这里
export const sug = {
  settingsOpen: false, est: null, estKey: null, estBusy: false, estErr: null, pending: false, seq: 0, timer: null,
  running: false, result: null, resultKey: null, error: null, checked: {}, layerOn: true, peek: false, fitted: false, trace: null,
};
export const sgSettingsKey = () => JSON.stringify(state.cfg?.options?.suggest || {});

export const outboundOn = () => state.cfg.options?.outbound !== false; // 规划去程（默认是）

// 方案过期：算方案之后配置又改过了（成员备注不算）
export const configHash = () => JSON.stringify({ ...state.cfg, people: (state.cfg.people || []).map(({ note, ...p }) => p) });
export const isStale = () => Boolean(state.result) && state.resultHash !== configHash();

// 测试用：回到刚启动的样子
export function resetState() {
  Object.assign(state, { cfg: null, dirty: false, synced: null, version: null, tripId: null, result: null, resultHash: null, active: 0, activeBack: 0,
    viewLeg: 'out', peers: [], fitted: false, showRequired: false });
  for (const k of Object.keys(trip)) delete trip[k];
  Object.assign(sug, { settingsOpen: false, est: null, estKey: null, estBusy: false, estErr: null, pending: false, seq: 0, timer: null,
    running: false, result: null, resultKey: null, error: null, checked: {}, layerOn: true, peek: false, fitted: false, trace: null });
}
