import type { UpdaterStatus } from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

/**
 * useUpdater —— 渲染层消费更新能力的统一入口（表达层）。
 *
 * 能力真相在主进程：本 hook 只负责
 *   - 拉取初始状态快照（updaterGetStatus）
 *   - 订阅主进程广播的 updater:event 并据此刷新本地状态
 *   - 暴露 check / download / install / setChannel 动作（均转调主进程）
 *
 * 设计要点：
 *   - hasUpdate：phase=available|downloading|downloaded 时为 true（侧边栏据此显示红点）。
 *   - 同一份状态可被侧边栏徽标与设置面板共享，避免双事实源。
 */
export interface UseUpdaterResult {
  readonly status: UpdaterStatus | null;
  readonly hasUpdate: boolean;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly install: () => Promise<void>;
  /** mac 自管下载完成后打开 dmg 安装包（phase='ready-to-open' 时调用）。 */
  readonly openInstaller: () => Promise<void>;
  /** 兜底：打开当前版本的 GitHub Release 页面（mac 下载失败时调用）。 */
  readonly openReleasePage: () => Promise<void>;
  readonly setChannel: (preference: UpdaterStatus['preference']) => Promise<void>;
}

const FALLBACK: UpdaterStatus = {
  currentVersion: '0.0.0',
  channel: 'stable',
  preference: 'auto',
  enabled: false,
  phase: 'idle',
};

export function useUpdater(): UseUpdaterResult {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  // 初始快照。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await clientApi.updaterGetStatus();
        if (!cancelled) setStatus(snapshot ?? FALLBACK);
      } catch {
        if (!cancelled) setStatus(FALLBACK);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅主进程事件，增量合并到状态快照。
  useEffect(() => {
    const unsubscribe = clientApi.onUpdaterEvent((event) => {
      setStatus((prev) => {
        const base = prev ?? FALLBACK;
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
            return { ...base, phase: 'error', error: event.message };
          default:
            return base;
        }
      });
    });
    return unsubscribe;
  }, []);

  const check = useCallback(async () => {
    try {
      const next = await clientApi.updaterCheck();
      if (next) setStatus(next);
    } catch {
      /* 错误经 updater:event(error) 反映 */
    }
  }, []);

  const download = useCallback(async () => {
    try {
      const next = await clientApi.updaterDownload();
      if (next) setStatus(next);
    } catch {
      /* 错误经 updater:event(error) 反映 */
    }
  }, []);

  const install = useCallback(async () => {
    try {
      await clientApi.updaterInstall();
    } catch {
      /* 安装会触发退出，异常忽略 */
    }
  }, []);

  const openInstaller = useCallback(async () => {
    try {
      const next = await clientApi.updaterOpenInstaller();
      if (next) setStatus(next);
    } catch {
      /* 打开失败由主进程兜底（回退打开 Release 页面） */
    }
  }, []);

  const openReleasePage = useCallback(async () => {
    try {
      const next = await clientApi.updaterOpenReleasePage();
      if (next) setStatus(next);
    } catch {
      /* 打开外链失败，忽略 */
    }
  }, []);

  const setChannel = useCallback(async (preference: UpdaterStatus['preference']) => {
    try {
      const next = await clientApi.updaterSetChannel(preference);
      if (next) setStatus(next);
    } catch {
      /* 错误经 updater:event(error) 反映 */
    }
  }, []);

  const phase = status?.phase;
  const hasUpdate =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded' ||
    phase === 'ready-to-open';

  return {
    status,
    hasUpdate,
    check,
    download,
    install,
    openInstaller,
    openReleasePage,
    setChannel,
  };
}
