import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * UpdateToast —— 右下角「下载完成」非模态完成卡片（表达层）。
 *
 * 按确认的产品设计：
 *   - 下载完成后从右下角滑入，展示「新版本 vX.Y.Z 已就绪」。
 *   - 主按钮「立即安装」：
 *       · phase='downloaded'（Windows）→ onInstall（重启安装）。
 *       · phase='ready-to-open'（mac）→ onOpenInstaller（打开 dmg）。
 *   - ✕ 收起：仅关闭卡片，不影响下载产物；徽标红点保留，可再次唤出（由 VersionBadge 维护）。
 *
 * 动效：进场 za-toast-in / 退场 za-toast-out；prefers-reduced-motion 由 tokens.css 全局兜底降级。
 * 不抢焦点、不加遮罩，避免「霸屏 / 点不掉」。
 */
export function UpdateToast({
  i18n,
  version,
  phase,
  onInstall,
  onOpenInstaller,
  onDismiss,
}: {
  readonly i18n: I18nRuntime;
  /** 已就绪的新版本号（不含 v 前缀）。 */
  readonly version: string;
  /** 完成态：downloaded=Windows 重启安装；ready-to-open=mac 安装。 */
  readonly phase: 'downloaded' | 'ready-to-open';
  readonly onInstall: () => void;
  readonly onOpenInstaller: () => void;
  /** ✕ 收起：退场动画结束后由本组件回调，宿主据此卸载并记忆 dismissed。 */
  readonly onDismiss: () => void;
}) {
  const [closing, setClosing] = useState(false);
  // 退场动画兜底定时器：防止 animationend 丢失导致卡片卡死不卸载。
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (fallbackRef.current) clearTimeout(fallbackRef.current);
    },
    [],
  );

  const requestDismiss = useCallback(() => {
    setClosing(true);
    fallbackRef.current = setTimeout(onDismiss, 260);
  }, [onDismiss]);

  const finishDismiss = useCallback(() => {
    if (!closing) return;
    if (fallbackRef.current) clearTimeout(fallbackRef.current);
    onDismiss();
  }, [closing, onDismiss]);

  const installLabel =
    phase === 'ready-to-open'
      ? i18n.t('updater.toast.openInstaller')
      : i18n.t('updater.toast.install');

  return (
    <div
      className={closing ? 'updater-toast is-closing' : 'updater-toast'}
      role="status"
      aria-live="polite"
      onAnimationEnd={closing ? finishDismiss : undefined}
    >
      <button
        type="button"
        className="updater-toast-dismiss"
        aria-label={i18n.t('updater.toast.dismiss')}
        onClick={requestDismiss}
      >
        ✕
      </button>
      <div className="updater-toast-body">
        <span className="updater-toast-title">{i18n.t('updater.toast.title')}</span>
        <span className="updater-toast-version">
          {i18n.t('updater.toast.ready', { version })}
        </span>
      </div>
      <div className="updater-toast-actions">
        <button
          type="button"
          className="updater-btn primary"
          onClick={phase === 'ready-to-open' ? onOpenInstaller : onInstall}
        >
          {installLabel}
        </button>
      </div>
    </div>
  );
}
