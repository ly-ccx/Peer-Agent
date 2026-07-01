import type { I18nRuntime } from '@peer-agent/i18n';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
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
  const readyVersion = status.availableVersion ?? '';
  // 完成卡片可见：处于完成态、有版本号、且该版本未被收起。
  const toastVisible = isReady && readyVersion !== '' && dismissedVersion !== readyVersion;
  // 进度环可见：真实下载中，或点「更新」后的过渡期（pendingDownload），
  // 使弹窗收缩落点始终有一个正在脉冲的进度环承接（C1 连续性）。
  const showProgress = isDownloading || pendingDownload;
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  // 过渡期还没有真实进度，显示 0%，让进度环以「起步脉冲」形态接住视线。
  const progressPercent = isDownloading ? percent : 0;

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
        {showProgress ? (
          <span
            className="sidebar-version-dot is-progress"
            style={{ '--pa-update-pct': progressPercent } as CSSProperties}
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
          onUpdate={() => {
            // 点「更新」瞬间即点亮进度环（0%），与弹窗朝左上角收缩同拍启动，
            // 弹窗飞抵时进度环已在脉冲，视线不断链（C1 时序衔接）。
            setPendingDownload(true);
            void download();
          }}
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
