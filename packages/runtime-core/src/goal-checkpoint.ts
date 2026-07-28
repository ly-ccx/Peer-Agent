/**
 * Goal execution checkpoint pure helpers.
 *
 * Checkpoint is the authoritative "what happens next" cursor across compaction.
 * Chat summary may explain; it must not replace these structured fields.
 *
 * See peer-knowledge/knowledge/architecture/24-goal-runner-context-checkpoint-and-seamless-resume.md
 */
import { randomId, sha256Hex } from './iso-crypto.ts';

export const GOAL_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export const GOAL_CHECKPOINT_STATUSES = Object.freeze([
  'preparing',
  'committed',
  'consumed',
  'superseded',
  'invalid',
] as const);

export const GOAL_CHECKPOINT_REASONS = Object.freeze([
  'soft_threshold',
  'hard_threshold',
  'provider_overflow',
  'task_boundary',
  'manual_compact',
  'process_recovery',
] as const);

export const GOAL_RESUME_POLICIES = Object.freeze([
  'continue_same_turn',
  'start_recovery_turn',
  'verify_then_continue',
  'wait_for_user',
] as const);

export const GOAL_CHECKPOINT_LIMITS: {
  readonly maxRecentActions: number;
  readonly maxDecisions: number;
  readonly maxBlockers: number;
  readonly maxRisks: number;
  readonly maxOpenQuestions: number;
  readonly maxPendingVerifications: number;
  readonly maxDoNotRepeat: number;
  readonly maxEvidenceRefs: number;
  readonly maxOpenToolCalls: number;
  readonly maxTextChars: number;
  readonly maxHandoffChars: number;
  readonly maxInstructionChars: number;
} = Object.freeze({
  maxRecentActions: 12,
  maxDecisions: 12,
  maxBlockers: 10,
  maxRisks: 10,
  maxOpenQuestions: 10,
  maxPendingVerifications: 10,
  maxDoNotRepeat: 10,
  maxEvidenceRefs: 100,
  maxOpenToolCalls: 20,
  maxTextChars: 2_000,
  maxHandoffChars: 4_000,
  maxInstructionChars: 2_000,
});

type CheckpointStatus = (typeof GOAL_CHECKPOINT_STATUSES)[number];
type CheckpointReason = (typeof GOAL_CHECKPOINT_REASONS)[number];
type ResumePolicy = (typeof GOAL_RESUME_POLICIES)[number];

function asString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function clampText(value: unknown, maxChars: number, fallback = ''): string {
  const text = asString(value, fallback);
  if (!text) return fallback;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueStrings(values: readonly unknown[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = asString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeStringList(value: unknown, max: number, itemMax = GOAL_CHECKPOINT_LIMITS.maxTextChars): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.map((item) => clampText(item, itemMax)),
    max,
  );
}

function normalizeProgress(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const total = Number.isFinite(source.total) ? Math.max(0, Math.trunc(Number(source.total))) : 0;
  const completed = Number.isFinite(source.completed) ? Math.max(0, Math.trunc(Number(source.completed))) : 0;
  const failed = Number.isFinite(source.failed) ? Math.max(0, Math.trunc(Number(source.failed))) : 0;
  const blocked = Number.isFinite(source.blocked) ? Math.max(0, Math.trunc(Number(source.blocked))) : 0;
  const percent = Number.isFinite(source.percent)
    ? Math.max(0, Math.min(100, Math.trunc(Number(source.percent))))
    : (total > 0 ? Math.round((completed / total) * 100) : 0);
  const nextRunnableTaskIds = normalizeStringList(source.nextRunnableTaskIds, 32, 200);
  return { total, completed, failed, blocked, percent, nextRunnableTaskIds };
}

function normalizeAction(value: unknown, index: number) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const summary = clampText(source.summary, GOAL_CHECKPOINT_LIMITS.maxTextChars);
  if (!summary) return null;
  const kind = asString(source.kind, 'tool');
  const status = asString(source.status, 'unknown');
  return {
    actionId: asString(source.actionId, `action-${index + 1}`),
    kind: (
      kind === 'inspect'
      || kind === 'edit'
      || kind === 'write'
      || kind === 'tool'
      || kind === 'test'
      || kind === 'verify'
      || kind === 'decision'
    ) ? kind : 'tool',
    summary,
    status: (
      status === 'completed'
      || status === 'failed'
      || status === 'running'
      || status === 'unknown'
    ) ? status : 'unknown',
    ...(asString(source.target) ? { target: clampText(source.target, 500) } : {}),
    evidenceRefs: normalizeStringList(source.evidenceRefs, 20, 300),
    ...(asString(source.result) ? { result: clampText(source.result, GOAL_CHECKPOINT_LIMITS.maxTextChars) } : {}),
    ...(asString(source.occurredAt) ? { occurredAt: asString(source.occurredAt) } : {}),
  };
}

