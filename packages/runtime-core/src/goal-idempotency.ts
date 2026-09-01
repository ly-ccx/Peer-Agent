/**
 * Goal tool idempotency helpers.
 *
 * After compact/resume, the model may re-issue the same side-effecting tool
 * call. These pure helpers decide whether to replay, reuse, query, or block.
 *
 * See peer-knowledge/knowledge/architecture/24-goal-runner-context-checkpoint-and-seamless-resume.md
 */
import { sha256Hex } from './iso-crypto.ts';

export const GOAL_TOOL_REPLAY_POLICIES = Object.freeze([
  'never',
  'query_status',
  'safe_retry',
  'ask_user',
  'reuse_completed',
] as const);

export type GoalToolReplayPolicy = (typeof GOAL_TOOL_REPLAY_POLICIES)[number];

export type GoalToolMutationClass =
  | 'read_only'
  | 'idempotent_write'
  | 'non_idempotent_write'
  | 'unknown';

export interface GoalIdempotencyKeyInput {
  readonly planId: string;
  readonly runId: string;
  readonly taskId?: string | null;
  readonly toolName: string;
  readonly args?: unknown;
  readonly intent?: string | null;
}

export interface GoalOpenToolCallLike {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly resultEvidenceRefs?: readonly string[];
  readonly replayPolicy?: string;
  readonly idempotencyKey?: string;
}

export interface GoalToolReplayDecision {
  readonly action: 'execute' | 'reuse' | 'query_status' | 'block' | 'ask_user';
  readonly reason: string;
  readonly policy: GoalToolReplayPolicy;
  readonly mutationClass: GoalToolMutationClass;
  readonly idempotencyKey: string;
  readonly matchedCall?: GoalOpenToolCallLike | null;
  readonly evidenceRefs?: readonly string[];
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'batch_search',
  'goal_get_plan',
  'web_fetch',
  'browser_read_dom',
  'browser_screenshot',
  'bash', // treated carefully below based on command shape when possible
]);

const IDEMPOTENT_WRITE_TOOLS = new Set([
  'write_file',
  'goal_update_task',
  'goal_create_plan',
]);

const NON_IDEMPOTENT_WRITE_TOOLS = new Set([
  'edit_file',
  'shell_stop',
  'browser_click',
  'browser_type',
  'browser_navigate',
  'browser_hover',
  'browser_scroll',
  'request_explorer',
  'request_user_input',
]);

function asString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim();
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

