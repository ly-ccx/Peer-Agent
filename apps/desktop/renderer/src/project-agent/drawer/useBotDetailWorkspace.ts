import { useEffect } from 'react';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { botDetailReference } from './botDetailReference';
import { resourceDetailKey } from '../../workbench/resourceDetailState';
import type { DrawerMemory } from '../state/drawerState';
import type { BotInspect } from './agentProcess';

/** Bridges existing domain state into one presentation slot, without becoming its owner. */
export function useBotDetailWorkspace(workspaceId: string, memory: DrawerMemory, inspect: BotInspect | null, title: string) {
  const workspace = useResourceWorkspace();
  const register = workspace?.registerDetail, show = workspace?.showDetails;
  const reference = botDetailReference(workspaceId, memory, inspect);
  const key = resourceDetailKey(reference);
  const ready = !!workspace?.ready && workspace.owner?.workspaceId === workspaceId;
  useEffect(() => { if (ready) register?.({ target: reference, title }); }, [ready, register, key, title]);
  // Domain navigation may need to reveal the workspace, but changing a detail
  // inside the visible pane must not override that domain's focus restoration.
  // Closing the workspace is not a new navigation intent and must not reopen it.
  useEffect(() => { if (ready && memory.open && (!workspace?.open || !workspace.detailActive)) show?.(); }, [ready, show, memory.open, key]);
  return workspace;
}
