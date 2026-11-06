import type { UpdaterEvent, UpdaterStatus } from '@peer-agent/protocol';

/**
 * 把主进程 updater 事件并进渲染层快照。
 *
 * 已下载或已失败之后不再接受 download-progress。字节下完时经常还会
 * 补一条 100% 的进度；若把它写回 downloading，进度弹窗会停在满格，
 * 安装按钮也不会出现。
 */
export function reduceUpdaterStatus(base: UpdaterStatus, event: UpdaterEvent): UpdaterStatus {
  switch (event.type) {
    case 'checking-for-update':
      return { ...base, phase: 'checking', error: undefined };
    case 'update-available':
      return {
        ...base,
        phase: 'available',
        availableVersion: event.version,
        releaseNotes: event.releaseNotes ?? base.releaseNotes,
        error: undefined,
      };
    case 'update-not-available':
      return { ...base, phase: 'not-available', availableVersion: undefined };
    case 'download-progress':
      if (base.phase === 'downloaded' || base.phase === 'error') return base;
      return { ...base, phase: 'downloading', percent: event.percent ?? base.percent };
    case 'update-downloaded':
      return {
        ...base,
        phase: 'downloaded',
        percent: 100,
        availableVersion: event.version ?? base.availableVersion,
        releaseNotes: event.releaseNotes ?? base.releaseNotes,
      };
    case 'error':
      return {
        ...base,
        phase: 'error',
        error: event.message,
        releaseUrl: event.releaseUrl ?? base.releaseUrl,
      };
    default:
      return base;
  }
}
