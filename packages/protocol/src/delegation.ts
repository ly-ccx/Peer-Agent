/**
 * Project-agent delegation contracts. Pure projections only; nothing here runs a tool.
 * The user-visible conclusion of a work session is projectGoalPlan's conclusion.
 */

import type { ModelSelectionSnapshot } from './model-routing.ts';
import {
  projectGoalPlan,
  type GoalPlanProjectionSnapshot,
  type TaskOverviewItem,
} from './task-overview.ts';

export type WorkSessionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_user'
  | 'verifying'
  | 'result_ready'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type InputSurface = 'desktop' | 'quick_chat' | 'tui' | 'remote';

export interface DelegationOrigin {
  readonly anchorMessageId: string;
  readonly inputId: string;
  readonly surface: InputSurface;
  readonly memorySnapshotId: string;
  readonly objectiveId?: string;
  readonly modelSelection: ModelSelectionSnapshot;
  readonly parentSessionId?: string;
  readonly depth: number;
}

export interface WorkSessionConversationMeta {
  readonly sessionId?: string;
  readonly workspaceId: string;
  readonly spawnedAt?: string;
  readonly origin: DelegationOrigin;
  readonly supersededBy?: string;
  readonly acceptance?: 'auto' | 'confirm';
  readonly accepted?: boolean;
  readonly verifying?: boolean;
  readonly phase?: 'starting' | 'verifying';
}

export interface WorkSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly planId: string | null;
  readonly status: WorkSessionStatus;
  readonly actionRight: TaskOverviewItem['actionRight'];
  readonly nextAction: TaskOverviewItem['nextAction'];
  readonly statusLabel: string;
  readonly needsYouReason?: TaskOverviewItem['needsYouReason'];
  readonly spawnedAt: string;
  readonly origin: DelegationOrigin;
  readonly supersededBy?: string;
}

export interface SessionReport {
  readonly sessionId: string;
  readonly planId: string | null;
  readonly status: WorkSessionStatus;
  readonly summary: string;
  readonly keyFindings: readonly string[];
  readonly changedFiles: readonly { readonly path: string; readonly summary: string }[];
  readonly evidenceRefs: readonly string[];
}

export type DelegationEventKind =
  | 'session_spawned'
  | 'session_progress'
  | 'session_needs_user'
  | 'session_verified'
  | 'session_ended'
  | 'user_intervened'
  | 'objective_signal'
  | 'digest_due';

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface DelegationEvent {
  readonly eventId: string;
  readonly kind: DelegationEventKind;
  readonly sessionId: string;
  readonly at: string;
  readonly payload: JsonValue;
}

export interface AgentReplyMeta {
  readonly replyTo: readonly string[];
  readonly sources: readonly string[];
  readonly verdictRef?: string;
  readonly memoryUsed: readonly string[];
  readonly memoryLearned: readonly string[];
  readonly surfacing: 'interrupt' | 'message' | 'digest' | 'silent';
}

export type MessageDisposition =
  | { readonly kind: 'answered'; readonly messageId: string; readonly replyMessageIds: readonly string[] }
  | { readonly kind: 'merged'; readonly messageId: string; readonly sessionId: string }
  | { readonly kind: 'stopped'; readonly messageId: string; readonly sessionIds: readonly string[]; readonly reason: string }
  | { readonly kind: 'superseded'; readonly messageId: string; readonly oldSessionId: string; readonly newSessionId: string; readonly reason: string }
  | { readonly kind: 'parallel'; readonly messageId: string; readonly sessionIds: readonly string[] }
  | { readonly kind: 'queued'; readonly messageId: string; readonly sessionId: string; readonly dependsOn: readonly string[] }
  | { readonly kind: 'out_of_scope'; readonly messageId: string; readonly sessionId: string };

export interface DispositionMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly replyTo?: readonly string[];
  readonly quoteSessionIds?: readonly string[];
}

export interface DispositionEvent {
  readonly kind: 'spawn' | 'merge' | 'stop' | 'supersede' | 'parallel' | 'queue';
  readonly anchorMessageId: string;
  readonly sessionId?: string;
  readonly sessionIds?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly reason?: string;
  readonly oldSessionId?: string;
  readonly newSessionId?: string;
  readonly replyMessageId?: string;
}

export type VerificationOutcome = 'passed' | 'failed' | 'partial' | 'unverifiable';

export type IndependentVerifierState = 'passed' | 'failed' | 'not_required' | 'missing';

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly reason?: string;
}

