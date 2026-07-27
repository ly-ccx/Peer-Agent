import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdaterStatus } from '@peer-agent/protocol';
import type { CSSProperties } from 'react';
import { Overlay } from './Overlay';
import { selectReleaseNotesByLocale } from './releaseNotesLocale';
import { ReleaseNotesView } from './ReleaseNotesView';

/**
 * UpdateModal —— 更新摘要弹窗（表达层）。
 *
 * 职责（按确认的产品设计，下载阶段不再霸屏）：
 *   - available：Changelog 卡片 —— 新版本做主标题，from 旧版本 + 更新内容 +「更新」「稍后」。
 *     点「更新」= 触发后台下载并带动画收起弹窗，进度改由版本徽标的环形进度表达，
 *     下载完成由侧边栏版本徽标旁的「安装」按钮承接。
 *   - checking：正在检查更新…
 *   - not-available：已是最新 +「重新检查」。
 *   - error：错误信息 +（可选）打开 Release 页 +「重新检查」。
 *   - downloading：用户主动点开徽标时展示进度条（不自动弹）。
 *
 * 下载中 / 已下载 / 待打开的常驻展示分别交给「徽标环形进度」与「徽标旁安装按钮」。
 *
 * 能力真相在主进程；本组件仅触发 onUpdate/onOpenReleasePage/onRecheck/onClose 回调。
 * 关闭统一经 Overlay 的 requestClose 走退场动画，不再直接卸载。
 */
export function UpdateModal({
  i18n,
  open,
  status,
  onUpdate,
  onOpenReleasePage,
  onRecheck,
  onClose,
}: {
  readonly i18n: I18nRuntime;
  /** 由 VersionBadge 控制是否展示；false 时不挂载 Overlay。 */
  readonly open: boolean;
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
  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  const localizedReleaseNotes = selectReleaseNotesByLocale(
    status.releaseNotes,
    i18n.locale,
  );

  if (!open) return null;

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
              {i18n.t('updater.modal.downloading')} {percent}%
            </p>
            <div
              className="updater-modal-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span
                className="updater-modal-progress-fill"
                style={{ '--pa-update-pct': percent } as CSSProperties}
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
          <div className="updater-modal-changelog">
            <div className="updater-modal-hero">
              <div className="updater-modal-pill">{i18n.t('updater.modal.newUpdatePill')}</div>
              <h2 className="updater-modal-version-title">v{newVersion}</h2>
              <p className="updater-modal-from">
                {i18n.t('updater.modal.fromVersion', { version: status.currentVersion })}
              </p>
            </div>

            <div className="updater-modal-changelog-body">
              <div className="updater-modal-section-title">
                {i18n.t('updater.modal.releaseNotes')}
              </div>
              <div className="updater-modal-notes-body is-flat">
                {localizedReleaseNotes ? (
                  <ReleaseNotesView html={localizedReleaseNotes} />
                ) : (
                  <p className="updater-modal-empty-notes">
                    {i18n.t('updater.modal.noReleaseNotes')}
                  </p>
                )}
              </div>
            </div>

            <div className="updater-modal-footer">
              <p className="updater-modal-hint">
                {i18n.t('updater.modal.backgroundDownloadHint')}
              </p>
              <div className="updater-modal-actions">
                <button type="button" className="updater-btn ghost" onClick={requestClose}>
                  {i18n.t('updater.modal.later')}
                </button>
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
              </div>
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