function normalizeToolCall(value: unknown, index: number) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const toolCallId = asString(source.toolCallId, `tool-call-${index + 1}`);
  if (!toolCallId) return null;
  const status = asString(source.status, 'unknown');
  const replayPolicy = asString(source.replayPolicy, 'query_status');
  return {
    toolCallId,
    ...(asString(source.toolName) ? { toolName: clampText(source.toolName, 200) } : {}),
    status: (
      status === 'requested'
      || status === 'running'
      || status === 'completed'
      || status === 'failed'
      || status === 'unknown'
    ) ? status : 'unknown',
    resultEvidenceRefs: normalizeStringList(source.resultEvidenceRefs, 20, 300),
    replayPolicy: (
      replayPolicy === 'never'
      || replayPolicy === 'query_status'
      || replayPolicy === 'safe_retry'
      || replayPolicy === 'ask_user'
    ) ? replayPolicy : 'query_status',
    ...(asString(source.idempotencyKey) ? { idempotencyKey: clampText(source.idempotencyKey, 200) } : {}),
  };
}

function normalizeFirstAction(value: unknown, fallbackTaskId = '') {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = asString(source.kind, 'inspect');
  const instruction = clampText(
    source.instruction,
    GOAL_CHECKPOINT_LIMITS.maxInstructionChars,
    fallbackTaskId
      ? `Continue the current task (${fallbackTaskId}) from the checkpoint.`
      : 'Continue the current goal from the checkpoint.',
  );
  const successCheck = clampText(
    source.successCheck,
    GOAL_CHECKPOINT_LIMITS.maxTextChars,
    'Observable progress is written back through goal_update_task with evidenceRefs.',
  );
  return {
    kind: (
      kind === 'tool'
      || kind === 'inspect'
      || kind === 'edit'
      || kind === 'verify'
      || kind === 'synthesize'
      || kind === 'wait_user'
    ) ? kind : 'inspect',
    instruction,
    ...(asString(source.target) ? { target: clampText(source.target, 500) } : {}),
    successCheck,
    requiredEvidenceRefs: normalizeStringList(source.requiredEvidenceRefs, 20, 300),
    ...(Array.isArray(source.forbiddenUntilComplete)
      ? { forbiddenUntilComplete: normalizeStringList(source.forbiddenUntilComplete, 20, 300) }
      : {}),
  };
}

