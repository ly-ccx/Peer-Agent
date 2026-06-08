import { useEffect, useState } from 'react';

type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateInfo {
  version?: string;
  percent?: number;
  message?: string;
}

/**
 * 轻量更新横幅组件
 *
 * 状态流转: idle → available → downloading → downloaded
 * 放在 AppHeader 下方或底部状态栏均可。
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle');
  const [info, setInfo] = useState<UpdateInfo>({});

  useEffect(() => {
    const api = (window as any).zeusAtlas;
    if (!api?.onUpdateAvailable) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      api.onUpdateAvailable((data: any) => {
        setState('available');
        setInfo({ version: data.version });
      }),
    );

    unsubs.push(
      api.onUpdateProgress((data: any) => {
        setState('downloading');
        setInfo((prev) => ({ ...prev, percent: data.percent }));
      }),
    );

    unsubs.push(
      api.onUpdateDownloaded((data: any) => {
        setState('downloaded');
        setInfo((prev) => ({ ...prev, version: data.version }));
      }),
    );

    unsubs.push(
      api.onUpdateError((data: any) => {
        setState('error');
        setInfo({ message: data.message });
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, []);

  if (state === 'idle') return null;

  const handleDownload = () => {
    const api = (window as any).zeusAtlas;
    api?.updateDownload?.();
    setState('downloading');
    setInfo((prev) => ({ ...prev, percent: 0 }));
  };

  const handleInstall = () => {
    const api = (window as any).zeusAtlas;
    api?.updateInstall?.();
  };

  const handleDismiss = () => {
    setState('idle');
    setInfo({});
  };

  return (
    <div className="update-banner">
      {state === 'available' && (
        <>
          <span className="update-banner-text">
            新版本 <strong>{info.version}</strong> 可用
          </span>
          <button type="button" className="update-banner-btn" onClick={handleDownload}>
            下载更新
          </button>
          <button type="button" className="update-banner-dismiss" onClick={handleDismiss}>
            稍后
          </button>
        </>
      )}

      {state === 'downloading' && (
        <>
          <span className="update-banner-text">正在下载更新...</span>
          <div className="update-banner-progress">
            <div
              className="update-banner-progress-bar"
              style={{ width: `${info.percent ?? 0}%` }}
            />
          </div>
          <span className="update-banner-percent">{(info.percent ?? 0).toFixed(0)}%</span>
        </>
      )}

      {state === 'downloaded' && (
        <>
          <span className="update-banner-text">
            更新已就绪 <strong>{info.version}</strong>
          </span>
          <button type="button" className="update-banner-btn" onClick={handleInstall}>
            重启安装
          </button>
          <button type="button" className="update-banner-dismiss" onClick={handleDismiss}>
            稍后
          </button>
        </>
      )}

      {state === 'error' && (
        <>
          <span className="update-banner-text update-banner-error">
            更新失败: {info.message}
          </span>
          <button type="button" className="update-banner-dismiss" onClick={handleDismiss}>
            关闭
          </button>
        </>
      )}
    </div>
  );
}
