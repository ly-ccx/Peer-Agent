import type { I18nRuntime } from '@zeus-atlas/i18n';
import type {
  AuthState,
  CapabilityManifest,
  ClientSessionState,
  CloudRuntimeState,
  WorkspaceProject,
} from '@zeus-atlas/protocol';
import { CapabilityInventory } from './CapabilityInventory';
import { DeveloperSettingsPanel } from './DeveloperSettingsPanel';
import { EmptyCloudTask } from './EmptyCloudTask';
import { RuntimeFacts } from './RuntimeFacts';

export type FallbackRuntimePage = 'home' | 'developer';

export function FallbackRuntimeView({
  activePage,
  authState,
  capabilities,
  cloudRuntime,
  i18n,
  onDeveloperSettingsChanged,
  onCloseDeveloperSettings,
  projects,
  session,
}: {
  readonly activePage: FallbackRuntimePage;
  readonly authState: AuthState | null;
  readonly capabilities: readonly CapabilityManifest[];
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly i18n: I18nRuntime;
  readonly onDeveloperSettingsChanged?: () => Promise<void> | void;
  readonly onCloseDeveloperSettings: () => void;
  readonly projects: readonly WorkspaceProject[];
  readonly session: ClientSessionState | null;
}) {
  if (activePage === 'developer') {
    return (
      <section className="developer-page fallback-developer-page" aria-label={i18n.t('developer.title')}>
        <DeveloperSettingsPanel
          authState={authState}
          i18n={i18n}
          onApplied={onDeveloperSettingsChanged ?? (() => undefined)}
          onBack={onCloseDeveloperSettings}
        />
      </section>
    );
  }

  // 未登录态：只显示登录 hero，干净的首屏；RuntimeFacts / CapabilityInventory 留给登录后的开发者面板
  const isAuthenticated = authState?.status === 'authenticated';

  return (
    <>
      <EmptyCloudTask
        authState={authState}
        cloudRuntime={cloudRuntime}
        i18n={i18n}
      />
      {isAuthenticated ? (
        <>
          <RuntimeFacts
            session={session}
            cloudRuntime={cloudRuntime}
            authState={authState}
            projects={projects}
            i18n={i18n}
          />
          <CapabilityInventory capabilities={capabilities} i18n={i18n} />
        </>
      ) : null}
    </>
  );
}