function normalizeArgsForKey(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '';
    try {
      return stableStringify(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return stableStringify(args);
}

/**
 * Deterministic idempotency key for a Goal tool attempt.
 * planId + runId + taskId + toolName + normalizedArgs + intent
 */
export function buildGoalIdempotencyKey(input: GoalIdempotencyKeyInput): string {
  const planId = asString(input.planId);
  const runId = asString(input.runId);
  const taskId = asString(input.taskId);
  const toolName = asString(input.toolName);
  const intent = asString(input.intent, 'execute');
  const argsKey = normalizeArgsForKey(input.args);
  const material = [planId, runId, taskId, toolName, argsKey, intent].join('\u0001');
  return sha256Hex(material);
}

export function classifyGoalToolMutation(
  toolName: string,
  args: unknown = null,
): GoalToolMutationClass {
  const name = asString(toolName);
  if (!name) return 'unknown';

  if (name === 'bash') {
    const command = typeof args === 'object' && args && 'command' in args
      ? asString((args as { command?: unknown }).command)
      : typeof args === 'string'
        ? args
        : '';
    // Heuristic: pure inspection commands are treated as read_only.
    if (/^\s*(ls|pwd|cat|head|tail|rg|grep|find|sed -n|node --test|pnpm (test|typecheck|build)|git (status|diff|log|show))\b/i.test(command)) {
      return 'read_only';
    }
    if (/\b(rm|mv|cp|chmod|chown|kill|reboot|shutdown|dd|mkfs|git (push|commit|reset|clean)|pnpm (publish|add|remove))\b/i.test(command)) {
      return 'non_idempotent_write';
    }
    return 'unknown';
  }

  if (READ_ONLY_TOOLS.has(name)) return 'read_only';
  if (IDEMPOTENT_WRITE_TOOLS.has(name)) return 'idempotent_write';
  if (NON_IDEMPOTENT_WRITE_TOOLS.has(name)) return 'non_idempotent_write';
  if (name.startsWith('mcp__') || name.startsWith('browser_')) return 'non_idempotent_write';
  return 'unknown';
}

export function defaultReplayPolicyForMutation(
  mutationClass: GoalToolMutationClass,
): GoalToolReplayPolicy {
  switch (mutationClass) {
    case 'read_only':
      return 'safe_retry';
    case 'idempotent_write':
      return 'safe_retry';
    case 'non_idempotent_write':
      return 'query_status';
    default:
      return 'ask_user';
  }
}

export function decideGoalToolReplay(input: {
  readonly planId: string;
  readonly runId: string;
  readonly taskId?: string | null;
  readonly toolName: string;
  readonly args?: unknown;
  readonly intent?: string | null;
  readonly openToolCalls?: readonly GoalOpenToolCallLike[] | null;
  readonly completedLedger?: ReadonlyMap<string, {
    readonly status: string;
    readonly evidenceRefs?: readonly string[];
    readonly toolCallId?: string;
  }> | null;
}): GoalToolReplayDecision {
  const mutationClass = classifyGoalToolMutation(input.toolName, input.args);
  const policy = defaultReplayPolicyForMutation(mutationClass);
  const idempotencyKey = buildGoalIdempotencyKey({
    planId: input.planId,
    runId: input.runId,
    taskId: input.taskId,
    toolName: input.toolName,
    args: input.args,
    intent: input.intent,
  });

  const ledgerHit = input.completedLedger?.get(idempotencyKey) ?? null;
  if (ledgerHit && (ledgerHit.status === 'completed' || ledgerHit.status === 'succeeded')) {
    return {
      action: 'reuse',
      reason: 'idempotency_ledger_hit',
      policy: 'reuse_completed',
      mutationClass,
      idempotencyKey,
      matchedCall: {
        toolCallId: ledgerHit.toolCallId,
        toolName: input.toolName,
        status: ledgerHit.status,
        resultEvidenceRefs: ledgerHit.evidenceRefs ?? [],
        replayPolicy: 'reuse_completed',
        idempotencyKey,
      },
      evidenceRefs: ledgerHit.evidenceRefs ?? [],
    };
  }

  const openCalls = Array.isArray(input.openToolCalls) ? input.openToolCalls : [];
  // Replay protection only applies to an exact logical-call match. Tool names are
  // not identities: two different bash commands (or writes) may run in one Goal.
  const matched = openCalls.find((call) => asString(call.idempotencyKey) === idempotencyKey)
    || null;

  if (matched?.status === 'completed' && (matched.resultEvidenceRefs?.length ?? 0) > 0) {
    return {
      action: 'reuse',
      reason: 'open_tool_call_completed',
      policy: 'reuse_completed',
      mutationClass,
      idempotencyKey,
      matchedCall: matched,
      evidenceRefs: matched.resultEvidenceRefs ?? [],
    };
  }

  if (matched?.status === 'running' || matched?.status === 'requested') {
    if (policy === 'safe_retry' && mutationClass === 'read_only') {
      return {
        action: 'execute',
        reason: 'read_only_safe_retry',
        policy,
        mutationClass,
        idempotencyKey,
        matchedCall: matched,
      };
    }
    return {
      action: mutationClass === 'non_idempotent_write' ? 'query_status' : 'block',
      reason: matched.status === 'running' ? 'tool_still_running' : 'tool_requested_unsettled',
      policy: mutationClass === 'non_idempotent_write' ? 'query_status' : policy,
      mutationClass,
      idempotencyKey,
      matchedCall: matched,
    };
  }

  // No exact ledger/checkpoint match means this is a fresh call, not a replay.
  // Unknown mutation safety still matters for a matched unsettled call above, but
  // must not pre-empt the downstream PermissionGate on first execution.
  return {
    action: 'execute',
    reason: 'no_prior_attempt',
    policy,
    mutationClass,
    idempotencyKey,
    matchedCall: matched,
  };
}

export interface GoalIdempotencyLedgerEntry {
  status: string;
  evidenceRefs: string[];
  toolCallId?: string;
  toolName?: string;
  updatedAt: string;
  planId?: string;
  runId?: string;
}

function createLedgerEntry(input: {
  readonly status: string;
  readonly evidenceRefs?: readonly string[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly planId?: string;
  readonly runId?: string;
}): GoalIdempotencyLedgerEntry {
  return {
    status: asString(input.status, 'completed'),
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.map((ref) => asString(ref)).filter(Boolean)
      : [],
    toolCallId: asString(input.toolCallId) || undefined,
    toolName: asString(input.toolName) || undefined,
    updatedAt: new Date().toISOString(),
    planId: asString(input.planId) || undefined,
    runId: asString(input.runId) || undefined,
  };
}

/**
 * Process-local ledger (tests / fallback when no durable storeDir is available).
 */
export function createGoalIdempotencyLedger() {
  const entries = new Map<string, GoalIdempotencyLedgerEntry>();

  return {
    get(key: string) {
      return entries.get(key) ?? null;
    },
    remember(input: {
      readonly idempotencyKey: string;
      readonly status: string;
      readonly evidenceRefs?: readonly string[];
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly planId?: string;
      readonly runId?: string;
    }) {
      const key = asString(input.idempotencyKey);
      if (!key) return null;
      const next = createLedgerEntry(input);
      entries.set(key, next);
      return next;
    },
    snapshot() {
      return new Map(entries);
    },
    clear() {
      entries.clear();
    },
    get filePath() {
      return null as string | null;
    },
  };
}

export type GoalIdempotencyLedger = ReturnType<typeof createGoalIdempotencyLedger>;
