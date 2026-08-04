import type { I18nRuntime } from '@peer-agent/i18n';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useUpdater } from '../state/useUpdater';
import { UpdateModal } from './UpdateModal';

/**
 * VersionBadge —— 侧边栏品牌区右侧的版本徽标（表达层）。
 *
 * 行为（按确认的产品设计）：
 *   - 始终展示当前版本号（vX.Y.Z）。
 *   - 有可用更新时（available）：版本号旁显示更新图标，与版本号共享点击入口。
 *   - 下载中（downloading）：更新图标原地升级为 mini 环形进度 + 百分比文字。
 *   - 下载完成（downloaded / ready-to-open）：版本号旁持久挂「安装」按钮
 *     （Codex 模式），不再弹出右下角 toast。
 *   - 点击版本号：打开更新摘要弹窗（无更新时顺带触发一次检查）。
 *   - 点击「安装」按钮：直接触发安装，不打开弹窗。
 *
 * 能力真相在主进程，本组件通过 useUpdater 消费状态与动作。
 */
export function VersionBadge({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, hasUpdate, check, download, install, openInstaller, openReleasePage } =
    useUpdater();
  const [modalOpen, setModalOpen] = useState(false);
  // 跨组件连续性（C1 时序衔接）：点「更新」后 download() 是异步转调主进程，
  // phase 要等主进程首个 download-progress 事件才变 downloading。若不处理，
  // 弹窗已朝左上角收缩消失、而进度环尚未挂载，中间出现空窗、视线断裂。
  // pendingDownload 让徽标在点击瞬间立即显示 0% 进度环（脉冲+光环就绪），
  // 正好接住飞来的弹窗；真实 downloading/终态到来后即清除。
  const [pendingDownload, setPendingDownload] = useState(false);

  const phase = status?.phase;
  // 一旦进入下载中或任一终态，pending 使命完成，清除以交还真相给主进程状态。
  useEffect(() => {
    if (!pendingDownload) return;
    if (
      phase === 'downloading' ||
      phase === 'downloaded' ||
      phase === 'ready-to-open' ||
      phase === 'error'
    ) {
      setPendingDownload(false);
    }
  }, [phase, pendingDownload]);

  if (!status) return null;

  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded' || phase === 'ready-to-open';
  const isAvailable = hasUpdate && !isDownloading && !isReady;
  const readyVersion = status.availableVersion ?? '';
  // 展示进度：真实 downloading 或「刚点更新、进度环已就位但主进程事件还没到」的过渡态。
  const showProgress = isDownloading || pendingDownload;
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  // 过渡期还没有真实进度，显示 0%，让进度环以「起步脉冲」形态接住视线。
  const progressPercent = isDownloading ? percent : 0;

  const handleClick = () => {
    // 下载中：打开下载进度弹窗，绝不触发检测（进度由弹窗内进度条 + 徽标环形进度表达）。
    if (isDownloading) {
      setModalOpen(true);
      return;
    }
    setModalOpen(true);
    if (!hasUpdate) {
      void check();
    }
  };

  // 完成态安装按钮的 label：Windows = 重启安装；mac = 安装。
  const installLabel =
    phase === 'ready-to-open'
      ? i18n.t('updater.badge.openInstaller')
      : i18n.t('updater.badge.install');

  const handleInstall = () => {
    if (phase === 'ready-to-open') {
      void openInstaller();
    } else {
      void install();
    }
  };

  const title = isDownloading
    ? i18n.t('updater.badge.downloading', { percent })
    : isReady
      ? i18n.t('updater.badge.ready', { version: readyVersion })
      : hasUpdate
        ? i18n.t('updater.badge.updateAvailable')
        : status.phase === 'checking'
          ? i18n.t('updater.badge.checking')
          : i18n.t('updater.badge.upToDate');

  return (
    <>
      <div className={`sidebar-version-badge ${hasUpdate ? 'has-update' : ''}`}>
        <button
          type="button"
          className="sidebar-version-text-btn"
          title={title}
          aria-label={hasUpdate ? i18n.t('updater.badge.ariaHasUpdate') : title}
          onClick={handleClick}
        >
          <span className="sidebar-version-text">v{status.currentVersion}</span>
          {import.meta.env.DEV ? (
            <span className="sidebar-version-dev-tag" aria-label="开发版本">
              开发
            </span>
          ) : null}
          {isAvailable ? (
            <span className="sidebar-version-update-icon">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v9" />
                <path d="m8.5 12.5 3.5 3.5 3.5-3.5" />
              </svg>
            </span>
          ) : null}
        </button>

        {showProgress ? (
          <span
            className="sidebar-version-progress"
            style={{ '--progress': `${progressPercent}%` } as CSSProperties}
            title={title}
            aria-label={title}
          >
            <span className="sidebar-version-progress-ring" aria-hidden="true" />
            <span className="sidebar-version-progress-text">{progressPercent}%</span>
          </span>
        ) : null}

        {isReady ? (
          <button
            type="button"
            className="sidebar-version-install-btn"
            onClick={handleInstall}
            title={title}
          >
            {installLabel}
          </button>
        ) : null}
      </div>

      <UpdateModal
        i18n={i18n}
        open={modalOpen}
        status={status}
        onClose={() => setModalOpen(false)}
        onUpdate={() => {
          // 先就位进度环，再触发异步下载 + 收起弹窗，保证视线不断。
          setPendingDownload(true);
          void download();
          setModalOpen(false);
        }}
        onOpenReleasePage={() => void openReleasePage()}
        onRecheck={() => void check()}
      />
    </>
  );
}
