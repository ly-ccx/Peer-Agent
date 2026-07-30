/**
 * 应用启动时的 macOS 必需权限门（表达层）。
 *
 * 当前必需：完全磁盘访问（Full Disk Access）。
 * 与「导入 Chrome / 站点会话」解耦：打开 App 即检测，不通过就弹窗。
 *
 * 对齐 AskForPermission 交互：
 * - 打开系统设置对应隐私页
 * - 列表不会自动出现 App，需拖入品牌 LOGO
 * - 回前台 / 页面可见时自动重检
 *
 * hooks 数量必须恒定：所有 hooks 在任何 early return 之前。
 */
import { type DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { clientApi } from '../../clientApi';

const BRAND_LOGO_SRC = './logo.png';

type PermissionCheck = {
  readonly id: string;
  readonly status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly action?: 'open_full_disk_access' | 'none' | string;
  readonly path?: string;
};

type StartupPermissions = {
  readonly ok: boolean;
  readonly blocked?: boolean;
  readonly platform?: string;
  readonly checks?: readonly PermissionCheck[];
  readonly required?: readonly PermissionCheck[];
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

/** 启动门：任一必需权限 blocked / 需打开 FDA 即弹出。不看 Chrome ready。 */
function needsStartupGate(res: StartupPermissions | null | undefined): boolean {
  if (!res) return false;
  if (res.blocked) return true;
  return Boolean(
    res.checks?.some((c) => c.status === 'blocked' || c.action === 'open_full_disk_access'),
  );
}

function statusLabel(status: PermissionCheck['status'], isZh: boolean): string {
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
  const [snapshot, setSnapshot] = useState<StartupPermissions | null>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);

  const needsAttention = useMemo(() => needsStartupGate(snapshot), [snapshot]);

  const runCheck = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const api = clientApi.getStartupOsPermissions;
      if (typeof api !== 'function') {
        setSnapshot(null);
        setOpen(false);
        return null;
      }
      const res = await api() as StartupPermissions;
      setSnapshot(res);
      if (needsStartupGate(res)) setOpen(true);
      else setOpen(false);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 检测失败不永久挡主壳
      setOpen(false);
      return null;
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  // 冷启动 / 主壳就绪：主动检测（macOS only）
  useEffect(() => {
    if (!enabled) return;
    if (!isMacPlatform()) return;
    let cancelled = false;
    void (async () => {
      const res = await runCheck();
      if (cancelled || !res) return;
      if (needsStartupGate(res)) setOpen(true);
      else setOpen(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, runCheck]);

  // 回前台 / 页面重新可见时自动重检
  useEffect(() => {
    if (!enabled) return;
    if (!isMacPlatform()) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const recheck = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void runCheck({ silent: true });
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
  }, [enabled, runCheck]);

  const openSettings = useCallback(async () => {
    setOpeningSettings(true);
    try {
      const res = await clientApi.openFullDiskAccessSettings?.({ isZh });
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


  const onAppDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const target = snapshot?.dragTarget;
    if (!target?.ok || !target.appPath) {
      event.preventDefault();
      setError(isZh ? '无法定位 Peer Agent.app，拖拽授权暂不可用。' : 'Could not locate Peer Agent.app for drag-to-grant.');
      return;
    }
    // 必须在 dragstart 同步调用主进程 startDrag（preload sendSync）。
    // 不要依赖 HTML5 dataTransfer 作为进系统设置列表的载荷。
    try {
      const result = clientApi.startAppDrag?.({ appPath: target.appPath }) as
        | { ok?: boolean; error?: string; filePath?: string }
        | void;
      if (result && result.ok === false) {
        setError(result.error || (isZh ? '拖拽启动失败' : 'Failed to start app drag'));
        event.preventDefault();
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      event.preventDefault();
      return;
    }
    try {
      event.dataTransfer?.setData('text/plain', target.displayName || target.appPath);
      event.dataTransfer!.effectAllowed = 'copyMove';
    } catch {
      // ignore
    }
  }, [snapshot?.dragTarget, isZh]);

  // hooks 全部结束后再决定是否渲染
  if (!enabled || !open || !needsAttention) return null;

  const checks = (snapshot?.checks || []).filter((c) => (
    c.status === 'blocked'
    || c.status === 'warn'
    || c.id === 'full-disk-access'
    || c.action === 'open_full_disk_access'
  ));
  const displayName = snapshot?.dragTarget?.displayName || 'Peer Agent';
  const canDrag = Boolean(snapshot?.dragTarget?.ok && snapshot?.dragTarget?.appPath);

  const node = (
    <div className="pa-overlay-backdrop" role="presentation">
      <div
        className="pa-overlay-panel fda-startup-gate"
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? 'Agent 必需权限' : 'Required permissions for Agent'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fda-startup-gate-body">
          <h2 className="fda-startup-gate-title">
            {isZh ? '需要授予 Agent 必需权限' : 'Required permissions for Agent'}
          </h2>
          <p className="fda-startup-gate-lead">
            {isZh
              ? 'Peer Agent 需要若干 macOS 系统权限才能可靠读写本机工作区与用户数据。以下权限仅在你使用相关能力时用到。'
              : 'Peer Agent needs a few macOS system permissions to work reliably with local workspaces and user data. These are only used while you use related features.'}
          </p>

          <div className="fda-permission-row">
            <div className="fda-permission-row-main">
              <span className="fda-permission-row-icon" aria-hidden>
                <img
                  className="fda-permission-logo"
                  src={snapshot?.dragTarget?.iconDataUrl || BRAND_LOGO_SRC}
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
                <strong>{isZh ? '完全磁盘访问（Agent 必需）' : 'Full Disk Access (required for Agent)'}</strong>
                <span>
                  {isZh
                    ? '用于读写受保护的本机目录与工作区数据'
                    : 'Needed to read/write protected local directories and workspace data'}
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
                src={snapshot?.dragTarget?.iconDataUrl || BRAND_LOGO_SRC}
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
                      ? '正在准备可拖拽的 App…'
                      : 'Preparing draggable app…')}
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

          {snapshot?.guidance?.fullDiskAccess ? (
            <p className="session-import-hint">{snapshot.guidance.fullDiskAccess}</p>
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
            <button type="button" className="updater-btn" disabled={loading} onClick={() => void runCheck()}>
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
