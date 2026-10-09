// ---------- 进度：长操作分阶段显示（在线版由 Pyodide 里的计算报告阶段，本地版只显示已用时间） ----------

import { caps } from './caps.js';
import { $ } from './util.js';

let progressState = null, progressTimer = null;
export function startProgress(title) {
  progressState = { title, label: caps.computeInBrowser ? '准备中' : '计算中', done: null, total: null, start: Date.now() };
  $('#progress').hidden = false;
  clearInterval(progressTimer);
  progressTimer = setInterval(renderProgress, 1000);
  renderProgress();
}
export function updateProgress(p) {
  if (!progressState) return;
  Object.assign(progressState, p);
  renderProgress();
}
export function stopProgress() {
  clearInterval(progressTimer);
  progressState = null;
  $('#progress').hidden = true;
}
export function renderProgress() {
  const s = progressState;
  if (!s) return;
  const counted = s.total ? ` ${Math.min(s.done + 1, s.total)}/${s.total}` : '';
  const text = `${s.title}：${s.label}${counted} · 已用 ${Math.round((Date.now() - s.start) / 1000)} 秒`;
  $('#progressText').textContent = text;
  $('#progressBar').style.width = s.total ? `${Math.round((100 * s.done) / s.total)}%` : '';
  $('#progressBar').classList.toggle('indeterminate', !s.total);
  const inDrawer = document.getElementById('drawerProgress');
  if (inDrawer) inDrawer.textContent = text;
}