function normalizeBudget(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const num = (key: string, fallback = 0) => (
    Number.isFinite(source[key]) ? Math.max(0, Math.trunc(Number(source[key]))) : fallback
  );
  const contextWindow = Number.isFinite(source.contextWindow)
    ? Math.max(0, Math.trunc(Number(source.contextWindow)))
    : null;
  return {
    contextWindow,
    beforeTokens: num('beforeTokens'),
    targetTokens: num('targetTokens'),
    systemTokens: num('systemTokens'),
    toolsTokens: num('toolsTokens'),
    checkpointTokens: num('checkpointTokens'),
    continuityTokens: num('continuityTokens'),
    recentTailTokens: num('recentTailTokens'),
    keepBudgetTokens: num('keepBudgetTokens'),
    compactionCount: num('compactionCount'),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * Digest excludes lifecycle fields so content identity stays stable across
 * preparing → committed → consumed transitions.
 */
export function computeGoalCheckpointDigest(checkpoint: Record<string, unknown>): string {
  const {
    status: _status,
    committedAt: _committedAt,
    consumedAt: _consumedAt,
    digest: _digest,
    ...content
  } = checkpoint;
  return sha256Hex(stableStringify(content));
}

export function isGoalCheckpointStatus(value: unknown): value is CheckpointStatus {
  return typeof value === 'string' && (GOAL_CHECKPOINT_STATUSES as readonly string[]).includes(value);
}

export function isGoalCheckpointReason(value: unknown): value is CheckpointReason {
  return typeof value === 'string' && (GOAL_CHECKPOINT_REASONS as readonly string[]).includes(value);
}

export function isGoalResumePolicy(value: unknown): value is ResumePolicy {
  return typeof value === 'string' && (GOAL_RESUME_POLICIES as readonly string[]).includes(value);
}

export function createGoalCheckpointIds(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return {
    checkpointId: `cp-${stamp}-${randomId().slice(0, 8)}`,
    compactionId: `compact-${stamp}-${randomId().slice(0, 8)}`,
  };
}

export function normalizeGoalCheckpoint(input: unknown, options: {
  readonly fallbackPlanId?: string;
  readonly fallbackRunId?: string;
  readonly fallbackPlanVersion?: number;
  readonly now?: string;
} = {}) {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const now = asString(options.now, new Date().toISOString());
  const ids = createGoalCheckpointIds(new Date(now));
  const planId = asString(source.planId, asString(options.fallbackPlanId));
  const runId = asString(source.runId, asString(options.fallbackRunId));
  if (!planId || !runId) {
    throw new Error('[goal-checkpoint] planId and runId are required');
  }

  const currentTaskId = asString(source.currentTaskId) || undefined;
  const status = isGoalCheckpointStatus(source.status) ? source.status : 'preparing';
  const reason = isGoalCheckpointReason(source.reason) ? source.reason : 'soft_threshold';
  const resumePolicy = isGoalResumePolicy(source.resumePolicy)
    ? source.resumePolicy
    : 'start_recovery_turn';

  const recentActions = (Array.isArray(source.recentActions) ? source.recentActions : [])
    .map((item, index) => normalizeAction(item, index))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, GOAL_CHECKPOINT_LIMITS.maxRecentActions);

  const openToolCalls = (Array.isArray(source.openToolCalls) ? source.openToolCalls : [])
    .map((item, index) => normalizeToolCall(item, index))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, GOAL_CHECKPOINT_LIMITS.maxOpenToolCalls);

  const normalized = {
    schemaVersion: GOAL_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: asString(source.checkpointId, ids.checkpointId),
    compactionId: asString(source.compactionId, ids.compactionId),
    sequence: Number.isFinite(source.sequence) ? Math.max(1, Math.trunc(Number(source.sequence))) : 1,
    status,
    reason,
    planId,
    planVersion: Number.isFinite(source.planVersion)
      ? Math.max(0, Math.trunc(Number(source.planVersion)))
      : Math.max(0, Math.trunc(Number(options.fallbackPlanVersion ?? 0))),
    runId,
    ...(asString(source.conversationId) ? { conversationId: asString(source.conversationId) } : {}),
    ...(asString(source.streamId) ? { streamId: asString(source.streamId) } : {}),
    ...(asString(source.contextEpochId) ? { contextEpochId: asString(source.contextEpochId) } : {}),
    ...(asString(source.conversationRevision) ? { conversationRevision: asString(source.conversationRevision) } : {}),
    ...(currentTaskId ? { currentTaskId } : {}),
    ...(asString(source.runnerPhase) ? { runnerPhase: asString(source.runnerPhase) } : {}),
    ...(asString(source.runnerIntent) ? { runnerIntent: asString(source.runnerIntent) } : {}),
    progress: normalizeProgress(source.progress),
    objectiveNow: clampText(source.objectiveNow, GOAL_CHECKPOINT_LIMITS.maxTextChars, 'Continue the active goal.'),
    currentWork: clampText(source.currentWork, GOAL_CHECKPOINT_LIMITS.maxTextChars, 'Resume from the latest executable scene.'),
    recentActions,
    completedSincePrevious: normalizeStringList(source.completedSincePrevious, 20),
    mostImportantFact: clampText(
      source.mostImportantFact,
      GOAL_CHECKPOINT_LIMITS.maxTextChars,
      currentTaskId
        ? `Current task is ${currentTaskId}.`
        : 'Continue the active goal from the latest checkpoint.',
    ),
    decisions: normalizeStringList(source.decisions, GOAL_CHECKPOINT_LIMITS.maxDecisions),
    blockers: normalizeStringList(source.blockers, GOAL_CHECKPOINT_LIMITS.maxBlockers),
    risks: normalizeStringList(source.risks, GOAL_CHECKPOINT_LIMITS.maxRisks),
    openQuestions: normalizeStringList(source.openQuestions, GOAL_CHECKPOINT_LIMITS.maxOpenQuestions),
    pendingVerifications: normalizeStringList(
      source.pendingVerifications,
      GOAL_CHECKPOINT_LIMITS.maxPendingVerifications,
    ),
    doNotRepeat: normalizeStringList(source.doNotRepeat, GOAL_CHECKPOINT_LIMITS.maxDoNotRepeat),
    handoffNote: clampText(
      source.handoffNote,
      GOAL_CHECKPOINT_LIMITS.maxHandoffChars,
      'Resume the current task. Do not restart completed work.',
    ),
    firstAction: normalizeFirstAction(source.firstAction, currentTaskId || ''),
    evidenceRefs: normalizeStringList(source.evidenceRefs, GOAL_CHECKPOINT_LIMITS.maxEvidenceRefs, 300),
    mustReadEvidenceRefs: normalizeStringList(
      source.mustReadEvidenceRefs,
      Math.min(20, GOAL_CHECKPOINT_LIMITS.maxEvidenceRefs),
      300,
    ),
    openToolCalls,
    budget: normalizeBudget(source.budget),
    resumePolicy,
    createdAt: asString(source.createdAt, now),
    ...(asString(source.committedAt) ? { committedAt: asString(source.committedAt) } : {}),
    ...(asString(source.consumedAt) ? { consumedAt: asString(source.consumedAt) } : {}),
  };

  return {
    ...normalized,
    digest: computeGoalCheckpointDigest(normalized as unknown as Record<string, unknown>),
  };
}

