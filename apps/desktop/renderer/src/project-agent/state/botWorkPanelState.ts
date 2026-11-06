import type { BotDocumentReference, ProjectAgentActivity, TaskOverviewArtifact, TaskOverviewItem } from '@peer-agent/protocol';
import type { BotChatMessage, ConversationDisplayRow } from './botConversationState';
import type { BotWorkIndex } from './botWorkState';
import { backgroundWork } from './botWorkState.ts';
import { isActivityRunning } from './botActivityState.ts';
import type { DrawerSession } from './drawerState';

export const BOT_WORK_PANEL_MIN_WIDTH = 864;

export interface BotWorkMaterial {
  readonly id: string;
  readonly label: string;
  readonly kind: 'file' | 'code' | 'image';
  readonly source: 'artifact' | 'output' | 'reference';
  readonly sourceLabel?: string;
  readonly reference?: BotDocumentReference;
  readonly preview?: TaskOverviewArtifact['preview'];
  readonly sessionId?: string;
}

/** Only published current activity can describe the Bot's attention. */
export function workPanelActivity(rows: readonly ConversationDisplayRow[]): ProjectAgentActivity | undefined {
  return [...rows].reverse().flatMap(row => row.type === 'separator' ? [] : row.activity ? [row.activity] : [])
    .find(activity => isActivityRunning(activity));
}

export function workPanelSessions(index: BotWorkIndex) {
  const current = backgroundWork(index).rows.flatMap(row => row.session ? [row.session] : []);
  const currentIds = new Set(current.map(session => session.sessionId));
  const roots = current.filter(session => !session.parentSessionId || !currentIds.has(session.parentSessionId));
  // A direct task worker is itself an Agent. Include returned children while their parent is followed up.
  const agents = index.available ? [...new Map([...current, ...[...index.byId.values()]
    .filter(session => session.parentSessionId && currentIds.has(session.parentSessionId))]
    .map(session => [session.sessionId, session])).values()] : [];
  return { tasks: roots, agents };
}

export function workPanelNeedsUser(session: DrawerSession): boolean {
  return session.followUp ? session.followUp.owner === 'user' : session.status === 'waiting_user' || session.status === 'result_ready';
}

/** Public read/write locators and host-projected artifacts only; never scrape assistant prose. */
export function workPanelMaterials(workspaceId: string, index: BotWorkIndex, items: readonly TaskOverviewItem[],
  messages: readonly BotChatMessage[], activity?: Pick<ProjectAgentActivity, 'resourceReferences'>): readonly BotWorkMaterial[] {
  const byPlan = new Map([...index.byId.values()].flatMap(session => session.planId ? [[session.planId, session] as const] : []));
  const materials = new Map<string, BotWorkMaterial>();
  const pathKey = (reference: BotDocumentReference) => JSON.stringify([reference.workspaceId, reference.task?.sessionId ?? '',
    reference.task?.planId ?? '', reference.path.replace(/\\/g, '/')]);
  for (const item of items) {
    if (item.source !== 'goal_plan') continue;
    const session = byPlan.get(item.taskId);
    const task = session?.planId ? { sessionId: session.sessionId, planId: session.planId } : undefined;
    for (const artifact of item.planSteps?.flatMap(step => step.artifacts ?? []) ?? []) {
      const reference: BotDocumentReference | undefined = artifact.openPath
        ? { workspaceId, path: artifact.openPath, ...(task ? { task } : {}) } : undefined;
      const id = reference ? pathKey(reference) : JSON.stringify([item.taskId, artifact.ref]);
      if (!materials.has(id)) materials.set(id, { id, label: artifact.label, kind: artifact.kind, source: 'artifact', sourceLabel: item.title,
        reference, preview: artifact.preview, sessionId: session?.sessionId });
    }
  }
  const references = [...messages].reverse().flatMap(message => message.resourceReferences ?? []);
  if (activity?.resourceReferences) references.unshift(...activity.resourceReferences);
  for (const hint of references) {
    const reference = { workspaceId, path: hint.path };
    const id = pathKey(reference);
    const existing = materials.get(id);
    if (existing && (existing.source !== 'reference' || hint.tool === 'read_file')) continue;
    const name = hint.path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || hint.path;
    materials.set(id, { id, label: name, kind: /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(name) ? 'image' : 'file',
      source: hint.tool === 'read_file' ? 'reference' : 'output', reference });
  }
  return [...materials.values()];
}
