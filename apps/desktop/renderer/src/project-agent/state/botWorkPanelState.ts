import type { BotDocumentReference, ProjectAgentActivity, ProjectObjectiveView, TaskOverviewArtifact, TaskOverviewItem } from '@peer-agent/protocol';
import type { BotChatMessage, ConversationDisplayRow } from './botConversationState';
import type { BotWorkIndex } from './botWorkState';
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

export const WORK_PANEL_LANES = ['needsYou', 'doing', 'todo', 'delivered'] as const;
export type WorkPanelLane = typeof WORK_PANEL_LANES[number];

interface WorkPanelGrant {
  readonly grantId: string;
  readonly items: readonly { readonly sessionId: string }[];
}

export interface WorkPanelCard {
  readonly id: string;
  readonly messageId: string;
  readonly cardId: string;
  readonly sessionId?: string;
  readonly content: string;
  readonly kind: 'approval' | 'question';
}

export function workPanelCards(messages: readonly BotChatMessage[]): readonly WorkPanelCard[] {
  const cards = new Map<string, WorkPanelCard>();
  for (const message of messages) for (const card of message.cards) {
    const approval = card.kind === 'approval' || card.kind === 'plan_approval';
    if (!approval && card.kind !== 'question') continue;
    const id = card.refs?.approvalId ?? card.cardId;
    const sessionId = card.refs?.sessionId ?? card.actions?.map(action => action.payload?.sessionId)
      .find((value): value is string => typeof value === 'string');
    if (card.resolvedState === 'resolved') cards.delete(id);
    else if (card.actions?.length && (approval || sessionId)) cards.set(id, {
      id, messageId: message.id, cardId: card.cardId, sessionId, content: card.content, kind: approval ? 'approval' : 'question',
    });
  }
  return [...cards.values()];
}

type WorkPanelMatter =
  | { readonly kind: 'session'; readonly session: DrawerSession; readonly parent?: DrawerSession; readonly cards: readonly WorkPanelCard[] }
  | { readonly kind: 'card'; readonly card: WorkPanelCard }
  | { readonly kind: 'grant'; readonly grant: WorkPanelGrant }
  | { readonly kind: 'objective'; readonly objective: ProjectObjectiveView };

export type WorkPanelNode = WorkPanelMatter & { readonly id: string; readonly children: WorkPanelNode[] };
export interface WorkPanelGroup {
  readonly lane: WorkPanelLane;
  readonly roots: readonly WorkPanelNode[];
  readonly count: number;
}

export function workPanelNeedsUser(session: DrawerSession): boolean {
  return session.followUp ? session.followUp.owner === 'user' : session.status === 'waiting_user' || session.status === 'result_ready';
}

function sessionLane(session: DrawerSession): WorkPanelLane | undefined {
  const { status, followUp } = session;
  if (followUp?.reason === 'obligation_indexed' || status === 'cancelled' || status === 'superseded') return;
  if (followUp?.inCurrentList !== false && (workPanelNeedsUser(session)
    || ['verification_failed', 'technical_block', 'local_persistence_failed', 'execution_failed'].some(reason => reason === followUp?.reason)
    || status === 'failed')) return 'needsYou';
  if (status === 'accepted' || status === 'result_ready') return 'delivered';
  if (followUp?.inCurrentList === false) return;
  if (status === 'queued') return 'todo';
  if (followUp?.inCurrentList || ['starting', 'running', 'waiting_user', 'waiting_agent', 'stopping', 'awaiting_outcome', 'verifying'].includes(status)) return 'doing';
}

/** Each matter has one lane. Same-lane ancestry nests; a different lane promotes the child, not a copy of its parent. */
export function workPanelGroups(index: BotWorkIndex, objectives: readonly ProjectObjectiveView[] = [],
  grants: readonly WorkPanelGrant[] = [], cards: readonly WorkPanelCard[] = []): readonly WorkPanelGroup[] {
  const cardsBySession = new Map<string, WorkPanelCard[]>();
  for (const card of cards) if (card.sessionId) {
    const list = cardsBySession.get(card.sessionId) ?? [];
    list.push(card);
    cardsBySession.set(card.sessionId, list);
  }
  const embeddedCards = new Set<string>();
  const lanes = new Map(WORK_PANEL_LANES.map(lane => [lane, new Map<string, WorkPanelNode>()]));
  const covered = new Set(grants.flatMap(grant => grant.items.map(item => item.sessionId)));
  const linkedObjectives = new Set<string>();
  const sessions = index.available ? [...index.byId.values()] : [];
  // The archive remains available separately; cap only terminal rows, not active or blocked work.
  let recentDeliveries = 0;
  for (const session of sessions) {
    const sessionCards = cardsBySession.get(session.sessionId) ?? [];
    const lane = sessionCards.length ? 'needsYou' : sessionLane(session);
    if (!lane || covered.has(session.sessionId)) continue;
    for (const card of sessionCards) embeddedCards.add(card.id);
    if (lane === 'delivered' && recentDeliveries++ >= 8) continue;
    if (session.objectiveId && lane !== 'delivered') linkedObjectives.add(session.objectiveId);
    const parent = session.parentSessionId && session.parentSessionId !== session.sessionId
      ? index.byId.get(session.parentSessionId) : undefined;
    lanes.get(lane)!.set(session.sessionId, { kind: 'session', id: `session:${session.sessionId}`, session, parent, cards: sessionCards, children: [] });
  }
  for (const card of cards) {
    if (!embeddedCards.has(card.id) && !covered.has(card.sessionId ?? '')) {
      lanes.get('needsYou')!.set(`card:${card.id}`, { kind: 'card', id: `card:${card.id}`, card, children: [] });
    }
  }
  for (const grant of grants) {
    lanes.get('needsYou')!.set(`grant:${grant.grantId}`, { kind: 'grant', id: `grant:${grant.grantId}`, grant, children: [] });
  }
  for (const objective of objectives) {
    if (objective.status !== 'active' || linkedObjectives.has(objective.objectiveId)) continue;
    lanes.get('todo')!.set(`objective:${objective.objectiveId}`, { kind: 'objective', id: `objective:${objective.objectiveId}`, objective, children: [] });
  }
  return WORK_PANEL_LANES.flatMap(lane => {
    const nodes = lanes.get(lane)!;
    if (!nodes.size) return [];
    const roots: WorkPanelNode[] = [];
    // Process grants first. Link only to session keys, and treat malformed cyclic ancestry as roots.
    for (const node of [...nodes.values()].sort((a, b) => Number(b.kind === 'grant') - Number(a.kind === 'grant'))) {
      const parent = node.kind === 'session' && node.parent ? nodes.get(node.parent.sessionId) : undefined;
      const seen = new Set([node.id]);
      let cursor = parent;
      while (cursor?.kind === 'session' && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        cursor = cursor.parent ? nodes.get(cursor.parent.sessionId) : undefined;
      }
      if (parent && !cursor) parent.children.push(node);
      else roots.push(node);
    }
    return [{ lane, roots, count: nodes.size }];
  });
}

export function workPanelMaterialSections(materials: readonly BotWorkMaterial[]) {
  return { outputs: materials.filter(item => item.source !== 'reference'), references: materials.filter(item => item.source === 'reference') };
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
