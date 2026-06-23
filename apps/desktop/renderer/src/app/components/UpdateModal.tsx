import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdaterStatus } from '@peer-agent/protocol';

/**
 * UpdateModal —— 更新摘要 / 下载进度 / 安装态的统一弹窗（表达层）。
 *
 * 按确认的产品设计分阶段呈现：
 *   - available：展示当前版本 / 新版本 / 更新内容 + 「更新」「稍后」。
 *   - downloading：吉祥物 + 进度条 +「正在下载更新…」。
 *   - downloaded：进度条满 +「正在安装 {version}」+「当前工作已保存…」+「立即重启安装」。
 *   - not-available：已是最新 +「重新检查」。
 *   - error：错误信息 +「重新检查」。
 *
 * 能力真相在主进程；本组件仅触发 onUpdate/onInstall/onRecheck/onClose 回调。
 */
export function UpdateModal({
  i18n,
  status,
  onUpdate,
  onInstall,
  onRecheck,
  onClose,
}: {
  readonly i18n: I18nRuntime;
  readonly status: UpdaterStatus;
  readonly onUpdate: () => void;
  readonly onInstall: () => void;
  readonly onRecheck: () => void;
  readonly onClose: () => void;
}) {
  const { phase } = status;
  const newVersion = status.availableVersion ?? '';
  const percent = Math.max(0, Math.min(100, status.percent ?? 0));
  const isBusy = phase === 'downloading' || phase === 'downloaded';

  return (
    <div className="updater-modal-backdrop" onClick={isBusy ? undefined : onClose}>
      <div
        className="updater-modal"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t('updater.modal.title')}
        onClick={(event) => event.stopPropagation()}
      >
        {phase === 'downloading' || phase === 'downloaded' ? (
          <div className="updater-modal-progress-view">
            <div className="updater-modal-mascot" aria-hidden="true">
              <img src="./logo-light.png" alt="" className="light" />
              <img src="./logo-dark.png" alt="" className="dark" />
            </div>
            <div className="updater-progress-track">
              <div
                className="updater-progress-fill"
                style={{ width: `${phase === 'downloaded' ? 100 : percent}%` }}
              />
            </div>
            <p className="updater-modal-phase">
              {phase === 'downloaded'
                ? i18n.t('updater.modal.installing', { version: newVersion })
                : i18n.t('updater.modal.downloading')}
            </p>
            {phase === 'downloaded' ? (
              <>
                <p className="updater-modal-hint">{i18n.t('updater.modal.installHint')}</p>
                <div className="updater-modal-actions">
                  <button type="button" className="updater-btn primary" onClick={onInstall}>
                    {i18n.t('updater.modal.restartNow')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : phase === 'not-available' ? (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.title')}</h2>
            <p className="updater-modal-uptodate">{i18n.t('updater.modal.upToDate')}</p>
            <div className="updater-modal-actions">
              <button type="button" className="updater-btn" onClick={onRecheck}>
                {i18n.t('updater.modal.checkAgain')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={onClose}>
                {i18n.t('updater.modal.close')}
              </button>
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.title')}</h2>
            <p className="updater-modal-error">
              {i18n.t('updater.modal.error', { message: status.error ?? '' })}
            </p>
            <div className="updater-modal-actions">
              <button type="button" className="updater-btn" onClick={onRecheck}>
                {i18n.t('updater.modal.checkAgain')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={onClose}>
                {i18n.t('updater.modal.close')}
              </button>
            </div>
          </div>
        ) : (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.title')}</h2>
            <div className="updater-modal-versions">
              <span className="updater-version-from">
                {i18n.t('updater.modal.currentVersion')}: v{status.currentVersion}
              </span>
              <span className="updater-version-arrow" aria-hidden="true">
                →
              </span>
              <span className="updater-version-to">
                {i18n.t('updater.modal.newVersion')}: v{newVersion}
              </span>
            </div>
            <div className="updater-modal-notes">
              <span className="updater-modal-notes-label">
                {i18n.t('updater.modal.releaseNotes')}
              </span>
              <div className="updater-modal-notes-body">
                {status.releaseNotes ? (
                  <pre>{status.releaseNotes}</pre>
                ) : (
                  <p>{i18n.t('updater.modal.noReleaseNotes')}</p>
                )}
              </div>
            </div>
            <div className="updater-modal-actions">
              <button type="button" className="updater-btn primary" onClick={onUpdate}>
                {i18n.t('updater.modal.update')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={onClose}>
                {i18n.t('updater.modal.later')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
