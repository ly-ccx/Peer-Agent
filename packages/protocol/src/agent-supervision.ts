/** Local coordination facts. These records never grant project capabilities or human approval. */
export type AgentDeliveryIntent = 'mailbox_only' | 'ensure_turn';
export type InterruptionOrigin = 'user' | 'provider' | 'host_handoff' | 'lease_loss' | 'tool' | 'budget' | 'unknown';

export interface AgentDecisionRequest {
  readonly sessionId: string;
  readonly workId: string;
  readonly parentConversationId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly question: string;
  readonly options?: readonly { readonly optionId: string; readonly label: string }[];
  readonly multiple?: boolean;
  readonly allowText: boolean;
  readonly responder: 'parent' | 'user';
  readonly status: 'open' | 'answered' | 'cancelled';
  readonly goalRevision: number;
  readonly answerId?: string;
  readonly userRequestRef?: string;
}

export interface AgentDecisionAnswer {
  /** Host-issued linkage to a current native user answer; never model arguments. */
  readonly sourceInputId?: string;
  readonly userRequestRef?: string;
  readonly requestId: string;
  readonly expectedRequestRevision: number;
  readonly optionIds?: readonly string[];
  readonly text?: string;
}

export interface AgentCommandReceipt {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly goalRevision: number;
  readonly executionEpoch?: string;
  readonly delivery: 'queued' | 'observed';
  readonly admission: 'not_requested' | 'pending' | 'admitted' | 'rejected';
  readonly effect: 'not_requested' | 'pending' | 'applied' | 'unknown' | 'rejected';
  readonly error?: string;
  readonly observedAt?: string;
  readonly attemptRef?: string;
  readonly completionRecorded?: boolean;
}

export interface ContextWindowRecord {
  readonly state: 'prepared';
  readonly windowId: string;
  readonly workId: string;
  readonly conversationId: string;
  readonly previousWindowId?: string;
  readonly historyCursor?: string;
  readonly hint: string;
  readonly obligationRefs: readonly string[];
  readonly budgetRef: string;
  readonly at: string;
}

export interface WorkNoteRevision {
  readonly noteId: string;
  readonly revision: number;
  readonly workId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly at: string;
}

/** Bounded task-detail projection; roster queries do not hydrate the mailbox. */
export interface AgentSupervisionReport {
  readonly recovery?: {
    readonly state: 'settled' | 'waiting_user' | 'waiting_agent' | 'observing' | 'reconciliation_required' | 'user_stopped' | 'legacy_unbound' | 'blocked' | 'repairable';
    readonly blockers: readonly string[];
    readonly nextAction: 'none' | 'native_user_decision' | 'inspect_original_results' | 'current_user_required' | 'adopt_with_current_user'
      | 'inspect_blocker_and_change_method' | 'inspect_current_facts' | 'coordinate_resume' | 'answer_agent_request' | 'observe_current_attempt';
    readonly expectedRevision?: number;
    readonly requestId?: string;
    readonly expectedRequestRevision?: number;
    readonly replayAllowed?: false;
  };
  readonly requests: readonly AgentDecisionRequest[];
  readonly receipts: readonly AgentCommandReceipt[];
}
