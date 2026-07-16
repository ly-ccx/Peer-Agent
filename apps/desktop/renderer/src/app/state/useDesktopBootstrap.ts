import type {
  CapabilityManifest,
  ClientSessionState,
  LocaleCode,
  WorkspaceProject,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface DesktopStartupSnapshot {
  readonly activeWorkspace: string | null;
  readonly conversations: readonly {
    readonly id: string;
    readonly title: string;
    readonly messageCount: number;
    readonly updatedAt: string;
    readonly status?: 'active' | 'archived';
    readonly archivedAt?: string | null;
    readonly pinnedAt?: string | null;
    readonly pinnedOrder?: number | null;
  }[];
  readonly workspaceInfo: { readonly name: string; readonly absolutePath: string; readonly git?: { readonly branch?: string; readonly isDirty?: boolean } } | null;
  readonly workspaces: readonly { readonly path: string; readonly name: string; readonly addedAt: string }[];
}

export interface DesktopBootstrapState {
  readonly availableLocales: readonly LocaleCode[];
  readonly capabilities: readonly CapabilityManifest[];
  readonly initError: string | null;
  readonly projects: readonly WorkspaceProject[];
  readonly refreshBootstrap: () => Promise<void>;
  readonly session: ClientSessionState | null;
  readonly startupSnapshot: DesktopStartupSnapshot | null;
}

export function useDesktopBootstrap(): DesktopBootstrapState {
  const [session, setSession] = useState<ClientSessionState | null>(null);
  const [startupSnapshot, setStartupSnapshot] = useState<DesktopStartupSnapshot | null>(null);
  const [availableLocales, setAvailableLocales] = useState<readonly LocaleCode[]>([]);
  const [capabilities, setCapabilities] = useState<readonly CapabilityManifest[]>([]);
  const [projects, setProjects] = useState<readonly WorkspaceProject[]>([]);
  const [initError, setInitError] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const bootstrap = await clientApi.getBootstrap();
      let nextSnapshot: DesktopStartupSnapshot | null = null;
      if (bootstrap.session) {
        try {
          const directory = await clientApi.workspaceList();
          const [workspaceInfo, conversations] = await Promise.all([
            directory.activeWorkspace ? clientApi.workspaceInfo({ path: directory.activeWorkspace }) : Promise.resolve(null),
            clientApi.conversationsList({ workspacePath: directory.activeWorkspace, status: 'active' }),
          ]);
          nextSnapshot = {
            activeWorkspace: directory.activeWorkspace,
            conversations,
            workspaceInfo,
            workspaces: directory.workspaces,
          };
        } catch {
          // Bootstrap remains usable when optional workspace preloading fails.
          // App and Sidebar will fall back to their normal background refresh paths.
        }
      }
      setStartupSnapshot(nextSnapshot);
      setAvailableLocales(bootstrap.availableLocales);
      setCapabilities(bootstrap.capabilities);
      setProjects(bootstrap.projects);
      setSession(bootstrap.session);
      setInitError(null);
    } catch (error: unknown) {
      setInitError(error instanceof Error ? error.message : 'Failed to bootstrap local client.');
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  return {
    availableLocales,
    capabilities,
    initError,
    projects,
    refreshBootstrap: loadBootstrap,
    session,
    startupSnapshot,
  };
}
