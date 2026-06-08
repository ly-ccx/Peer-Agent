import type { I18nRuntime, LocaleCode } from '@zeus-atlas/i18n';
import type { AuthState } from '@zeus-atlas/protocol';
import { useState } from 'react';
import { formatAuthIdentity } from '../../../app/runtimeLabels';
import { AppearancePanel } from '../../../appearance/AppearancePanel';
import { useAppearance } from '../../../appearance/AppearanceProvider';
import { clientApi } from '../../../clientApi';
import { SidebarIcon } from './SidebarIcon';

function accountDetail(authState: AuthState | null, identity: string) {
  if (authState?.status !== 'authenticated') return identity;
  return authState.user?.account ?? authState.user?.empId ?? authState.user?.name ?? identity;
}

/**
 * 底部按钮的身份/设置入口文案：「名字 · 工号」。
 * detail 跟 identity 相同时（fallback 链路退化）只显示一次避免「槿柏 · 槿柏」。
 */
function formatAccountButtonLabel(identity: string, detail: string): string {
  const trimmedIdentity = identity.trim();
  const trimmedDetail = detail.trim();
  if (!trimmedDetail || trimmedDetail === trimmedIdentity) return trimmedIdentity;
  return `${trimmedIdentity} · ${trimmedDetail}`;
}

export function SidebarAccountMenu({
  authState,
  i18n,
  onLocaleChanged,
  onOpenSettings,
  onAuthChanged,
}: {
  readonly authState: AuthState | null;
  readonly i18n: I18nRuntime;
  readonly onLocaleChanged?: () => Promise<void> | void;
  readonly onOpenSettings: () => void;
  readonly onAuthChanged?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'appearance'>('menu');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const { activeScheme, setMode, settings } = useAppearance();
  const identity = formatAuthIdentity(authState, i18n);
  const detail = accountDetail(authState, identity);
  /**
   * Atlas Vellum 下不再有"黑主题/白主题"两套，只有同一套设计语言的浅/深模式切换。
   * 黑 = dark mode, 白 = light mode。i18n 文案保留，语义对齐。
   */
  const useDarkMode = () => setMode('dark');
  const useLightMode = () => setMode('light');

  const switchLocale = async (locale: LocaleCode) => {
    if (locale === i18n.locale) return;
    await clientApi.setLocale(locale);
    onLocaleChanged?.();
  };

  // 退出登录：调用 main 进程 logout（清 token + 打开 BUC SSO 登出页），
  // 然后通过 onAuthChanged 触发 bootstrap 刷新，让 UI 切回 signed_out / not_configured。
  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await clientApi.logout();
      setOpen(false);
      setView('menu');
      await onAuthChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLogoutError(message);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="sidebar-account">
      {open ? (
        <div
          className={`sidebar-account-popover ${view === 'appearance' ? 'appearance' : ''}`}
          role="dialog"
          aria-label={view === 'appearance'
            ? i18n.t('appearance.title')
            : i18n.t('app.settings')}
        >
          {view === 'appearance' ? (
            <AppearancePanel i18n={i18n} onBack={() => setView('menu')} />
          ) : (
            <>
              <div className="sidebar-account-row muted">
                <SidebarIcon name="account" />
                <span>{detail}</span>
              </div>
              <div className="sidebar-account-row muted">
                <SidebarIcon name="settings" />
                <span>{i18n.t('account.personal')}</span>
              </div>
              <div className="sidebar-appearance-quick" role="group" aria-label={i18n.t('appearance.quick')}>
                <button
                  type="button"
                  className={settings.mode === 'dark' && activeScheme === 'dark' ? 'active' : ''}
                  onClick={useDarkMode}
                >
                  {i18n.t('appearance.quick.black')}
                </button>
                <button
                  type="button"
                  className={settings.mode === 'light' && activeScheme === 'light' ? 'active' : ''}
                  onClick={useLightMode}
                >
                  {i18n.t('appearance.quick.white')}
                </button>
                <button
                  type="button"
                  className={settings.mode === 'system' ? 'active' : ''}
                  onClick={() => setMode('system')}
                >
                  {i18n.t('appearance.mode.system')}
                </button>
              </div>
              <div
                className="sidebar-appearance-quick sidebar-locale-quick"
                role="group"
                aria-label={i18n.t('appearance.language')}
              >
                <button
                  type="button"
                  className={i18n.locale === 'zh-CN' ? 'active' : ''}
                  onClick={() => void switchLocale('zh-CN')}
                >
                  中文
                </button>
                <button
                  type="button"
                  className={i18n.locale === 'en-US' ? 'active' : ''}
                  onClick={() => void switchLocale('en-US')}
                >
                  English
                </button>
              </div>
              <div className="sidebar-account-separator" />
              <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}>
                <SidebarIcon name="settings" />
                <span>{i18n.t('app.settings')}</span>
              </button>
              <div className="sidebar-account-separator" />
              <button type="button">
                <SidebarIcon name="usage" />
                <span>{i18n.t('account.usageRemaining')}</span>
                <SidebarIcon name="chevron" />
              </button>
              <button
                type="button"
                onClick={() => { void handleLogout(); }}
                disabled={loggingOut || authState?.status !== 'authenticated'}
              >
                <SidebarIcon name="logout" />
                <span>{loggingOut ? i18n.t('auth.logout') + '…' : i18n.t('auth.logout')}</span>
              </button>
              {logoutError ? (
                <div className="sidebar-account-row muted" role="alert">
                  <span>{logoutError}</span>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <button
        type="button"
        className={`sidebar-account-button ${open ? 'active' : ''}`}
        aria-expanded={open}
        aria-label={i18n.t('app.settings')}
        onClick={() => {
          setOpen((current) => {
            if (current) setView('menu');
            return !current;
          });
        }}
      >
        {/* 身份印 + 设置入口合一：显示 名字 · 工号；展开 popover 才看到完整菜单 */}
        <span className="sidebar-avatar"><SidebarIcon name="settings" /></span>
        <strong>{formatAccountButtonLabel(identity, detail)}</strong>
        <SidebarIcon name="chevron" />
      </button>
    </div>
  );
}
