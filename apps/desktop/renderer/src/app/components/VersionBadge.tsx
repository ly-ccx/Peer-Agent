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
 * VersionBadge —— 版本与更新的表达层。
 *
 * classic：经典侧边栏底部。版本号本身可点；下载中保留进度环，完成后在旁边放「安装」。
 * bot-subtitle：机器人列表里，Peer 名称下的缩小版本号。只展示，不承接更新。
 * bot-upgrade：有更新时才出现，放在「新建」左侧。
 *   点击仍打开更新摘要弹窗；确认下载后按钮缩小成环形进度，数字居中。
 *   下载完成后同一位置展开成写着「安装」的按钮。
 *
 * 能力真相在主进程，本组件通过 useUpdater 消费状态与动作。
 */
export function VersionBadge({ i18n, showChannel = false, variant = 'classic' }: {
  readonly i18n: I18nRuntime;
  readonly showChannel?: boolean;
  readonly variant?: 'classic' | 'bot-subtitle' | 'bot-upgrade';
}) {
  if (variant === 'bot-subtitle') return <BotVersionSubtitle />;
  if (variant === 'bot-upgrade') return <BotUpgradeControl i18n={i18n} />;
  return <ClassicVersionBadge i18n={i18n} showChannel={showChannel} />;
}

function BotVersionSubtitle() {
  const { status } = useUpdater();
  if (!status) return null;
  const label = versionBadgeLabel(status.currentVersion);
  return (
    <span className="sidebar-version-badge bot-version-subtitle" title={`v${status.currentVersion}`}>
      <span className="sidebar-version-text">{label.version}</span>
      {label.stage ? <span className="sidebar-version-stage">{label.stage}</span> : null}
      {import.meta.env.DEV ? (
        <span className="sidebar-version-dev-tag" aria-label="开发版本">
          开发
        </span>
      ) : null}
    </span>
  );
}

function BotUpgradeControl({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, hasUpdate, check, download, install, openReleasePage } = useUpdater();
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const progressTarget = useCallback(() => buttonRef.current, []);
  const phase = status?.phase;

  useEffect(() => {
    if (!pendingDownload) return;
    if (phase === 'downloading' || phase === 'downloaded' || phase === 'error') {
      setPendingDownload(false);
    }
  }, [phase, pendingDownload]);

  if (!status) return null;

  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded';
  const isAvailable = hasUpdate && !isDownloading && !isReady && !pendingDownload;
  const isError = phase === 'error';
  const showProgress = (isDownloading || pendingDownload) && phase !== 'downloaded' && phase !== 'error';
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  const progressPercent = isDownloading ? percent : 0;
  const readyVersion = status.availableVersion ?? '';
  const title = showProgress
    ? i18n.t('updater.badge.downloading', { percent: progressPercent })
    : isReady
      ? i18n.t('updater.badge.ready', { version: readyVersion })
      : isError
        ? i18n.t('updater.modal.error', { message: status.error ?? '' })
        : hasUpdate
          ? i18n.t('updater.badge.updateAvailable')
          : i18n.t('updater.badge.upToDate');
  const visible = showProgress || isAvailable || isReady || isError;

  return (
    <>
      {visible ? (
        <button
          ref={buttonRef}
          type="button"
          className={`bot-upgrade${showProgress ? ' is-progress' : ''}${isReady && !showProgress ? ' is-install' : ''}${isError && !showProgress ? ' is-error' : ''}`}
          style={showProgress ? ({ '--progress': `${progressPercent}%` } as CSSProperties) : undefined}
          title={title}
          aria-label={isReady && !showProgress ? i18n.t('updater.badge.install') : showProgress ? title : isAvailable ? i18n.t('updater.badge.ariaHasUpdate') : title}
          role={showProgress ? 'progressbar' : undefined}
          aria-valuemin={showProgress ? 0 : undefined}
          aria-valuemax={showProgress ? 100 : undefined}
          aria-valuenow={showProgress ? progressPercent : undefined}
          onClick={() => {
            if (isReady && !showProgress) {
              void install();
              return;
            }
            setModalOpen(true);
            if (!showProgress && !hasUpdate && phase !== 'error') void check();
          }}
        >
          {showProgress ? (
            <span className="bot-upgrade-value" data-digits={String(progressPercent).length}>{progressPercent}</span>
          ) : isReady ? (
            i18n.t('updater.badge.install')
          ) : (
            <PeerIcon name={isError ? 'warning' : 'arrowDown'} size={15} strokeWidth={1.75} />
          )}
        </button>
      ) : null}
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

function ClassicVersionBadge({ i18n, showChannel = false, variant = 'classic' }: {
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
