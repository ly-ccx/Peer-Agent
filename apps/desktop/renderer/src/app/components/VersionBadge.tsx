import type { I18nRuntime } from '@peer-agent/i18n';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useUpdater } from '../state/useUpdater';
import { UpdateModal } from './UpdateModal';
import { UpdateToast } from './UpdateToast';

/**
 * VersionBadge —— 侧边栏品牌区右侧的版本徽标（表达层）。
 *
 * 行为（按确认的产品设计）：
 *   - 始终展示当前版本号（vX.Y.Z）。
 *   - 有可用更新时（hasUpdate）在徽标上叠加红点。
 *   - 下载中（downloading）：红点原地升级为 mini 环形进度，按 percent 填充。
 *   - 下载完成（downloaded / ready-to-open）：右下角挂载 UpdateToast 完成卡片；
 *     ✕ 收起后徽标保留红点，点徽标可再次唤出卡片（dismissed 本地态记忆按版本）。
 *   - 点击徽标：
 *       · 完成态且卡片已收起 → 重新唤出完成卡片。
 *       · 否则 → 打开更新摘要弹窗（无更新时顺带触发一次检查）。
 *
 * 能力真相在主进程，本组件通过 useUpdater 消费状态与动作。
 */
export function VersionBadge({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, hasUpdate, check, download, install, openInstaller, openReleasePage } =
    useUpdater();
  const [modalOpen, setModalOpen] = useState(false);
  // ✕ 收起记忆：记录被收起的完成态版本号，避免同一版本反复弹出；新版本会重新弹。
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (!status) return null;

  const { phase } = status;
  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded' || phase === 'ready-to-open';
  const readyVersion = status.availableVersion ?? '';
  // 完成卡片可见：处于完成态、有版本号、且该版本未被收起。
  const toastVisible = isReady && readyVersion !== '' && dismissedVersion !== readyVersion;
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));

  const handleClick = () => {
    // 完成态但卡片已收起：点徽标重新唤出卡片，不开弹窗。
    if (isReady && !toastVisible) {
      setDismissedVersion(null);
      return;
    }
    setModalOpen(true);
    if (!hasUpdate) {
      void check();
    }
  };

  const title = isDownloading
    ? i18n.t('updater.badge.downloading', { percent })
    : hasUpdate
      ? i18n.t('updater.badge.updateAvailable')
      : status.phase === 'checking'
        ? i18n.t('updater.badge.checking')
        : i18n.t('updater.badge.upToDate');

  return (
    <>
      <button
        type="button"
        className={`sidebar-version-badge ${hasUpdate ? 'has-update' : ''}`}
        title={title}
        aria-label={hasUpdate ? i18n.t('updater.badge.ariaHasUpdate') : title}
        onClick={handleClick}
      >
        <span className="sidebar-version-text">v{status.currentVersion}</span>
        {isDownloading ? (
          <span
            className="sidebar-version-dot is-progress"
            style={{ '--pa-update-pct': percent } as CSSProperties}
            aria-hidden="true"
          />
        ) : hasUpdate ? (
          <span className="sidebar-version-dot" aria-hidden="true" />
        ) : null}
      </button>
      {modalOpen ? (
        <UpdateModal
          i18n={i18n}
          status={status}
          onUpdate={() => void download()}
          onOpenReleasePage={() => void openReleasePage()}
          onRecheck={() => void check()}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
      {toastVisible ? (
        <UpdateToast
          i18n={i18n}
          version={readyVersion}
          phase={phase as 'downloaded' | 'ready-to-open'}
          onInstall={() => void install()}
          onOpenInstaller={() => void openInstaller()}
          onDismiss={() => setDismissedVersion(readyVersion)}
        />
      ) : null}
    </>
  );
}
