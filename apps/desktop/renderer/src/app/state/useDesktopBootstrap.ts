import type {
  AuthState,
  CapabilityManifest,
  ClientSessionState,
  CloudRuntimeState,
  WorkspaceProject,
} from '@zeus-atlas/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface DesktopBootstrapState {
  readonly authState: AuthState | null;
  readonly capabilities: readonly CapabilityManifest[];
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly initError: string | null;
  readonly isDevMode: boolean;
  readonly projects: readonly WorkspaceProject[];
  readonly refreshBootstrap: () => Promise<void>;
  readonly session: ClientSessionState | null;
}

export function useDesktopBootstrap(): DesktopBootstrapState {
  const [session, setSession] = useState<ClientSessionState | null>(null);
  const [capabilities, setCapabilities] = useState<readonly CapabilityManifest[]>([]);
  const [projects, setProjects] = useState<readonly WorkspaceProject[]>([]);
  const [cloudRuntime, setCloudRuntime] = useState<CloudRuntimeState | null>(null);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [isDevMode, setIsDevMode] = useState<boolean>(false);

  const loadBootstrap = useCallback(async () => {
    try {
      const bootstrap = await clientApi.getBootstrap();
      setSession(bootstrap.session);
      setCapabilities(bootstrap.capabilities);
      setProjects(bootstrap.projects);
      setCloudRuntime(bootstrap.cloudRuntime);
      setAuthState(bootstrap.auth);
      setIsDevMode(bootstrap.runtime?.isDevMode ?? false);
      setInitError(null);
    } catch (error: unknown) {
      setInitError(error instanceof Error ? error.message : 'Failed to bootstrap local client.');
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  return {
    authState,
    capabilities,
    cloudRuntime,
    initError,
    isDevMode,
    projects,
    refreshBootstrap: loadBootstrap,
    session,
  };
}
