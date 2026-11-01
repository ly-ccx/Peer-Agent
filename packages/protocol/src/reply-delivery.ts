/** The old delivered aggregate still requires both canonical commit and host settlement. */
export interface ReplyDeliveryReceipt {
  readonly state: 'prepared' | 'delivered' | 'invalidated' | 'deferred' | 'aggregated';
  readonly heldAt?: string;
  readonly deliveredBy?: string;
  readonly canonicalCommittedAt?: string;
  readonly settlement?: {
    readonly operationId: string;
    readonly status: 'pending' | 'failed' | 'applied';
    readonly attempts: number;
    readonly updatedAt: string;
    readonly phase?: 'commit' | 'settlement';
    readonly error?: string;
    readonly retryAt?: string;
  };
}
/** Derived locally from current assessments, never accepted from assistant reply metadata. */
export interface IntentReplyBinding {
  readonly workId: string;
  readonly goalRevision: number;
  readonly intentRevision: number;
  readonly decisionRef: string;
  readonly replyRef: string;
}
export interface ReplyGoalScope {
  readonly workId: string;
  readonly goalRevision: number;
}