export function validateGoalCheckpoint(checkpoint: unknown): {
  readonly ok: boolean;
  readonly errors: string[];
  readonly checkpoint: ReturnType<typeof normalizeGoalCheckpoint> | null;
} {
  try {
    const normalized = normalizeGoalCheckpoint(checkpoint);
    const errors: string[] = [];
    if (!normalized.checkpointId) errors.push('checkpointId is required');
    if (!normalized.planId) errors.push('planId is required');
    if (!normalized.runId) errors.push('runId is required');
    if (!normalized.firstAction?.instruction) errors.push('firstAction.instruction is required');
    if (!normalized.firstAction?.successCheck) errors.push('firstAction.successCheck is required');
    if (!normalized.mostImportantFact) errors.push('mostImportantFact is required');
    if (normalized.digest !== computeGoalCheckpointDigest(normalized as unknown as Record<string, unknown>)) {
      errors.push('digest mismatch');
    }
    return {
      ok: errors.length === 0,
      errors,
      checkpoint: errors.length === 0 ? normalized : null,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      checkpoint: null,
    };
  }
}

function collectLeafTasks(tasks: unknown, out: Array<Record<string, unknown>> = []) {
  if (!Array.isArray(tasks)) return out;
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const record = task as Record<string, unknown>;
    const subtasks = Array.isArray(record.subtasks) ? record.subtasks : [];
    if (subtasks.length === 0) out.push(record);
    else collectLeafTasks(subtasks, out);
  }
  return out;
}

function deriveProgressFromPlan(plan: Record<string, unknown>) {
  const leaves = collectLeafTasks(plan.tasks);
  const total = leaves.length;
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  const nextRunnableTaskIds: string[] = [];
  for (const leaf of leaves) {
    const status = asString(leaf.status, 'pending');
    if (status === 'completed') completed += 1;
    else if (status === 'failed') failed += 1;
    else if (status === 'waiting_user' || status === 'blocked') blocked += 1;
    else if (status === 'pending' || status === 'running') {
      const taskId = asString(leaf.taskId);
      if (taskId) nextRunnableTaskIds.push(taskId);
    }
  }
  return {
    total,
    completed,
    failed,
    blocked,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    nextRunnableTaskIds: nextRunnableTaskIds.slice(0, 32),
  };
}

