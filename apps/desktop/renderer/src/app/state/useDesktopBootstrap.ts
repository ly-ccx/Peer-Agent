import type {
  CapabilityManifest,
  ClientSessionState,
  LocaleCode,
  WorkspaceProject,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { normalizeConversationListPage } from '../../chat/state/conversationListPagination';

/** 侧栏首屏只拉最近 N 条；展开工作区或点「更多」再按工作区续拉。 */
export const CONVERSATION_LIST_PAGE_SIZE = 40;

export interface DesktopStartupSnapshot {
  readonly activeWorkspace: string | null;
  readonly conversationNextCursor?: string | null;
  readonly conversationHasMore?: boolean;
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
      // 冷启动门闩：bootstrap 成功即可离开启动页（session 非 null）。
      // workspace / 会话列表属于可后台填充的预加载，不应阻塞 BrandStartupLoader。
      setAvailableLocales(bootstrap.availableLocales);
      setCapabilities(bootstrap.capabilities);
      setProjects(bootstrap.projects);
      setSession(bootstrap.session);
      setInitError(null);

      if (!bootstrap.session) {
        setStartupSnapshot(null);
        return;
      }

      try {
        const directory = await clientApi.workspaceList();
        const [workspaceInfo, conversationPage] = await Promise.all([
          directory.activeWorkspace ? clientApi.workspaceInfo({ path: directory.activeWorkspace }) : Promise.resolve(null),
          clientApi.conversationsList({
            status: 'active',
            limit: CONVERSATION_LIST_PAGE_SIZE,
            paginated: true,
          }),
        ]);
        const page = normalizeConversationListPage(conversationPage);
        setStartupSnapshot({
          activeWorkspace: directory.activeWorkspace,
          conversations: page.items,
          conversationNextCursor: page.nextCursor,
          conversationHasMore: page.hasMore,
          workspaceInfo,
          workspaces: directory.workspaces,
        });
      } catch {
        // Bootstrap remains usable when optional workspace preloading fails.
        // App and Sidebar will fall back to their normal background refresh paths.
        setStartupSnapshot(null);
      }
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
