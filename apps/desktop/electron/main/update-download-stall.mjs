/**
 * 下载停滞看门狗（download stall watchdog）。
 *
 * 背景（修复「离开一会回来后安装按钮消失」的另一半根因）：
 *   mac 自管 dmg 下载用的是 fetch + ReadableStream reader.read() 循环。
 *   系统睡眠期间 socket 可能被静默杀死——不抛错、不关闭，read() 永久
 *   挂起。下载停在某个百分比（用户截图里是 1%），既不前进也不报错，
 *   用户无从恢复。electron-updater 的下载链路同样存在这类「无进度也
 *   无错误」的挂起窗口。
 *
 * 契约：
 *   createDownloadStallWatchdog({ windowMs, now, onStall }) 返回一个
 *   句柄 { notifyProgress, stop }：
 *   - notifyProgress()：每次收到真实下载进度时调用。有进度 → 重置计时。
 *   - 窗口（windowMs）内没有任何进度 → 触发一次 onStall（只触发一次；
 *     触发后停止监控，由调用方决定置 error 态与兜底路径）。
 *   - stop()：下载正常结束/失败时调用，取消监控并清理定时器。
 *
 *   计时基准可注入（now），测试无需真实等待。定时器用 setTimeout
 *   unref 语义由调用方掌握（主进程持有 timer 引用，stop 时清理）。
 *
 * 纯逻辑模块：不做 IO、不认识 electron-updater，方便单测。
 */

export const DEFAULT_STALL_WINDOW_MS = 90 * 1000;

/**
 * 创建下载停滞看门狗。
 *
 * @param {object} options
 * @param {number} [options.windowMs] 停滞判定窗口，默认 90 秒。
 * @param {() => void} [options.onStall] 停滞触发回调。
 * @returns {{ notifyProgress: () => void, stop: () => void }}
 */
export function createDownloadStallWatchdog({
  windowMs = DEFAULT_STALL_WINDOW_MS,
  onStall,
} = {}) {
  let timer = null;
  let stalled = false;
  let stopped = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm() {
    clearTimer();
    if (stalled || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || stalled) return;
      stalled = true;
      try {
        onStall?.();
      } catch {
        /* 回调异常不应拖垮主流程 */
      }
    }, windowMs);
    // 不阻止进程退出（Electron 主进程常驻，但保持与清理链路一致）。
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function notifyProgress() {
    if (stopped || stalled) return;
    arm();
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  // 启动即开始计时：下载开始后 windowMs 内必须有第一次进度，
  // 否则视为停滞（覆盖「fetch 返回后 reader 立即挂起」的场景）。
  arm();

  return { notifyProgress, stop };
}
