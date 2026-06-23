import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { useUpdater } from '../state/useUpdater';
import { UpdateModal } from './UpdateModal';

/**
 * VersionBadge —— 侧边栏品牌区右侧的版本徽标（表达层）。
 *
 * 行为（按确认的产品设计）：
 *   - 始终展示当前版本号（vX.Y.Z）。
 *   - 有可用更新时（hasUpdate）在徽标上叠加红点。
 *   - 点击徽标：若有更新→打开更新摘要弹窗；否则触发一次检查并打开弹窗反馈结果。
 *
 * 能力真相在主进程，本组件通过 useUpdater 消费状态与动作。
 */
export function VersionBadge({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, hasUpdate, check, download, install, openInstaller, openReleasePage } =
    useUpdater();
  const [modalOpen, setModalOpen] = useState(false);

  if (!status) return null;

  const handleClick = () => {
    setModalOpen(true);
    if (!hasUpdate) {
      void check();
    }
  };

  const title = hasUpdate
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
        {hasUpdate ? <span className="sidebar-version-dot" aria-hidden="true" /> : null}
      </button>
      {modalOpen ? (
        <UpdateModal
          i18n={i18n}
          status={status}
          onUpdate={() => void download()}
          onInstall={() => void install()}
          onOpenInstaller={() => void openInstaller()}
          onOpenReleasePage={() => void openReleasePage()}
          onRecheck={() => void check()}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </>
  );
}