export interface VerificationVerdict {
  readonly outcome: VerificationOutcome;
  readonly independentVerifier: IndependentVerifierState;
  readonly verifierModel?: string;
  readonly sameFamilyAsWorker?: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly evidenceRefs: readonly string[];
}

export type AcceptancePolicy = 'auto' | 'confirm';

export type AcceptanceReason =
  | 'verdict_not_passed'
  | 'manual_criteria_pending'
  | 'external_side_effects'
  | 'destructive_operation'
  | 'out_of_scope_write'
  | 'project_requires_confirm'
  | 'user_requested_review'
  | 'verification_below_floor';

export interface AcceptanceDecision {
  readonly mode: AcceptancePolicy;
  readonly acceptedBy?: 'policy' | 'user';
  readonly reasons: readonly AcceptanceReason[];
}

export interface AcceptanceSessionFacts {
  readonly manualCriteriaPending?: boolean;
  readonly externalSideEffects?: boolean;
  readonly destructiveOperation?: boolean;
  readonly outOfScopeWrite?: boolean;
  readonly userRequestedReview?: boolean;
  readonly verificationBelowFloor?: boolean;
  /** The agent has already posted the reply that explains this result. */
  readonly reported?: boolean;
  /** Acceptance close gate. Policy acceptance does not proceed when this is false. */
  readonly closeGatePassed?: boolean;
}

export type Surfacing = 'interrupt' | 'message' | 'digest' | 'silent';

export interface SurfacingDecision {
  readonly decision: Surfacing;
  readonly reason: string;
}

export interface SurfacingEvent {
  readonly origin: 'user_request' | 'objective_signal' | 'agent_idea';
  readonly kind: 'needs_user' | 'confirm' | 'failure_needs_decision' | 'result' | 'observation' | 'idea' | 'objective_risk';
  readonly novelty: boolean;
  readonly severity: 'info' | 'notable' | 'urgent';
  readonly deadlineImminent?: boolean;
}

export interface ProjectInput {
  readonly inputId: string;
  readonly workspaceId: string;
  readonly surface: InputSurface;
  readonly text: string;
  readonly anchorRefs: readonly string[];
  readonly quoteRefs: readonly string[];
  readonly attachmentRefs: readonly string[];
  readonly createdAt: string;
}

export type PendingApprovalState = 'open' | 'approved' | 'denied' | 'expired' | 'stale';

export interface PendingApproval {
  readonly approvalId: string;
  readonly workspaceId: string | null;
  readonly sessionId?: string | null;
  readonly conversationId?: string | null;
  readonly planId: string | null;
  readonly toolCallId?: string;
  readonly streamId: string;
  readonly capabilityId: string;
  readonly summary: string;
  readonly riskLevel: string;
  readonly argsDigest: string;
  readonly createdAt: string;
  readonly state: PendingApprovalState;
  readonly decidedAt?: string;
  readonly decidedBy?: 'local_ui' | 'policy';
}

export interface HostLease {
  readonly hostId: string;
  readonly surface: 'desktop' | 'tui';
  readonly pid: number;
  readonly appVersion: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key] ?? null)}`).join(',')}}`;
}

export function delegationEventId(input: {
  readonly kind: DelegationEventKind;
  readonly sessionId: string;
  readonly at: string;
  readonly payload: JsonValue;
}): string {
  const body = stableStringify({
    at: input.at,
    kind: input.kind,
    payload: input.payload,
    sessionId: input.sessionId,
  });
  const high = fnv1a(body).toString(16).padStart(8, '0');
  const low = fnv1a(`#${body}`).toString(16).padStart(8, '0');
  return `${high}${low}`;
}

export function createDelegationEvent(input: {
  readonly kind: DelegationEventKind;
  readonly sessionId: string;
  readonly at: string;
  readonly payload?: JsonValue;
}): DelegationEvent {
  const payload = input.payload ?? null;
  return {
    eventId: delegationEventId({ ...input, payload }),
    kind: input.kind,
    sessionId: input.sessionId,
    at: input.at,
    payload,
  };
}

