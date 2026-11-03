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
  /** Host-reserved reply reference; local bindings resolve the actual canonical message or digest. */
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
  readonly decisionTurnId?: string;
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
  readonly closure?: { readonly operationId: string; readonly replyRef?: string; readonly replyRefs?: readonly string[]; readonly intentReplyRef?: string; readonly reviewRef?: string; readonly at: string };
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
  readonly turnId?: string;
  readonly continuation?: boolean;
}
export type IntentCoordinationRequest =
  | { readonly action: 'query'; readonly workId: string; readonly expectedRevision?: number; readonly expectedWorkRevision?: number;
    readonly afterSessionId?: string; readonly afterInputId?: string; readonly inputId?: string; readonly eventId?: string; readonly payloadOffset?: number }
  | { readonly action: 'assess'; readonly assessment: Omit<IntentAssessment, 'operationId'> };
/** Bounded host projection. Available actions are a snapshot, not grants. */
export interface CoordinationDecisionFrame {
  readonly resourceWaits?: readonly import('./runtime-session-facts.ts').ResourceWaitFact[];
  readonly resourceWaitError?: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly goalRevision: number;
  readonly sourceInputIds: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly sourceDecisionRef?: string;
  readonly intent: {
    readonly lifecycle: IntentCoordination['lifecycle'];
    readonly outcome: string;
    readonly constraints: readonly string[];
    readonly nonGoals: readonly string[];
    readonly openQuestions: readonly string[];
    readonly openQuestionCount: number;
    readonly remainingRequirementCount: number;
    readonly inputDispositions: readonly InputDisposition[];
    readonly requirements: readonly (IntentRequirement & { readonly status: GoalCoverageItem['status'] })[];
    readonly disposition: WorkDisposition['kind'];
    readonly review?: { readonly reviewRef: string; readonly passed: boolean; readonly current: boolean; readonly goalRevision: number } | null;
  } | null;
  readonly sessions: readonly { readonly sessionId: string; readonly title: string; readonly status: string; readonly sourceRevision?: string; readonly observationRevision?: string; readonly humanGate: boolean }[];
  readonly events: readonly { readonly eventId: string; readonly kind: string; readonly sessionId?: string; readonly payload: Readonly<Record<string, unknown>> }[];
  readonly questions: readonly Readonly<Record<string, unknown>>[];
  readonly operations: readonly Readonly<Record<string, unknown>>[];
  readonly unknownEffects: readonly Readonly<Record<string, unknown>>[];
  readonly controls: Readonly<Record<string, unknown>>;
  readonly omitted: Readonly<Record<string, number | boolean>>;
  readonly retrieval: { readonly tool: 'coordinate_work'; readonly action: 'query'; readonly workId: string; readonly expectedRevision: number; readonly afterSessionId?: string };
  readonly availableActions: readonly { readonly action: string; readonly allowed: boolean; readonly reason?: string }[];
  readonly truncated: boolean;
}
export interface ProgressObservation {
  readonly kind: 'observed' | 'admitted' | 'advanced';
  readonly fingerprint: string;
  readonly failure: boolean;
  /** Host-normalized facts; this record is neither Evidence nor an execution/permission receipt. */
  readonly fact: Readonly<Record<string, unknown>>;
}
