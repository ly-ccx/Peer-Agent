/** ADR 117: model interpretations are continuity facts, never permissions or task acceptance. */
export type InputDispositionKind = 'discuss' | 'answer' | 'delegate' | 'augment' | 'revise' | 'withdraw';
export interface InputDisposition {
  readonly inputId: string;
  readonly kind: InputDispositionKind;
  readonly reason: string;
}
export interface IntentRequirement {
  readonly requirementId: string;
  readonly text: string;
  readonly sourceInputIds: readonly string[];
}
export interface IntentInterpretation {
  readonly outcome: string;
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly openQuestions: readonly string[];
  readonly requirements: readonly IntentRequirement[];
}
export interface GoalCoverageItem {
  readonly requirementId: string;
  readonly status: 'remaining' | 'covered' | 'uncertain';
  readonly explanation: string;
  readonly sources: readonly {
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly evidenceRefs: readonly string[];
  }[];
}
export type WorkDisposition =
  | { readonly kind: 'continue'; readonly operationRefs: readonly string[] }
  | { readonly kind: 'wait'; readonly waitFor: readonly { readonly kind: 'session' | 'human_request' | 'resource' | 'recovery'; readonly id: string; readonly revision: string }[] }
  | { readonly kind: 'return'; readonly replyRef: string }
  | { readonly kind: 'blocked_system'; readonly code: string; readonly recoveryRef: string }
  | { readonly kind: 'withdraw'; readonly controlRef: string };
export interface IntentAssessment {
  readonly operationId: string;
  readonly workId: string;
  /** Semantic coordination revision, independent of budget writes and journal sequence. */
  readonly expectedWorkRevision: number;
  readonly expectedGoalRevision: number;
  readonly sourceInputIds: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly sourceDecisionRef?: string;
  readonly inputs: readonly InputDisposition[];
  readonly interpretation?: IntentInterpretation;
  readonly coverage: readonly GoalCoverageItem[];
  readonly disposition: WorkDisposition;
  readonly reason: string;
}
export interface IntentCoordination {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly goalRevision: number;
  readonly interpretation: IntentInterpretation;
  readonly inputs: Readonly<Record<string, InputDisposition>>;
  readonly coverage: readonly GoalCoverageItem[];
  readonly decision: IntentAssessment;
  readonly lifecycle: 'active' | 'fulfilled' | 'cancelled';
  readonly updatedAt: string;
  readonly review?: {
    readonly reviewRef: string;
    readonly passed: boolean;
    readonly goalRevision: number;
    readonly intentRevision: number;
    readonly coverageDigest: string;
    readonly sources: readonly { readonly sessionId: string; readonly sourceRevision: string; readonly observationRevision: string }[];
    readonly evidenceRefs: readonly string[];
    readonly at: string;
  };
  readonly closure?: { readonly operationId: string; readonly replyRef?: string; readonly reviewRef?: string; readonly at: string };
}
export interface IntentClosureRequest {
  readonly operationId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly expectedGoalRevision: number;
  readonly lifecycle: 'fulfilled' | 'cancelled';
}
export interface IntentDecisionReceipt {
  readonly operationId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly goalRevision: number;
  readonly at: string;
}
export type IntentCoordinationRequest =
  | { readonly action: 'query'; readonly workId: string }
  | { readonly action: 'assess'; readonly assessment: Omit<IntentAssessment, 'operationId'> };
/** Bounded host projection. Available actions are a snapshot, not grants. */
export interface CoordinationDecisionFrame {
  readonly workId: string;
  readonly workRevision: number;
  readonly goalRevision: number;
  readonly intent: IntentCoordination | null;
  readonly availableActions: readonly { readonly action: string; readonly allowed: boolean; readonly reason?: string }[];
  readonly truncated: boolean;
}
