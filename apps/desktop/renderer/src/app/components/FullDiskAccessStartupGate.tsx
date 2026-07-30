/**
 * 应用启动时的 macOS 完全磁盘访问权限门（表达层）。
 *
 * 对齐 AskForPermission 的关键交互：
 * - 打开 App 即检测（不依赖导入向导）
 * - 打开系统设置对应隐私页
 * - 列表不会自动出现 App，需拖入品牌 LOGO / App
 * - 回前台 / 页面可见时自动重检
 *
 * hooks 数量必须恒定：所有 hooks 在任何 early return 之前。
 */
import { type DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { clientApi } from '../../clientApi';

const BRAND_LOGO_SRC = './logo.png';

type PreflightCheck = {
  readonly id: string;
  readonly status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly action?: 'open_full_disk_access' | 'install_browser' | 'none';
  readonly path?: string;
};

type Preflight = {
  readonly ok: boolean;
  readonly ready?: boolean;
  readonly blocked?: boolean;
  readonly checks?: readonly PreflightCheck[];
  readonly openFullDiskAccessSupported?: boolean;
  readonly guidance?: { readonly fullDiskAccess?: string };
  readonly error?: string;
  readonly dragTarget?: {
    readonly ok: boolean;
    readonly appPath?: string;
    readonly displayName?: string;
    readonly kind?: string;
    readonly isPackagedApp?: boolean;
    readonly iconDataUrl?: string | null;
    readonly error?: string;
  };
};

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.platform || navigator.userAgent || '';
  return /Mac|macOS/i.test(ua);
}

function isBlockedPreflight(res: Preflight | null | undefined): boolean {
  if (!res) return false;
  if (res.ready) return false;
  return Boolean(
    res.blocked
    || res.checks?.some((c) => c.status === 'blocked' || c.action === 'open_full_disk_access'),
  );
}

function statusLabel(status: PreflightCheck['status'], isZh: boolean): string {
  if (isZh) {
    switch (status) {
      case 'ok': return '通过';
      case 'missing': return '缺失';
      case 'blocked': return '需授权';
      case 'warn': return '警告';
      case 'unsupported': return '不支持';
      default: return '说明';
    }
  }
  switch (status) {
    case 'ok': return 'OK';
    case 'missing': return 'Missing';
    case 'blocked': return 'Blocked';
    case 'warn': return 'Warn';
    case 'unsupported': return 'N/A';
    default: return 'Info';
  }
}

