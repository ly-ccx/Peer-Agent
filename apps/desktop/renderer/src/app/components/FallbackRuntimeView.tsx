import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  CapabilityManifest,
  ClientSessionState,
  WorkspaceProject,
} from '@peer-agent/protocol';
import { CapabilityInventory } from './CapabilityInventory';
import { RuntimeFacts } from './RuntimeFacts';

export type FallbackRuntimePage = 'home' | 'developer';

export function FallbackRuntimeView({
  capabilities,
  i18n,
  projects,
  session,
}: {
  readonly activePage: FallbackRuntimePage;
  readonly capabilities: readonly CapabilityManifest[];
  readonly i18n: I18nRuntime;
  readonly projects: readonly WorkspaceProject[];
  readonly session: ClientSessionState | null;
}) {
  return (
    <>
      <RuntimeFacts
        session={session}
        projects={projects}
        i18n={i18n}
      />
      <CapabilityInventory capabilities={capabilities} i18n={i18n} />
    </>
  );
}
