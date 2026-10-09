import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdateChannelPreference } from '@peer-agent/protocol';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUpdater } from '../state/useUpdater';
import { UpdateModal } from './UpdateModal';
import { Dropdown } from './Dropdown';
import { versionBadgeLabel } from './versionBadgeLabel';
import { PeerIcon } from '../../ui/icons';

/**
 * VersionBadge —— 侧边栏品牌区右侧的版本徽标（表达层）。
 *
 * 行为（按确认的产品设计）：
 *   - 始终展示当前版本号（vX.Y.Z）。
 *   - 有可用更新时（available）：版本号旁显示更新图标，与版本号共享点击入口。
 *   - 下载中（downloading）：Bot 页脚显示横向进度条与百分比；经典界面保留进度环。
 *   - 下载完成（downloaded）：版本号旁持久挂「安装」按钮
 *     （Codex 模式），不再弹出右下角 toast。
 *   - 点击版本号：打开更新摘要弹窗（无更新时顺带触发一次检查）。
 *   - 点击「安装」按钮：直接触发安装，不打开弹窗。
 *
 * 能力真相在主进程，本组件通过 useUpdater 消费状态与动作。
 */
export function VersionBadge({ i18n, showChannel = false, variant = 'classic' }: {
  readonly i18n: I18nRuntime;
  readonly showChannel?: boolean;
  readonly variant?: 'classic' | 'bot-footer';
}) {
  const { status, hasUpdate, check, download, install, openReleasePage, setChannel } = useUpdater();
  const [modalOpen, setModalOpen] = useState(false);
  const badgeRef = useRef<HTMLDivElement>(null);
  const progressTarget = useCallback(() => badgeRef.current?.querySelector<HTMLElement>('.sidebar-version-progress') ?? badgeRef.current, []);
  // Reserve the visible destination until the host publishes download state.
  const [pendingDownload, setPendingDownload] = useState(false);

  const phase = status?.phase;
  // 一旦进入下载中或任一终态，pending 使命完成，清除以交还真相给主进程状态。
  useEffect(() => {
    if (!pendingDownload) return;
    if (phase === 'downloading' || phase === 'downloaded' || phase === 'error') {
      setPendingDownload(false);
    }
  }, [phase, pendingDownload]);

  if (!status) return null;

  const compact = variant === 'bot-footer';
  const label = compact ? versionBadgeLabel(status.currentVersion) : { version: `v${status.currentVersion}` };

  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded';
  const isAvailable = hasUpdate && !isDownloading && !isReady && !pendingDownload;
  const readyVersion = status.availableVersion ?? '';
  // The destination appears immediately; later progress remains host-owned.
  const showProgress = isDownloading || pendingDownload;
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  // The pending destination does not claim downloaded bytes before a host event.
  const progressPercent = isDownloading ? percent : 0;

  const handleClick = () => {
    // 下载中：打开下载进度弹窗，绝不触发检测（进度由弹窗内进度条 + 徽标环形进度表达）。
    if (isDownloading || pendingDownload) {
      setModalOpen(true);
      return;
    }
    setModalOpen(true);
    if (!hasUpdate && phase !== 'error') {
      void check();
    }
  };

  const title = showProgress
    ? i18n.t('updater.badge.downloading', { percent: progressPercent })
    : isReady
      ? i18n.t('updater.badge.ready', { version: readyVersion })
      : hasUpdate
        ? i18n.t('updater.badge.updateAvailable')
        : status.phase === 'error'
          ? i18n.t('updater.modal.error', { message: status.error ?? '' })
          : status.phase === 'checking'
            ? i18n.t('updater.badge.checking')
            : i18n.t('updater.badge.upToDate');

  return (
    <>
      <div ref={badgeRef} className={`sidebar-version-badge ${hasUpdate ? 'has-update' : ''}${showProgress ? ' is-progress' : ''}`}>
        <button
          type="button"
          className="sidebar-version-text-btn"
          title={title}
          aria-label={`${hasUpdate ? i18n.t('updater.badge.ariaHasUpdate') : title}${compact ? ` · v${status.currentVersion}` : ''}`}
          onClick={handleClick}
        >
          <span className="sidebar-version-text">{label.version}</span>
          {label.stage ? <span className="sidebar-version-stage">{label.stage}</span> : null}
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
          {phase === 'error' ? <PeerIcon name="warning" size={13} /> : null}
        </button>

        {showProgress ? (
          <span
            className="sidebar-version-progress"
            style={{ '--progress': `${progressPercent}%`, '--progress-ratio': progressPercent / 100 } as CSSProperties}
            title={title}
            aria-label={title}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
          >
            {compact ? <span className="sidebar-version-progress-track" aria-hidden="true"><span className="sidebar-version-progress-fill" /></span>
              : <span className="sidebar-version-progress-ring" aria-hidden="true" />}
            <span className="sidebar-version-progress-text">{progressPercent}%</span>
          </span>
        ) : null}

        {isReady ? (
          <button
            type="button"
            className="sidebar-version-install-btn"
            onClick={() => void install()}
            title={title}
          >
            {i18n.t('updater.badge.install')}
          </button>
        ) : null}

        {showChannel ? (
          <Dropdown
            className="sidebar-version-channel"
            value={status.preference}
            triggerLabel={i18n.t(`updater.badge.channel.${status.preference}`)}
            options={[
              { value: 'auto', label: i18n.t('updater.settings.channel.auto') },
              { value: 'beta', label: i18n.t('updater.settings.channel.beta') },
              { value: 'stable', label: i18n.t('updater.settings.channel.stable') },
            ]}
            ariaLabel={i18n.t('updater.settings.channel')}
            title={i18n.t('updater.settings.channel.description')}
            menuPlacement="up"
            onChange={(value) => void setChannel(value as UpdateChannelPreference)}
          />
        ) : null}
      </div>

      <UpdateModal
        i18n={i18n}
        open={modalOpen}
        status={status}
        pendingDownload={pendingDownload}
        onClose={() => setModalOpen(false)}
        progressTarget={progressTarget}
        onUpdate={() => {
          setPendingDownload(true);
          void download().finally(() => setPendingDownload(false));
        }}
        onOpenReleasePage={() => void openReleasePage()}
        onRecheck={() => void check()}
      />
    </>
  );
}
