/** Coordination authority is issued by the local host, never by model arguments. */
export type CoordinationAction = 'parallel' | 'augment' | 'revise' | 'query' | 'answer' | 'cancel' | 'replace' | 'handoff';
export type CoordinationLifecycle = 'active' | 'paused' | 'cancelled' | 'fulfilled';
export interface CoordinationMandate {
  schemaVersion: 1;
  mandateId: string;
  workId: string;
  workspaceId: string;
  parentConversationId: string;
  rootInputIds: string[];
  revisionInputIds: string[];
  goalRevision: number;
  allowedActions: CoordinationAction[];
  sessionIds: string[];
  executionBindings?: Record<string, CoordinationExecutionBinding>;
  materialRefs: string[];
  policyRevision: string;
  lifecycle: CoordinationLifecycle;
}
/** Semantic routing is the model's decision; identity, authority and versions are host facts. */
export interface CoordinationDecision {
  operationId: string;
  workId: string;
  expectedRevision: number;
  action: CoordinationAction;
  sourceInputIds: string[];
  sourceEventIds: string[];
  sessionId?: string;
  reason: string;
}
export type TaskTransitionPhase = 'recorded' | 'stopping' | 'awaiting_outcome' | 'ready' | 'started' | 'completed' | 'blocked';
export interface TaskTransition {
  schemaVersion: 1;
  operationId: string;
  workId: string;
  mandateId: string;
  expectedGoalRevision: number;
  sourceInputIds: string[];
  sourceEventIds: string[];
  initiator: 'project_agent';
  decisionSource: 'user_revision' | 'execution_repair';
  action: CoordinationAction;
  reason: string;
  oldSessionId?: string;
  replacementSessionId?: string;
  executionEpoch: string;
  phase: TaskTransitionPhase;
  minimumExecutorVersion: 1;
  updatedAt: string;
}
export interface CoordinationExecutionBinding {
  sessionId?: string;
  workId: string;
  goalRevision: number;
  executionEpoch: string;
}
