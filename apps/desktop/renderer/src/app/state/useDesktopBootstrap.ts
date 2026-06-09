import type {
  CapabilityManifest,
  ClientSessionState,
  WorkspaceProject,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface DesktopBootstrapState {
  readonly capabilities: readonly CapabilityManifest[];
  readonly initError: string | null;
  readonly projects: readonly WorkspaceProject[];
  readonly refreshBootstrap: () => Promise<void>;
  readonly session: ClientSessionState | null;
}

export function useDesktopBootstrap(): DesktopBootstrapState {
  const [session, setSession] = useState<ClientSessionState | null>(null);
  const [capabilities, setCapabilities] = useState<readonly CapabilityManifest[]>([]);
  const [projects, setProjects] = useState<readonly WorkspaceProject[]>([]);
  const [initError, setInitError] = useState<string | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const bootstrap = await clientApi.getBootstrap();
      setSession(bootstrap.session);
      setCapabilities(bootstrap.capabilities);
      setProjects(bootstrap.projects);
      setInitError(null);
    } catch (error: unknown) {
      setInitError(error instanceof Error ? error.message : 'Failed to bootstrap local client.');
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  return {
    capabilities,
    initError,
    projects,
    refreshBootstrap: loadBootstrap,
    session,
  };
}
