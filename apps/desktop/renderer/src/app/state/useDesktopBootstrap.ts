import type {
  CapabilityManifest,
  ClientSessionState,
  LlmProviderConfigView,
  LocaleCode,
  WorkspaceProject,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useResourceRead } from '../../ui/resources/useResourceState';
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
  readonly workspaces: readonly { readonly id: string; readonly path: string; readonly name: string; readonly addedAt: string }[];
}

export interface DesktopBootstrapState {
  readonly availableLocales: readonly LocaleCode[];
  readonly capabilities: readonly CapabilityManifest[];
  readonly initError: string | null;
  readonly loading: boolean;
  readonly projects: readonly WorkspaceProject[];
  /** Authoritative provider list from the same bootstrap the window starts from.
   * The composer must not depend on a single best-effort llm:list IPC succeeding. */
  readonly llmProviders: readonly LlmProviderConfigView[];
  readonly refreshBootstrap: () => Promise<void>;
  readonly session: ClientSessionState | null;
  readonly startupSnapshot: DesktopStartupSnapshot | null;
}

const EMPTY = { locales: [] as readonly LocaleCode[], capabilities: [] as readonly CapabilityManifest[], projects: [] as readonly WorkspaceProject[], providers: [] as readonly LlmProviderConfigView[] };

/** Bootstrap readiness owns the gate; optional warmup never holds the usable shell. */
export function useDesktopBootstrap(): DesktopBootstrapState {
  const resource = useResourceRead('desktop-bootstrap', () => clientApi.getBootstrap());
  const bootstrap = resource.value;
  const [startupSnapshot, setStartupSnapshot] = useState<DesktopStartupSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    setStartupSnapshot(null);
    if (bootstrap?.session) void (async () => {
      try {
        const directory = await clientApi.workspaceList();
        if (!active) return;
        const [workspaceInfo, conversationPage] = await Promise.all([
          directory.activeWorkspace ? clientApi.workspaceInfo({ path: directory.activeWorkspace }) : Promise.resolve(null),
          clientApi.conversationsList({ status: 'active', limit: CONVERSATION_LIST_PAGE_SIZE, paginated: true }),
        ]);
        if (!active) return;
        const page = normalizeConversationListPage(conversationPage);
        setStartupSnapshot({ activeWorkspace: directory.activeWorkspace, conversations: page.items,
          conversationNextCursor: page.nextCursor, conversationHasMore: page.hasMore, workspaceInfo, workspaces: directory.workspaces });
      } catch { /* Optional warmup cannot turn a usable bootstrap into a failure. */ }
    })();
    return () => { active = false; };
  }, [bootstrap]);
  const refreshBootstrap = useCallback(async () => { await resource.reload(); }, [resource.reload]);
  return {
    availableLocales: bootstrap?.availableLocales ?? EMPTY.locales,
    capabilities: bootstrap?.capabilities ?? EMPTY.capabilities,
    projects: bootstrap?.projects ?? EMPTY.projects,
    llmProviders: bootstrap?.llmProviders ?? EMPTY.providers,
    session: bootstrap?.session ?? null,
    initError: resource.error ? 'Local client bootstrap was not confirmed.' : null,
    loading: resource.loading,
    refreshBootstrap, startupSnapshot,
  };
}
