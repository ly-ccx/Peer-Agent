/** Project objectives and watch observations. Types only, plus digest comparison. */

export type ObjectiveAutonomy = 'report_only' | 'propose' | 'act';

export type WatchTrigger = 'schedule' | 'git' | 'file' | 'ci';

export type ObjectiveStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

export interface ObjectiveWatch {
  readonly watchId: string;
  readonly trigger: WatchTrigger;
  readonly schedule?: string;
  readonly ref?: string;
  readonly paths?: readonly string[];
}

export interface ProjectObjective {
  readonly objectiveId: string;
  readonly workspaceId: string;
  readonly projectAgentConversationId: string;
  readonly originMessageId: string;
  readonly title: string;
  readonly outcome: string;
  readonly autonomy: ObjectiveAutonomy;
  readonly watches: readonly ObjectiveWatch[];
  readonly status: ObjectiveStatus;
  readonly createdBy: 'user_request' | 'agent_proposal';
  readonly deadline?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WatchSeverity = 'info' | 'notable' | 'urgent';

export interface WatchObservation {
  readonly objectiveId: string;
  readonly watchId: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly severity: WatchSeverity;
  readonly changed: boolean;
}

/** A watch reports upward only when its digest changes. The first observation counts as a change. */
export function diffWatchObservation(
  prev: WatchObservation | null | undefined,
  next: Omit<WatchObservation, 'changed'> & { readonly changed?: boolean },
): WatchObservation {
  const changed = !prev || prev.digest !== next.digest;
  return {
    objectiveId: next.objectiveId,
    watchId: next.watchId,
    observedAt: next.observedAt,
    digest: next.digest,
    summary: next.summary,
    evidenceRefs: next.evidenceRefs,
    severity: next.severity,
    changed,
  };
}
