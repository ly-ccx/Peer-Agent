import type { ResourceDetailRef } from '../../workbench/resourceDetailState';
import type { DrawerMemory } from '../state/drawerState';
import type { BotInspect } from './agentProcess';

export function botDetailReference(workspaceId: string, memory: DrawerMemory, inspect: BotInspect | null): ResourceDetailRef {
  if (inspect?.evidence) return { workspaceId, kind: 'evidence', evidenceRef: inspect.evidence.evidenceRef, replyId: inspect.replyId };
  if (inspect?.replyId) return { workspaceId, kind: 'reply', replyId: inspect.replyId };
  if (inspect) return { workspaceId, kind: 'process' };
  if (memory.tab === 'tasks' && memory.sessionId) return { workspaceId, kind: 'task', sessionId: memory.sessionId };
  return { workspaceId, kind: 'bot' };
}