function delegationStatus(
  snapshot: GoalPlanProjectionSnapshot,
  meta: WorkSessionConversationMeta,
  projected: TaskOverviewItem,
): WorkSessionStatus {
  if (meta.supersededBy) return 'superseded';
  if (snapshot.status === 'failed') return 'failed';
  if (snapshot.status === 'cancelled') return 'cancelled';
  if (snapshot.status === 'completed') {
    if (meta.verifying || meta.phase === 'verifying') return 'verifying';
    if (meta.acceptance === 'confirm' && meta.accepted !== true) return 'result_ready';
    return 'accepted';
  }
  if (projected.actionRight === 'needs_you') return 'waiting_user';
  if (snapshot.runnerStatus === 'exploring' || meta.phase === 'verifying') return 'verifying';
  if (meta.phase === 'starting') return 'starting';
  if (
    snapshot.status === 'approved'
    || snapshot.status === 'accepted'
    || snapshot.status === 'paused'
    || snapshot.status === 'interrupted'
    || projected.actionRight === 'paused'
  ) {
    return 'queued';
  }
  return 'running';
}

/**
 * Project a GoalPlan snapshot into a work session.
 * actionRight / nextAction / statusLabel come from projectGoalPlan, so the two projections cannot disagree.
 * A paused plan has no delegation status of its own; it is queued, and the visible conclusion stays paused.
 */
export function projectWorkSession(
  plan: GoalPlanProjectionSnapshot,
  conversationMeta: WorkSessionConversationMeta,
): WorkSession {
  const projected = projectGoalPlan(plan);
  return {
    sessionId: conversationMeta.sessionId ?? plan.conversationId ?? plan.planId,
    workspaceId: conversationMeta.workspaceId,
    title: plan.title,
    planId: plan.planId,
    status: delegationStatus(plan, conversationMeta, projected),
    actionRight: projected.actionRight,
    nextAction: projected.nextAction,
    statusLabel: projected.statusLabel,
    ...(projected.needsYouReason ? { needsYouReason: projected.needsYouReason } : {}),
    spawnedAt: conversationMeta.spawnedAt ?? plan.updatedAt ?? '',
    origin: conversationMeta.origin,
    ...(conversationMeta.supersededBy ? { supersededBy: conversationMeta.supersededBy } : {}),
  };
}

function eventOutOfScope(message: DispositionMessage, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const quoted = message.quoteSessionIds;
  if (!quoted || quoted.length === 0) return false;
  return !quoted.includes(sessionId);
}

function dispositionFor(message: DispositionMessage, event: DispositionEvent): MessageDisposition {
  const sessionId = event.sessionId ?? event.sessionIds?.[0] ?? '';
  if (eventOutOfScope(message, sessionId) || (event.sessionIds ?? []).some((id) => eventOutOfScope(message, id))) {
    return { kind: 'out_of_scope', messageId: message.id, sessionId };
  }
  switch (event.kind) {
    case 'merge':
      return { kind: 'merged', messageId: message.id, sessionId };
    case 'stop':
      return {
        kind: 'stopped',
        messageId: message.id,
        sessionIds: event.sessionIds ?? (sessionId ? [sessionId] : []),
        reason: event.reason ?? '',
      };
    case 'supersede':
      return {
        kind: 'superseded',
        messageId: message.id,
        oldSessionId: event.oldSessionId ?? '',
        newSessionId: event.newSessionId ?? sessionId,
        reason: event.reason ?? '',
      };
    case 'parallel':
      return { kind: 'parallel', messageId: message.id, sessionIds: event.sessionIds ?? (sessionId ? [sessionId] : []) };
    case 'queue':
      return { kind: 'queued', messageId: message.id, sessionId, dependsOn: event.dependsOn ?? [] };
    default:
      return { kind: 'parallel', messageId: message.id, sessionIds: event.sessionIds ?? (sessionId ? [sessionId] : []) };
  }
}

/**
 * Dispositions are a projection of anchor events plus replies.
 * The assistant text answers the last user message in the turn unless replyTo says otherwise.
 * A quote limits message/cancel/supersede to those sessions; anything else is out_of_scope.
 */
export function projectMessageDispositions(
  messages: readonly DispositionMessage[],
  events: readonly DispositionEvent[],
): MessageDisposition[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const dispositions: MessageDisposition[] = [];
  for (const event of events) {
    const message = byId.get(event.anchorMessageId);
    if (!message || message.role !== 'user') continue;
    dispositions.push(dispositionFor(message, event));
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const targets = message.replyTo && message.replyTo.length > 0
      ? message.replyTo
      : previousUserId(messages, index);
    for (const messageId of targets) {
      dispositions.push({
        kind: 'answered',
        messageId,
        replyMessageIds: [message.id],
      });
    }
  }
  return dispositions;
}

function previousUserId(messages: readonly DispositionMessage[], assistantIndex: number): readonly string[] {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return [message.id];
    if (message?.role === 'assistant') break;
  }
  return [];
}

