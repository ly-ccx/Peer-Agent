import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdaterStatus } from '@peer-agent/protocol';
import type { CSSProperties } from 'react';
import { Overlay } from './Overlay';
import { ReleaseNotesView } from './ReleaseNotesView';

/**
 * UpdateModal —— 更新摘要弹窗（表达层）。
 *
 * 职责（按确认的产品设计，下载阶段不再霸屏）：
 *   - available：展示当前版本 / 新版本 / 更新内容 +「更新」「稍后」。
 *     点「更新」= 触发后台下载并带动画收起弹窗，进度改由版本徽标的环形进度表达，
 *     下载完成由右下角 UpdateToast 承接「立即安装」。
 *   - checking：正在检查更新…
 *   - not-available：已是最新 +「重新检查」。
 *   - error：错误信息 +（可选）打开 Release 页 +「重新检查」。
 *
 * 下载中 / 已下载 / 待打开（downloading / downloaded / ready-to-open）不再由本弹窗呈现，
 * 分别交给「徽标环形进度」与「右下角完成卡片（UpdateToast）」。
 *
 * 能力真相在主进程；本组件仅触发 onUpdate/onOpenReleasePage/onRecheck/onClose 回调。
 * 关闭统一经 Overlay 的 requestClose 走退场动画，不再直接卸载。
 */
export function UpdateModal({
  i18n,
  status,
  onUpdate,
  onOpenReleasePage,
  onRecheck,
  onClose,
}: {
  readonly i18n: I18nRuntime;
  readonly status: UpdaterStatus;
  /** 触发后台下载（download）。调用后弹窗会带动画收起。 */
  readonly onUpdate: () => void;
  /** 错误兜底：打开 GitHub Release 页面（status.releaseUrl 存在时）。 */
  readonly onOpenReleasePage: () => void;
  readonly onRecheck: () => void;
  readonly onClose: () => void;
}) {
  const { phase } = status;
  const newVersion = status.availableVersion ?? '';

  return (
    <Overlay
      onClose={onClose}
      ariaLabel={i18n.t('updater.modal.title')}
      panelClassName="updater-modal"
    >
      {({ requestClose }) =>
        phase === 'downloading' ? (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.title')}</h2>
            <p className="updater-modal-downloading">
              {i18n.t('updater.modal.downloading')}{' '}
              {Math.max(0, Math.min(100, Math.round(status.percent ?? 0)))}%
            </p>
            <div
              className="updater-modal-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.max(0, Math.min(100, Math.round(status.percent ?? 0)))}
            >
              <span
                className="updater-modal-progress-fill"
                style={
                  {
                    '--pa-update-pct': Math.max(0, Math.min(100, Math.round(status.percent ?? 0))),
                  } as CSSProperties
                }
              />
            </div>
            <div className="updater-modal-actions">
              <button type="button" className="updater-btn ghost" onClick={requestClose}>
                {i18n.t('updater.modal.close')}
              </button>
            </div>
          </div>
        ) : phase === 'not-available' ? (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.title')}</h2>
            <p className="updater-modal-uptodate">{i18n.t('updater.modal.upToDate')}</p>
            <div className="updater-modal-actions">
              <button type="button" className="updater-btn" onClick={onRecheck}>
                {i18n.t('updater.modal.checkAgain')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={requestClose}>
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
              {status.releaseUrl ? (
                <button type="button" className="updater-btn primary" onClick={onOpenReleasePage}>
                  {i18n.t('updater.modal.openReleasePage')}
                </button>
              ) : null}
              <button type="button" className="updater-btn" onClick={onRecheck}>
                {i18n.t('updater.modal.checkAgain')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={requestClose}>
                {i18n.t('updater.modal.close')}
              </button>
            </div>
          </div>
        ) : phase === 'available' && newVersion ? (
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
                  <ReleaseNotesView html={status.releaseNotes} />
                ) : (
                  <p>{i18n.t('updater.modal.noReleaseNotes')}</p>
                )}
              </div>
            </div>
            <div className="updater-modal-actions">
              <button
                type="button"
                className="updater-btn primary"
                onClick={() => {
                  // 先触发后台下载，再带动画收起弹窗：进度交由徽标环形进度表达。
                  onUpdate();
                  requestClose();
                }}
              >
                {i18n.t('updater.modal.update')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={requestClose}>
                {i18n.t('updater.modal.later')}
              </button>
            </div>
          </div>
        ) : (
          <div className="updater-modal-body">
            <h2 className="updater-modal-title">{i18n.t('updater.modal.checking')}</h2>
            <div className="updater-modal-versions">
              <span className="updater-version-from">
                {i18n.t('updater.modal.currentVersion')}: v{status.currentVersion}
              </span>
            </div>
          </div>
        )
      }
    </Overlay>
  );
}
