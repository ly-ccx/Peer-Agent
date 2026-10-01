import type { AutomationSchedule } from './automation.ts';

export type ObjectiveAutonomy = 'report_only' | 'propose' | 'act';
export type ObjectiveStatus = 'active' | 'paused' | 'achieved' | 'abandoned';
export type WatchSeverity = 'info' | 'notable' | 'urgent';
export type ObjectiveProbe =
  | { readonly type: 'deterministic'; readonly check: 'git_ref'; readonly spec: { readonly ref: string } }
  | { readonly type: 'deterministic'; readonly check: 'file_hash'; readonly spec: { readonly path: string } }
  | { readonly type: 'deterministic'; readonly check: 'command'; readonly spec: { readonly command: 'gh_run_list'; readonly workflow?: string } }
  | { readonly type: 'agent'; readonly question: string };
export type WatchEventSource =
  | { readonly type: 'task_event'; readonly filter: 'failed' | 'ended' | 'verified' }
  | { readonly type: 'git'; readonly ref: string; readonly on: 'new_commits' | 'new_tag' }
  | { readonly type: 'files'; readonly paths: readonly string[]; readonly debounceMs?: 5000 };
export type ObjectiveWatch = (
  | { readonly watchId: string; readonly kind: 'schedule'; readonly schedule: AutomationSchedule; readonly probe: ObjectiveProbe }
  | { readonly watchId: string; readonly kind: 'event'; readonly source: WatchEventSource; readonly probe?: ObjectiveProbe }
) & { readonly lastScheduledAt?: string; readonly nextRunAt?: string; readonly unavailableReason?: string };
export interface ObjectiveSignal {
  readonly signalId: string;
  readonly watchId: string;
  readonly operator: 'equals' | 'contains' | 'succeeded';
  readonly value?: string;
}
export interface ObjectiveMilestone {
  readonly id: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  readonly status: 'pending' | 'active' | 'done' | 'dropped';
}
export interface ObjectiveBudget {
  readonly maxAutoSessionsPerDay: number;
  readonly maxProbeRunsPerDay: number;
  /** Reject this optional policy until the host can enforce a token hard limit. */
  readonly maxTokensPerDay?: number;
}
export interface ProjectObjective {
  readonly objectiveId: string;
  readonly workspaceId: string;
  readonly projectAgentConversationId: string;
  readonly originMessageId: string;
  readonly title: string;
  readonly outcome: string;
  readonly successSignals: readonly ObjectiveSignal[];
  readonly milestones: readonly ObjectiveMilestone[];
  readonly autonomy: ObjectiveAutonomy;
  readonly watches: readonly ObjectiveWatch[];
  readonly budget: ObjectiveBudget;
  readonly status: ObjectiveStatus;
  readonly createdBy: 'user_request' | 'agent_proposal';
  readonly pendingConfirmation?: boolean;
  readonly deadline?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}
export interface WatchObservation {
  readonly objectiveId: string;
  readonly watchId: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly severity: WatchSeverity;
  readonly changed: boolean;
  readonly succeeded?: boolean;
  readonly value?: string;
  readonly executionKey?: string;
}
export interface ProjectObjectiveListRequest { readonly workspaceId: string; }
export interface ProjectObjectiveCommandRequest extends ProjectObjectiveListRequest {
  readonly objectiveId: string;
  readonly requestId: string;
}
export interface ProjectObjectiveUpdateRequest extends ProjectObjectiveCommandRequest {
  readonly patch: Partial<Pick<ProjectObjective, 'title' | 'outcome' | 'watches' | 'milestones' | 'successSignals' | 'autonomy' | 'budget' | 'deadline'>>;
  readonly expectedVersion?: number;
}
export interface ProjectObjectiveView extends ProjectObjective {
  readonly lastObservation?: WatchObservation | null;
  readonly usage?: { readonly autoSessions: number; readonly probes: number; readonly date: string };
}
export interface ProjectObjectiveListResult { readonly ok: boolean; readonly code?: string; readonly items?: readonly ProjectObjectiveView[]; }
export interface ProjectObjectiveItemResult { readonly ok: boolean; readonly code?: string; readonly item?: ProjectObjective; }

/** The first observation is a change; summaries and caller flags cannot override digest truth. */
export function diffWatchObservation(prev: WatchObservation | null | undefined,
  next: Omit<WatchObservation,'changed'> & { readonly changed?: boolean }): WatchObservation {
  return {objectiveId:next.objectiveId,watchId:next.watchId,observedAt:next.observedAt,digest:next.digest,summary:next.summary,
    evidenceRefs:next.evidenceRefs,severity:next.severity,changed:!prev||prev.digest!==next.digest,
    ...(typeof next.succeeded==='boolean'?{succeeded:next.succeeded}:{}),...(typeof next.value==='string'?{value:next.value}:{})};
}
