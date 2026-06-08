import { createI18n } from '@zeus-atlas/i18n';
import { useEffect, useMemo, useState } from 'react';
import type { FallbackRuntimePage } from './app/components/FallbackRuntimeView';
import { FallbackRuntimeView } from './app/components/FallbackRuntimeView';
import { UpdateBanner } from './app/components/UpdateBanner';
import { isCloudRuntimeUsable } from './app/runtimeLabels';
import { useDesktopBootstrap } from './app/state/useDesktopBootstrap';
import { CloudChatSurface } from './chat/components/CloudChatSurface';

export function App() {
  const {
    authState,
    capabilities,
    cloudRuntime,
    initError,
    projects,
    refreshBootstrap,
    session,
  } = useDesktopBootstrap();
  const i18n = useMemo(() => createI18n(session?.locale), [session?.locale]);
  const [fallbackPage, setFallbackPage] = useState<FallbackRuntimePage>('home');
  const canUseCloudChatSurface = authState?.status === 'authenticated' && isCloudRuntimeUsable(cloudRuntime);
  const cloudRuntimeKey = [
    cloudRuntime?.mode ?? 'none',
    cloudRuntime?.endpoint ?? 'none',
    cloudRuntime?.streamEndpoint ?? 'none',
    cloudRuntime?.runtimeGatewayEndpoint ?? 'none',
    cloudRuntime?.source ?? 'none',
  ].join('|');

  useEffect(() => {
    if (canUseCloudChatSurface) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key.toLowerCase() !== 'd') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setFallbackPage('developer');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canUseCloudChatSurface]);

  return (
    <>
      <main className="app-shell">
        <section className="main-panel">
          <section className={`thread ${canUseCloudChatSurface ? 'cloud-thread-host' : ''}`}>
            {authState?.status === 'error' && authState.error ? (
              <p className="running-note">{i18n.t('auth.loginFailed', { message: authState.error })}</p>
            ) : null}
            {initError ? <p className="running-note">{initError}</p> : null}
            {!session && !initError ? <p className="runtime-note">{i18n.t('thread.loading.bootstrap')}</p> : null}
            {canUseCloudChatSurface ? (
              <CloudChatSurface
                key={cloudRuntimeKey}
                authState={authState}
                capabilities={capabilities}
                cloudRuntime={cloudRuntime}
                i18n={i18n}
                onDeveloperSettingsChanged={refreshBootstrap}
                onLocaleChanged={refreshBootstrap}
                onAuthChanged={refreshBootstrap}
              />
            ) : (
              <FallbackRuntimeView
                activePage={fallbackPage}
                authState={authState}
                capabilities={capabilities}
                cloudRuntime={cloudRuntime}
                i18n={i18n}
                projects={projects}
                onCloseDeveloperSettings={() => setFallbackPage('home')}
                onDeveloperSettingsChanged={refreshBootstrap}
                session={session}
              />
            )}
          </section>
        </section>
      </main>
      <UpdateBanner />
    </>
  );
}
