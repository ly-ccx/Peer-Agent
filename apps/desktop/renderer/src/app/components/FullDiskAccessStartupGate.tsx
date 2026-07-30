/**
 * 应用启动时的 macOS 完全磁盘访问权限门（表达层）。
 *
 * 注意：本组件必须保持 hooks 数量恒定；不要在 hooks 之后/之前插入条件 hooks。
 * Overlay 使用简单 children，避免 render-prop 路径引入额外复杂度。
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

  const needsAttention = useMemo(() => {
    if (!preflight) return false;
    if (preflight.ready) return false;
    return Boolean(
      preflight.blocked
      || preflight.checks?.some((c) => c.status === 'blocked' || c.action === 'open_full_disk_access'),
    );
  }, [preflight]);

  const runPreflight = useCallback(async () => {
    setLoading(true);
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
      if (res?.ready) setOpen(false);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpen(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator !== 'undefined') {
      const ua = navigator.platform || navigator.userAgent || '';
      if (!/Mac|macOS/i.test(ua)) return;
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
              ? 'Peer Agent 需要读取本机浏览器 Cookie 目录（例如 Chrome）才能导入站点会话。macOS 默认会拦截，请先授权后再继续。'
              : 'Peer Agent needs to read local browser cookie directories (e.g. Chrome) to import site sessions. macOS blocks this by default—grant access before continuing.'}
          </p>

          <div className="fda-permission-card">
            <button
              type="button"
              className="fda-permission-drag"
              draggable={Boolean(preflight?.dragTarget?.ok && preflight?.dragTarget?.appPath)}
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
                <strong>{preflight?.dragTarget?.displayName || 'Peer Agent'}</strong>
                <span>
                  {isZh
                    ? '按住我们的 LOGO，拖到系统设置 → 完全磁盘访问权限列表（列表不会自动出现 App）'
                    : 'Drag our logo into System Settings → Full Disk Access (apps never auto-appear)'}
                </span>
              </span>
            </button>
            <div className="fda-permission-actions">
              <button type="button" className="updater-btn" disabled={openingSettings} onClick={() => void openSettings()}>
                {openingSettings ? (isZh ? '打开中…' : 'Opening…') : (isZh ? '打开完全磁盘访问权限' : 'Open Full Disk Access')}
              </button>
              <button type="button" className="updater-btn ghost" onClick={() => void revealAppInFinder()}>
                {isZh ? '在 Finder 中显示 App' : 'Reveal app in Finder'}
              </button>
            </div>
          </div>

          <ol className="fda-startup-steps">
            <li>{isZh ? '点击「打开完全磁盘访问权限」' : 'Click “Open Full Disk Access”'}</li>
            <li>{isZh ? '把上方 LOGO 拖进列表并打开开关（列表不会自动出现 App）' : 'Drag the logo into the list and enable it (apps never auto-appear)'}</li>
            <li>{isZh ? '完全退出并重启 Peer Agent' : 'Fully quit and relaunch Peer Agent'}</li>
            <li>{isZh ? '回来后点「我已授权，重新检测」' : 'Then click “I’ve granted access — re-check”'}</li>
          </ol>

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