function findTaskTitle(plan: Record<string, unknown>, taskId: string | undefined) {
  if (!taskId) return '';
  const leaves = collectLeafTasks(plan.tasks);
  const hit = leaves.find((task) => asString(task.taskId) === taskId);
  return hit ? asString(hit.title) : '';
}

/**
 * Deterministic checkpoint builder used when no LLM handoff is available.
 * Callers may overlay narrative fields before normalizeGoalCheckpoint().
 */
export function buildDeterministicGoalCheckpoint(input: {
  readonly plan: Record<string, unknown>;
  readonly reason?: unknown;
  readonly runId?: string;
  readonly sequence?: number;
  readonly checkpointId?: string;
  readonly compactionId?: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly openToolCalls?: readonly unknown[];
  readonly recentActions?: readonly unknown[];
  readonly budget?: unknown;
  readonly now?: string;
}) {
  const plan = input.plan && typeof input.plan === 'object' ? input.plan : {};
  const runner = plan.runner && typeof plan.runner === 'object'
    ? plan.runner as Record<string, unknown>
    : {};
  const progress = deriveProgressFromPlan(plan);
  const currentTaskId = asString(runner.currentTaskId)
    || progress.nextRunnableTaskIds[0]
    || undefined;
  const taskTitle = findTaskTitle(plan, currentTaskId);
  const previous = runner.contextCheckpoint && typeof runner.contextCheckpoint === 'object'
    ? runner.contextCheckpoint as Record<string, unknown>
    : null;
  const previousSequence = Number.isFinite(previous?.sequence)
    ? Math.max(0, Math.trunc(Number(previous?.sequence)))
    : Number.isFinite(runner.lastConsumedCheckpointSequence)
      ? Math.max(0, Math.trunc(Number(runner.lastConsumedCheckpointSequence)))
      : 0;
  const runId = asString(input.runId)
    || asString(runner.runId)
    || asString(plan.planId as string);
  const now = asString(input.now, new Date().toISOString());
  const ids = createGoalCheckpointIds(new Date(now));

  return normalizeGoalCheckpoint({
    schemaVersion: GOAL_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: asString(input.checkpointId, ids.checkpointId),
    compactionId: asString(input.compactionId, ids.compactionId),
    sequence: Number.isFinite(input.sequence)
      ? Math.max(1, Math.trunc(Number(input.sequence)))
      : previousSequence + 1,
    status: 'preparing',
    reason: input.reason,
    planId: asString(plan.planId as string),
    planVersion: Number.isFinite(plan.version) ? Math.trunc(Number(plan.version)) : 0,
    runId,
    conversationId: asString(input.conversationId, asString(plan.conversationId as string)) || undefined,
    streamId: asString(input.streamId) || undefined,
    currentTaskId,
    runnerPhase: asString(runner.phase) || undefined,
    runnerIntent: asString(runner.intent) || undefined,
    progress,
    objectiveNow: clampText(plan.goal, GOAL_CHECKPOINT_LIMITS.maxTextChars, asString(plan.title, 'Continue the active goal.')),
    currentWork: taskTitle
      ? `Resume task ${currentTaskId}: ${taskTitle}`
      : 'Resume the current executable scene.',
    recentActions: Array.isArray(input.recentActions) ? input.recentActions : [],
    completedSincePrevious: [],
    mostImportantFact: taskTitle
      ? `Current task is ${currentTaskId} (${taskTitle}).`
      : 'Continue the active goal from the latest checkpoint.',
    decisions: [],
    blockers: asString(runner.blockedReason) ? [asString(runner.blockedReason)] : [],
    risks: [],
    openQuestions: [],
    pendingVerifications: [],
    doNotRepeat: [],
    handoffNote: [
      `Goal: ${asString(plan.goal, asString(plan.title, plan.planId as string))}`,
      currentTaskId ? `Current task: ${currentTaskId}${taskTitle ? ` / ${taskTitle}` : ''}` : 'Current task: (none)',
      'First action: continue the current task without repeating completed work.',
      'Write evidence back through goal_update_task before marking completion.',
    ].join('\n'),
    firstAction: {
      kind: 'inspect',
      instruction: currentTaskId
        ? `Continue task ${currentTaskId}${taskTitle ? ` (${taskTitle})` : ''} from the current scene.`
        : 'Inspect the active goal plan and continue the next runnable task.',
      target: currentTaskId,
      successCheck: 'Task progress or verification evidence is written back with evidenceRefs.',
      requiredEvidenceRefs: [],
    },
    evidenceRefs: [],
    mustReadEvidenceRefs: [],
    openToolCalls: Array.isArray(input.openToolCalls) ? input.openToolCalls : [],
    budget: input.budget ?? {
      contextWindow: null,
      beforeTokens: 0,
      targetTokens: 0,
      systemTokens: 0,
      toolsTokens: 0,
      checkpointTokens: 0,
      continuityTokens: 0,
      recentTailTokens: 0,
      keepBudgetTokens: 0,
      compactionCount: Number.isFinite(runner.compactionCount)
        ? Math.max(0, Math.trunc(Number(runner.compactionCount)))
        : 0,
    },
    resumePolicy: 'start_recovery_turn',
    createdAt: now,
  }, {
    fallbackPlanId: asString(plan.planId as string),
    fallbackRunId: runId,
    fallbackPlanVersion: Number.isFinite(plan.version) ? Math.trunc(Number(plan.version)) : 0,
    now,
  });
}

