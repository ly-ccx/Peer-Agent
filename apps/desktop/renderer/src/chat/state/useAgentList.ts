import type { AuthState } from '@zeus-atlas/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { getWorkId } from './runtimeHelpers';

const AGENT_STORAGE_KEY = 'zeus-atlas.active-agent-id.v1';

export interface AgentSummary {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly status: string;
  readonly admin?: string;
  readonly accessControl?: {
    readonly mode?: string;
    readonly allowlistWorkIds?: readonly string[];
  };
}

function loadPersistedAgentId(): number | null {
  if (typeof window === 'undefined') return null;
  const stored = Number(window.localStorage.getItem(AGENT_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

function isAgentAccessible(agent: AgentSummary, workId: string): boolean {
  const ac = agent.accessControl;
  if (!ac || !ac.mode) {
    const admins = (agent.admin || '').split(',').map((s) => s.trim()).filter(Boolean);
    return admins.includes(workId);
  }
  if (ac.mode === 'PUBLIC') return true;
  if (ac.mode === 'USER_ALLOWLIST') {
    return Array.isArray(ac.allowlistWorkIds) && ac.allowlistWorkIds.includes(workId);
  }
  return false;
}

export function useAgentList(params: { readonly authState: AuthState | null }) {
  const { authState } = params;
  const workId = getWorkId(authState) ?? '';

  const [allAgents, setAllAgents] = useState<readonly AgentSummary[]>([]);
  const [activeAgentId, setActiveAgentIdRaw] = useState<number | null>(loadPersistedAgentId);

  const setActiveAgentId = useCallback((id: number) => {
    setActiveAgentIdRaw(id);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(AGENT_STORAGE_KEY, String(id));
    }
  }, []);

  useEffect(() => {
    if (authState?.status !== 'authenticated') return;
    void (async () => {
      try {
        const res: any = await clientApi.chat.listAgents({ pageNo: 1, pageSize: 100 });
        const raw = res?.data?.list ?? res?.data?.data?.list ?? res?.list ?? [];
        const list = Array.isArray(raw) ? raw : [];
        const mapped: AgentSummary[] = list
          .filter((a: any) => a && a.status === 'active')
          .map((a: any) => ({
            id: a.id,
            name: a.name || `Agent ${a.id}`,
            description: a.description,
            icon: a.icon,
            status: a.status,
            admin: a.admin,
            accessControl: a.extraConfig?.accessControl,
          }));
        setAllAgents(mapped);
      } catch {
        // Agent 列表加载失败不阻塞 UI
      }
    })();
  }, [authState?.status]);

  const agents = useMemo(
    () => (workId ? allAgents.filter((a) => isAgentAccessible(a, workId)) : []),
    [allAgents, workId]
  );

  const activeAgent = useMemo(
    () => agents.find((a) => a.id === activeAgentId) ?? agents[0] ?? null,
    [agents, activeAgentId]
  );

  const effectiveAgentId = activeAgent?.id ?? null;

  return { agents, activeAgent, activeAgentId: effectiveAgentId, setActiveAgentId };
}
