/**
 * 应用启动时的 macOS 完全磁盘访问权限门（表达层）。
 *
 * 产品要求：不是进 Browser 导入向导才查，而是一打开 App 就自检；
 * 缺失时引导用户把当前 App 拖进「系统设置 → 完全磁盘访问权限」。
 *
 * 能力真相仍在主进程 preflight / startDrag；本组件只负责启动时展示与交互。
 */
import { type DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Overlay } from './Overlay';

const DISMISS_STORAGE_KEY = 'peer.fullDiskAccess.startupGate.dismissedAt';
/** 点「稍后」后 24 小时内不再强弹（仍可在导入向导里看）。 */
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

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

function readDismissedAt(): number {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeDismissedAt(ts: number): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, String(ts));
  } catch {
    // ignore quota / privacy mode
  }
}

function clearDismissedAt(): void {
  try {
    window.localStorage.removeItem(DISMISS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function FullDiskAccessStartupGate({
  enabled,
  isZh,
}: {
  /** bootstrap 完成后才启用，避免抢 BrandStartupLoader。 */
  readonly enabled: boolean;
  readonly isZh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  const needsAttention = useMemo(() => {
    if (!preflight) return false;
    if (preflight.ready) return false;
    // 仅在 macOS 且确实被权限/环境挡住时弹。
    return Boolean(
      preflight.blocked
      || preflight.checks?.some((c) => c.status === 'blocked' || c.action === 'open_full_disk_access'),
    );
  }, [preflight]);

  const runPreflight = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi.getBrowserSessionImportPreflight();
      setPreflight(res as Preflight);
      if ((res as Preflight)?.ready) {
        clearDismissedAt();
        setOpen(false);
      }
      return res as Preflight;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // 非 macOS 不弹。
    if (typeof navigator !== 'undefined' && !/Mac|macOS/i.test(navigator.platform || navigator.userAgent || '')) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await runPreflight();
      if (cancelled || !res) return;
      const blocked = Boolean(
        res.blocked || res.checks?.some((c) => c.status === 'blocked' || c.action === 'open_full_disk_access'),
      );
      if (!blocked || res.ready) {
        setOpen(false);
        return;
      }
      const dismissedAt = readDismissedAt();
      if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) {
        setOpen(false);
        return;
      }
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, runPreflight]);

  const openSettings = useCallback(async () => {
    setOpeningSettings(true);
    try {
      const res = await clientApi.openFullDiskAccessSettings?.();
      if (res && res.ok === false) {
        setError(res.error || (isZh ? '无法打开系统设置' : 'Failed to open System Settings'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningSettings(false);
    }
  }, [isZh]);

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

  const statusLabel = useCallback((status: PreflightCheck['status']) => {
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
  }, [isZh]);

  if (!enabled || !open || !needsAttention) return null;

  return (
    <Overlay
      onClose={() => {
        writeDismissedAt(Date.now());
        setOpen(false);
      }}
      closeOnBackdrop={false}
      ariaLabel={isZh ? '完全磁盘访问权限' : 'Full Disk Access'}
      panelClassName="fda-startup-gate"
    >
      {({ requestClose }) => (
        <div className="fda-startup-gate-body">
          <h2 className="fda-startup-gate-title">
            {isZh ? '需要完全磁盘访问权限' : 'Full Disk Access required'}
          </h2>
          <p className="fda-startup-gate-lead">
            {isZh
              ? 'Peer Agent 需要读取本机浏览器 Cookie 目录（例如 Chrome）才能导入站点会话。macOS 默认会拦截，请先授权后再继续。'
              : 'Peer Agent needs to read local browser cookie directories (e.g. Chrome) to import site sessions. macOS blocks this by default—grant access before continuing.'}
          </p>

          {preflight?.dragTarget?.ok ? (
            <div className="session-import-drag-card fda-startup-drag">
              <button
                type="button"
                className="session-import-drag-handle"
                draggable
                onDragStart={onAppDragStart}
                title={isZh ? '拖到“完全磁盘访问权限”列表' : 'Drag into Full Disk Access list'}
              >
                {preflight.dragTarget.iconDataUrl ? (
                  <img
                    className="session-import-drag-icon"
                    src={preflight.dragTarget.iconDataUrl}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <span className="session-import-drag-icon fallback" aria-hidden>App</span>
                )}
                <span className="session-import-drag-meta">
                  <strong>{preflight.dragTarget.displayName || 'Peer Agent'}</strong>
                  <span>
                    {isZh
                      ? '按住此图标，拖到系统设置 → 完全磁盘访问权限列表'
                      : 'Drag this icon into System Settings → Full Disk Access'}
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          <ol className="fda-startup-steps">
            <li>{isZh ? '点击下方「打开完全磁盘访问权限」' : 'Click “Open Full Disk Access” below'}</li>
            <li>{isZh ? '把上方 App 图标拖进列表，并打开开关' : 'Drag the app icon into the list and enable it'}</li>
            <li>{isZh ? '完全退出并重启 Peer Agent' : 'Fully quit and relaunch Peer Agent'}</li>
            <li>{isZh ? '回来后点「我已授权，重新检测」' : 'Then click “I’ve granted access — re-check”'}</li>
          </ol>

          {preflight?.guidance?.fullDiskAccess ? (
            <p className="session-import-hint">{preflight.guidance.fullDiskAccess}</p>
          ) : null}

          <ul className="session-import-preflight-list fda-startup-checks">
            {(preflight?.checks || [])
              .filter((c) => c.status === 'blocked' || c.status === 'warn' || c.status === 'missing' || c.id === 'full-disk-access' || c.id.startsWith('cookies:'))
              .map((check) => (
                <li key={check.id} className={`session-import-preflight-item is-${check.status}`}>
                  <div className="session-import-preflight-item-top">
                    <span className="session-import-preflight-status">{statusLabel(check.status)}</span>
                    <strong>{check.title}</strong>
                  </div>
                  <p>{check.detail}</p>
                </li>
              ))}
          </ul>

          {error ? <div className="session-import-error">{error}</div> : null}

          <div className="fda-startup-actions">
            <button
              type="button"
              className="updater-btn"
              disabled={openingSettings}
              onClick={() => void openSettings()}
            >
              {openingSettings
                ? (isZh ? '打开中…' : 'Opening…')
                : (isZh ? '打开完全磁盘访问权限' : 'Open Full Disk Access')}
            </button>
            <button
              type="button"
              className="updater-btn"
              disabled={loading}
              onClick={() => void runPreflight()}
            >
              {loading
                ? (isZh ? '检测中…' : 'Checking…')
                : (isZh ? '我已授权，重新检测' : 'I’ve granted access — re-check')}
            </button>
            <button
              type="button"
              className="updater-btn ghost"
              onClick={() => {
                writeDismissedAt(Date.now());
                requestClose();
              }}
            >
              {isZh ? '稍后' : 'Later'}
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}
