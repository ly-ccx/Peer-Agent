import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, CloudRuntimeState } from '@zeus-atlas/protocol';
import { useState } from 'react';
import { clientApi } from '../../clientApi';
import { isCloudRuntimeUsable } from '../runtimeLabels';

/**
 * Atlas Vellum 启动页 / 未登录态首屏
 * 单列居中布局：朱砂方印（"宙"）+ Serif "宙斯 OS" + 简介 + Primary 登录
 * 底部 hairline + 版权 caption
 * 开发者面板入口走 Cmd+Shift+D 全局快捷键（已在 App.tsx 注册）
 */
export function EmptyCloudTask({
  authState,
  cloudRuntime,
  i18n,
}: {
  readonly authState: AuthState | null;
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly i18n: I18nRuntime;
}) {
  const needsAuth = authState?.status !== 'authenticated';
  const needsCloud = !isCloudRuntimeUsable(cloudRuntime);
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoginPending(true);
    setLoginError(null);
    try {
      await clientApi.login();
      // 登录成功后通过 reload 让 useDesktopBootstrap 重新拉取全量状态
      // 比单独建立 auth 订阅通道更稳健，反正主进程已经持有 token
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      // 用户主动取消（handleCancel 触发 login reject）不算失败，静默复位即可
      if (!/cancel/i.test(message)) {
        setLoginError(message);
      }
      setLoginPending(false);
    }
  };

  const handleCancel = () => {
    // 取消挂起的登录（典型：跳去另一平台申请权限后回到客户端）：中断 main 的
    // callback 等待、释放端口；上面 handleLogin 的 await 会随之 reject，统一在 catch 复位。
    void clientApi.cancelLogin();
  };

  return (
    <section className="atlas-startup">
      <div className="atlas-startup-hero">
        <h1 className="atlas-startup-title">宙斯 OS<span className="atlas-startup-subtitle">Hermes</span></h1>
        <p className="atlas-startup-body">让 AI 懂你的工作，而不只是回答你的问题。</p>
        <div className="atlas-startup-actions">
          {needsAuth ? (
            loginPending ? (
              <>
                <button type="button" className="atlas-startup-primary" disabled>
                  {i18n.t('auth.signing_in')}
                </button>
                <button
                  type="button"
                  className="atlas-startup-secondary"
                  onClick={handleCancel}
                >
                  {i18n.t('auth.cancelLogin')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="atlas-startup-primary"
                onClick={() => void handleLogin()}
              >
                {`${i18n.t('auth.login')} BUC`}
              </button>
            )
          ) : null}
          {!needsAuth && needsCloud ? (
            <span className="atlas-startup-status">{i18n.t('thread.empty.cloudAction')}</span>
          ) : null}
        </div>
        {loginError ? <p className="atlas-startup-error">{loginError}</p> : null}
        {loginPending ? (
          <p className="atlas-startup-hint">{i18n.t('auth.permissionHint')}</p>
        ) : null}
      </div>
      <footer className="atlas-startup-footer">
        © 2026 阿里巴巴group · 1688 AI · 服务条款 · 隐私
      </footer>
    </section>
  );
}