const ATTENTION_KINDS = new Set<SurfacingEvent['kind']>([
  'needs_user',
  'confirm',
  'failure_needs_decision',
  'objective_risk',
]);

function agentOrigin(origin: SurfacingEvent['origin']): boolean {
  return origin === 'agent_idea' || origin === 'objective_signal';
}

/**
 * Surfacing table from the delegation runtime, top to bottom.
 * foreground does not change the row. needsYou uses the same row as needs_user.
 */
export function decideSurfacing(input: {
  readonly event: SurfacingEvent;
  readonly proactivity: 'off' | 'low' | 'normal' | 'high';
  readonly foreground: boolean;
  readonly quietHours: boolean;
  readonly needsYou: boolean;
}): SurfacingDecision {
  void input.foreground;
  const { event, proactivity, quietHours, needsYou } = input;
  if (needsYou || ATTENTION_KINDS.has(event.kind)) {
    const staysInterrupt = event.kind === 'objective_risk' && event.deadlineImminent === true;
    if (quietHours && !staysInterrupt) return { decision: 'message', reason: 'quiet_hours' };
    return { decision: 'interrupt', reason: needsYou && !ATTENTION_KINDS.has(event.kind) ? 'needs_you' : 'attention' };
  }
  if (event.origin === 'user_request' && event.kind === 'result') {
    if (proactivity === 'normal' || proactivity === 'high') {
      return { decision: 'interrupt', reason: 'user_result' };
    }
    return { decision: 'message', reason: 'user_result' };
  }
  if (agentOrigin(event.origin) && event.novelty === false) {
    return { decision: 'silent', reason: 'not_novel' };
  }
  if (agentOrigin(event.origin) && event.severity === 'urgent') {
    return { decision: 'interrupt', reason: 'agent_urgent' };
  }
  if (agentOrigin(event.origin) && event.severity === 'notable') {
    const decision: Surfacing = proactivity === 'high'
      ? 'interrupt'
      : proactivity === 'normal'
        ? 'message'
        : 'digest';
    return { decision, reason: 'agent_notable' };
  }
  if (agentOrigin(event.origin) && (event.severity === 'info' || event.kind === 'idea')) {
    const decision: Surfacing = proactivity === 'high'
      ? 'message'
      : proactivity === 'off'
        ? 'silent'
        : 'digest';
    return { decision, reason: 'agent_info' };
  }
  return { decision: 'message', reason: 'default' };
}

const CONFIRM_REASON_ORDER: readonly AcceptanceReason[] = [
  'verdict_not_passed',
  'manual_criteria_pending',
  'external_side_effects',
  'destructive_operation',
  'out_of_scope_write',
  'project_requires_confirm',
  'user_requested_review',
  'verification_below_floor',
];

/**
 * Policy acceptance ignores userOverride. It also requires a posted reply and a passed close gate.
 * A user override can record acceptedBy user on a confirm decision; it cannot mint a policy acceptance.
 */
export function decideAcceptance(input: {
  readonly verdict: VerificationVerdict;
  readonly policy: AcceptancePolicy;
  readonly session: AcceptanceSessionFacts;
  readonly userOverride?: { readonly accept: boolean } | null;
}): AcceptanceDecision {
  const reasons: AcceptanceReason[] = [];
  if (input.verdict.outcome !== 'passed') reasons.push('verdict_not_passed');
  if (input.session.manualCriteriaPending === true) reasons.push('manual_criteria_pending');
  if (input.session.externalSideEffects === true) reasons.push('external_side_effects');
  if (input.session.destructiveOperation === true) reasons.push('destructive_operation');
  if (input.session.outOfScopeWrite === true) reasons.push('out_of_scope_write');
  if (input.policy === 'confirm') reasons.push('project_requires_confirm');
  if (input.session.userRequestedReview === true) reasons.push('user_requested_review');
  if (input.session.verificationBelowFloor === true) reasons.push('verification_below_floor');
  const ordered = CONFIRM_REASON_ORDER.filter((reason) => reasons.includes(reason));
  const closeGatePassed = input.session.closeGatePassed === true;
  if (ordered.length === 0 && input.policy === 'auto' && input.session.reported === true && closeGatePassed) {
    return { mode: 'auto', acceptedBy: 'policy', reasons: [] };
  }
  if (ordered.length > 0 && input.userOverride?.accept === true && closeGatePassed) {
    return { mode: 'confirm', acceptedBy: 'user', reasons: ordered };
  }
  return { mode: ordered.length > 0 ? 'confirm' : 'auto', reasons: ordered };
}