export function formatGoalCheckpointForPrompt(checkpoint: unknown): string {
  const validation = validateGoalCheckpoint(checkpoint);
  if (!validation.ok || !validation.checkpoint) {
    return '';
  }
  const cp = validation.checkpoint;
  const lines = [
    'Active Goal execution checkpoint (authoritative runtime state, scope=run).',
    'This is factual runtime state for seamless resume after context compaction.',
    'It is not a user message and must not be overridden by lower-priority summaries.',
    '',
    `checkpointId=${cp.checkpointId}`,
    `sequence=${cp.sequence}`,
    `planId=${cp.planId}`,
    `runId=${cp.runId}`,
    `status=${cp.status}`,
    `reason=${cp.reason}`,
    `digest=${cp.digest}`,
    `resumePolicy=${cp.resumePolicy}`,
    cp.currentTaskId ? `currentTaskId=${cp.currentTaskId}` : 'currentTaskId=(none)',
    '',
    `Current objective: ${cp.objectiveNow}`,
    `Current work: ${cp.currentWork}`,
    `Most important fact: ${cp.mostImportantFact}`,
    `Progress: ${cp.progress.completed}/${cp.progress.total} completed (${cp.progress.percent}%)`,
  ];

  if (cp.recentActions.length) {
    lines.push('Recent actions:');
    for (const action of cp.recentActions) {
      const refs = action.evidenceRefs.length ? ` [evidenceRefs=${action.evidenceRefs.join(',')}]` : '';
      lines.push(`- [${action.status}] ${action.summary}${refs}`);
    }
  }
  if (cp.pendingVerifications.length) {
    lines.push('Pending verification:');
    for (const item of cp.pendingVerifications) lines.push(`- ${item}`);
  }
  if (cp.doNotRepeat.length) {
    lines.push('Do not repeat:');
    for (const item of cp.doNotRepeat) lines.push(`- ${item}`);
  }
  if (cp.openToolCalls.length) {
    lines.push('Open tool calls:');
    for (const call of cp.openToolCalls) {
      lines.push(`- ${call.toolCallId} status=${call.status} replayPolicy=${call.replayPolicy}`);
    }
  }
  if (cp.mustReadEvidenceRefs.length) {
    lines.push('Must read evidence:');
    for (const ref of cp.mustReadEvidenceRefs) lines.push(`- ${ref}`);
  }

  lines.push(`First action (${cp.firstAction.kind}): ${cp.firstAction.instruction}`);
  if (cp.firstAction.target) lines.push(`First action target: ${cp.firstAction.target}`);
  lines.push(`First action success check: ${cp.firstAction.successCheck}`);
  lines.push('Handoff:');
  lines.push(cp.handoffNote);
  lines.push('');
  lines.push('Resume rules:');
  lines.push('- Prefer executing firstAction before starting unrelated work.');
  lines.push('- Do not mark work complete without evidenceRefs.');
  lines.push('- Do not repeat doNotRepeat items unless conditions changed with new evidence.');
  return lines.join('\n');
}