export function FullDiskAccessStartupGate({
  enabled,
  isZh,
}: {
  readonly enabled: boolean;
  readonly isZh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);

  const needsAttention = useMemo(() => isBlockedPreflight(preflight), [preflight]);

  const runPreflight = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const api = clientApi.getBrowserSessionImportPreflight;
      if (typeof api !== 'function') {
        setPreflight(null);
        setOpen(false);
        return null;
      }
      const res = await api() as Preflight;
      setPreflight(res);
      if (!isBlockedPreflight(res) || res?.ready) {
        setOpen(false);
      } else {
        setOpen(true);
      }
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 检测失败不永久挡主壳；关闭门，错误写在下次打开时仍可看到。
      setOpen(false);
      return null;
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  // 冷启动 / 主壳就绪：主动 preflight（macOS only）
  useEffect(() => {
    if (!enabled) return;
    if (!isMacPlatform()) return;
    let cancelled = false;
    void (async () => {
      const res = await runPreflight();
      if (cancelled || !res) return;
      if (isBlockedPreflight(res)) setOpen(true);
      else setOpen(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, runPreflight]);

  // 回前台 / 页面重新可见时自动重检（对齐 AskForPermission 授权后回到 App 即刷新状态）
  useEffect(() => {
    if (!enabled) return;
    if (!isMacPlatform()) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const recheck = () => {
      // 门已关且上次已通过时仍轻量 recheck：用户可能刚授权完
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void runPreflight({ silent: true });
      }, 250);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    const onFocus = () => recheck();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, runPreflight]);

  const openSettings = useCallback(async () => {
    setOpeningSettings(true);
    try {
      const res = await clientApi.openFullDiskAccessSettings?.();
      if (res && res.ok === false) {
        setError(res.error || (isZh ? '无法打开系统设置' : 'Failed to open System Settings'));
      } else {
        setSettingsOpened(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningSettings(false);
    }
  }, [isZh]);

  const revealAppInFinder = useCallback(async () => {
    try {
      const target = preflight?.dragTarget;
      if (target?.ok && target.appPath) {
        await clientApi.openPath?.(target.appPath);
        return;
      }
      const fresh = await clientApi.getAppDragTarget?.();
      if (fresh?.ok && fresh.appPath) {
        await clientApi.openPath?.(fresh.appPath);
        return;
      }
      await clientApi.openPath?.('/Applications');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [preflight?.dragTarget]);

  const onAppDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const target = preflight?.dragTarget;
    if (!target?.ok || !target.appPath) {
      event.preventDefault();
      return;
    }
    try {
      event.dataTransfer?.setData('text/plain', target.displayName || target.appPath);
      event.dataTransfer!.effectAllowed = 'copyMove';
    } catch {
      // ignore
    }
    try {
      clientApi.startAppDrag?.({ appPath: target.appPath });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [preflight?.dragTarget]);

  // hooks 全部结束后再决定是否渲染，保证 hooks 数量恒定。
  if (!enabled || !open || !needsAttention) return null;

  const checks = (preflight?.checks || []).filter((c) => (
    c.status === 'blocked'
    || c.status === 'warn'
    || c.status === 'missing'
    || c.id === 'full-disk-access'
    || c.id.startsWith('cookies:')
  ));
  const displayName = preflight?.dragTarget?.displayName || 'Peer Agent';
  const canDrag = Boolean(preflight?.dragTarget?.ok && preflight?.dragTarget?.appPath);

  const node = (
    <div className="pa-overlay-backdrop" role="presentation">
      <div
        className="pa-overlay-panel fda-startup-gate"
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '完全磁盘访问权限' : 'Full Disk Access'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fda-startup-gate-body">
          <h2 className="fda-startup-gate-title">
            {isZh ? '需要完全磁盘访问权限' : 'Full Disk Access required'}
          </h2>
          <p className="fda-startup-gate-lead">
            {isZh
              ? 'Peer Agent 需要读取本机浏览器 Cookie 目录（例如 Chrome）才能导入站点会话。这些权限仅在你使用本功能时用到。'
              : 'Peer Agent needs to read local browser cookie directories (e.g. Chrome) to import site sessions. These permissions are only used while you use this feature.'}
          </p>

          <div className="fda-permission-row">
            <div className="fda-permission-row-main">
              <span className="fda-permission-row-icon" aria-hidden>
                <img
                  className="fda-permission-logo"
                  src={preflight?.dragTarget?.iconDataUrl || BRAND_LOGO_SRC}
                  alt=""
                  draggable={false}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (img.src.endsWith('/logo.png') || img.src.endsWith('./logo.png')) return;
                    img.src = BRAND_LOGO_SRC;
                  }}
                />
              </span>
              <span className="fda-permission-row-text">
                <strong>{isZh ? '完全磁盘访问' : 'Full Disk Access'}</strong>
                <span>
                  {isZh
                    ? '用于读取 Chrome 等浏览器本地 Cookie 目录'
                    : 'Needed to read Chrome (and similar) cookie directories'}
                </span>
              </span>
            </div>
            <span className="fda-permission-row-status is-pending">
              {loading
                ? (isZh ? '检测中…' : 'Checking…')
                : (isZh ? '待完成' : 'Required')}
            </span>
          </div>

          <div className="fda-permission-card">
            <div className="fda-drag-banner">
              {isZh
                ? `↑ 将 ${displayName} 拖到系统设置「完全磁盘访问」列表（列表不会自动出现 App）`
                : `↑ Drag ${displayName} into Full Disk Access list (apps never auto-appear)`}
            </div>
            <button
              type="button"
              className="fda-permission-drag"
              draggable={canDrag}
              onDragStart={onAppDragStart}
              title={isZh ? '拖到“完全磁盘访问权限”列表' : 'Drag into Full Disk Access list'}
            >
              <img
                className="fda-permission-logo"
                src={preflight?.dragTarget?.iconDataUrl || BRAND_LOGO_SRC}
                alt="Peer Agent"
                draggable={false}
                onError={(e) => {
                  const img = e.currentTarget;
                  if (img.src.endsWith('/logo.png') || img.src.endsWith('./logo.png')) return;
                  img.src = BRAND_LOGO_SRC;
                }}
              />
              <span className="fda-permission-meta">
                <strong>{displayName}</strong>
                <span>
                  {canDrag
                    ? (isZh
                      ? '按住品牌 LOGO 拖进系统设置列表，然后打开开关'
                      : 'Hold the brand logo, drag into System Settings, then enable it')
                    : (isZh
                      ? '正在准备可拖拽的 App… 也可点下方在 Finder 中显示'
                      : 'Preparing draggable app… or reveal it in Finder below')}
                </span>
              </span>
            </button>

            <button
              type="button"
              className="fda-complete-in-settings"
              disabled={openingSettings}
              onClick={() => void openSettings()}
            >
              {openingSettings
                ? (isZh ? '打开中…' : 'Opening…')
                : (isZh ? '在系统设置中完成' : 'Complete in System Settings')}
            </button>

            <div className="fda-permission-actions">
              <button type="button" className="updater-btn ghost" onClick={() => void revealAppInFinder()}>
                {isZh ? '在 Finder 中显示 App' : 'Reveal app in Finder'}
              </button>
            </div>
          </div>

          <ol className="fda-startup-steps">
            <li>{isZh ? '点「在系统设置中完成」，打开「完全磁盘访问」' : 'Click “Complete in System Settings” to open Full Disk Access'}</li>
            <li>{isZh ? '把上方 LOGO 拖进列表并打开开关（列表不会自动出现）' : 'Drag the logo into the list and enable it (never auto-appears)'}</li>
            <li>{isZh ? '回到 Peer Agent：会自动重检；也可点下方按钮' : 'Return here: we re-check automatically, or click below'}</li>
          </ol>

          {settingsOpened ? (
            <p className="session-import-hint">
              {isZh
                ? '已尝试打开系统设置。授权后切回本窗口会自动重新检测。'
                : 'System Settings should be open. After granting access, switch back—we re-check automatically.'}
            </p>
          ) : null}

          {preflight?.guidance?.fullDiskAccess ? (
            <p className="session-import-hint">{preflight.guidance.fullDiskAccess}</p>
          ) : null}

          <ul className="session-import-preflight-list fda-startup-checks">
            {checks.map((check) => (
              <li key={check.id} className={`session-import-preflight-item is-${check.status}`}>
                <div className="session-import-preflight-item-top">
                  <span className="session-import-preflight-status">{statusLabel(check.status, isZh)}</span>
                  <strong>{check.title}</strong>
                </div>
                <p>{check.detail}</p>
              </li>
            ))}
          </ul>

          {error ? <div className="session-import-error">{error}</div> : null}

          <div className="fda-startup-actions">
            <button type="button" className="updater-btn" disabled={loading} onClick={() => void runPreflight()}>
              {loading
                ? (isZh ? '检测中…' : 'Checking…')
                : (isZh ? '我已授权，重新检测' : 'I’ve granted access — re-check')}
            </button>
            <button type="button" className="updater-btn ghost" onClick={() => setOpen(false)}>
              {isZh ? '稍后' : 'Later'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
