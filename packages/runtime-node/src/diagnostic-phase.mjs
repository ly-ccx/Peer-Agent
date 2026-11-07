/**
 * 主进程诊断分段。默认不输出。
 * 桌面探针装上之后，只接收调用方传来的阶段名和数字。
 * 这里不接受计划标识、正文或路径。
 */
let observer = null;

export function setDiagnosticPhaseObserver(next) {
  const previous = observer;
  observer = typeof next === 'function' ? next : null;
  return previous;
}

export function noteDiagnosticPhase(name, fields) {
  if (typeof observer !== 'function') return;
  try { observer(name, fields); } catch { /* 诊断失败不能改变读路径或巡检。 */ }
}
