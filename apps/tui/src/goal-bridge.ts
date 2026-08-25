/**
 * CLI Goal bridge: reuse the shared Node GoalPlan store on disk and expose the same
 * goal_create_plan / goal_update_task / goal_get_plan tools to TUI runtime.
 *
 * Also enforces Goal-mode intake: before an accepted/executing plan exists for
 * the conversation, side-effect tools (shell/write) are blocked.
 */
import {
  SHARED_LOCAL_TOOL_CONTRACTS,
  canonicalizeLocalCapabilityId,
  type RuntimeToolDefinition,
} from '@peer-agent/runtime-core';
import type { RuntimeSdkProviderExecution, RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';
import { createGoalPlanStore, pathOf } from '@peer-agent/runtime-node';

import type { TuiMode } from './tui-mode.ts';

export const GOAL_TOOL_NAMES = Object.freeze({
  createPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.toolName,
  updateTask: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.toolName,
  getPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.toolName,
  requestExplorer: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.toolName,
});

export const GOAL_CAPABILITY_IDS = Object.freeze({
  create: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
  update: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
  read: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
  explore: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId,
});

const GOAL_CAPABILITY_SET = new Set<string>(Object.values(GOAL_CAPABILITY_IDS));
const GOAL_PLAN_TOOL_MODE_SCOPES = ['chat', 'plan', 'goal'] as const;
const GOAL_EXPLORER_TOOL_MODE_SCOPES = ['chat', 'goal'] as const;

const GOAL_ALWAYS_ALLOWED = new Set<string>([
  GOAL_CAPABILITY_IDS.create,
  GOAL_CAPABILITY_IDS.update,
  GOAL_CAPABILITY_IDS.read,
  SHARED_LOCAL_TOOL_CONTRACTS.shellStop.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.readFile.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.searchFiles.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.batchSearch.capabilityId,
  'local.web.fetch',
  'local.browser.navigate',
  'local.browser.click',
  'local.browser.type',
  'local.browser.screenshot',
  'local.browser.read_dom',
  'goal_create_plan',
  'goal_update_task',
  'goal_get_plan',
  'read_file',
  'search_files',
  'batch_search',
  'web_fetch',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_read_dom',
  'request_user_input',
  'local.interaction.request_user_input',
  'request_explorer',
  'goal_get_plan',
]);

const SIDE_EFFECT_HINTS = [
  'local.shell',
  'local.file.write',
  'local.file.edit',
  'local.file.delete',
  'bash',
  'edit_file',
  'write_file',
  'delete',
];

export interface TuiGoalBridge {
  readonly store: any;
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  isGoalCapability(capabilityId: string): boolean;
  evaluateIntake(options: {
    readonly mode: TuiMode | string | null | undefined;
    readonly conversationId?: string | null;
    readonly capabilityId: string;
  }): { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
  execute(options: {
    readonly capabilityId: string;
    readonly args: Record<string, unknown>;
    readonly conversationId?: string | null;
    readonly mode?: string | null;
    readonly workspaceRoot?: string | null;
    readonly toolCallId?: string;
  }): Promise<RuntimeSdkProviderExecution>;
  listPlansByConversation(conversationId: string | null | undefined): readonly any[];
  listPlanDetailsByConversation(conversationId: string | null | undefined): readonly any[];
  getPlan(planId: string): any | null;
  /**
   * Subscribe to goal-plan changes for this process.
   * Prefer in-process store onChange fan-out so the TUI panel can refresh as
   * soon as goal_create_plan persists — not only after the chat turn ends or
   * after an fs.watch drain of .changes.jsonl.
   */
  subscribeChanges(listener: (event: {
    readonly conversationId?: string | null;
    readonly planId?: string | null;
    readonly changeKind?: string | null;
    readonly reason?: string | null;
  }) => void): () => void;
}

function goalPlansDir(): string {
  return pathOf('goalPlans');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface TuiExplorerRequest {
  readonly question: string;
  readonly reason: string;
  readonly scope: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
}

export function normalizeExplorerRequest(
  args: Record<string, unknown>,
): TuiExplorerRequest | null {
  const question = asString(args.question);
  if (!question) return null;
  const reason = asString(args.reason) ?? '';
  const scopeRecord = args.scope && typeof args.scope === 'object'
    ? args.scope as Record<string, unknown>
    : {};
  const include = Array.isArray(scopeRecord.include)
    ? scopeRecord.include.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  const exclude = Array.isArray(scopeRecord.exclude)
    ? scopeRecord.exclude.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return { question, reason, scope: { include, exclude } };
}

function normalizeTasks(tasks: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task, index): Array<Record<string, unknown>> => {
    if (!task || typeof task !== 'object') return [];
    const record = task as Record<string, unknown>;
    const title = asString(record.title) ?? `task-${index + 1}`;
    const taskId = asString(record.taskId) ?? `task-${index + 1}`;
    const dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.filter((item): item is string => typeof item === 'string')
      : [];
    return [{
      taskId,
      title,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      status: typeof record.status === 'string' ? record.status : 'pending',
    }];
  });
}

function deriveTitle(title: unknown, _goal: unknown): string {
  const explicit = asString(title);
  // 不再用 goal 截断冒充标题；漏传时交由 store sanitize 落成占位名。
  return explicit ?? '';
}

function okExecution(
  call: RuntimeSdkToolCall,
  summary: string,
  output: unknown,
): RuntimeSdkProviderExecution {
  return {
    result: {
      toolCallId: call.toolCallId,
      capabilityId: call.capabilityId,
      status: 'success',
      summary,
      output,
      outputPreview: typeof output === 'string' ? output : JSON.stringify(output),
      evidence: {
        summary,
        returnedToCloud: true,
        dataLevel: 'D1_internal',
      },
    } as any,
  };
}

function failedExecution(
  call: RuntimeSdkToolCall,
  summary: string,
  error: string,
): RuntimeSdkProviderExecution {
  return {
    result: {
      toolCallId: call.toolCallId,
      capabilityId: call.capabilityId,
      status: 'failed',
      summary,
      error: { message: error },
      output: { ok: false, error },
      outputPreview: error,
      evidence: {
        summary,
        returnedToCloud: true,
        dataLevel: 'D1_internal',
      },
    } as any,
  };
}

function isSideEffectCapability(capabilityId: string): boolean {
  if (GOAL_ALWAYS_ALLOWED.has(capabilityId)) return false;
  const lower = capabilityId.toLowerCase();
  return SIDE_EFFECT_HINTS.some((hint) => lower.includes(hint));
}

function hasReadyPlan(plans: readonly any[]): boolean {
  return plans.some((plan) => {
    const status = String(plan?.status ?? '');
    return ['accepted', 'executing', 'running', 'approved', 'goal_created'].includes(status)
      || plan?.activation?.kind === 'accepted_goal'
      || plan?.workflowKind === 'goal_self_driven' && !['draft', 'awaiting_approval', 'cancelled', 'completed', 'failed'].includes(status);
  });
}

export function createTuiGoalBridge(options?: {
  readonly storeDir?: string;
  readonly store?: any;
}): TuiGoalBridge {
  const store = options?.store ?? createGoalPlanStore({
    storeDir: options?.storeDir ?? goalPlansDir(),
  });

  // Multi-listener fan-out over store.setOnChange / onChange.
  // Runner auto-start and the TUI Goal panel both need the same in-process
  // notify; overwriting setOnChange would drop one of them.
  type GoalChangeListener = (event: {
    readonly conversationId?: string | null;
    readonly planId?: string | null;
    readonly changeKind?: string | null;
    readonly reason?: string | null;
  }) => void;
  const localChangeListeners = new Set<GoalChangeListener>();
  // Desktop injects onChange at construct time; TUI store starts without one.
  // Own the single setOnChange slot and fan out to local listeners.
  if (typeof store?.setOnChange === 'function') {
    store.setOnChange((payload: any) => {
      for (const listener of localChangeListeners) {
        try {
          listener(payload);
        } catch {
          // Listener failures must not break store write paths.
        }
      }
    });
  }

  function subscribeLocalChanges(listener: GoalChangeListener): () => void {
    if (typeof listener !== 'function') return () => {};
    localChangeListeners.add(listener);
    // Keep disk watcher as a cross-process safety net (Desktop ↔ CLI).
    const unsubDisk =
      typeof store?.subscribeChanges === 'function'
        ? store.subscribeChanges(listener)
        : () => {};
    return () => {
      localChangeListeners.delete(listener);
      unsubDisk();
    };
  }

  const toolDefinitions: RuntimeToolDefinition[] = [
    {
      name: GOAL_TOOL_NAMES.createPlan,
      capabilityId: GOAL_CAPABILITY_IDS.create,
      modeScopes: [...GOAL_PLAN_TOOL_MODE_SCOPES],
      description:
        'Create a persistent, trackable goal/plan. In Goal mode, establish the objective and subtasks before side-effecting work.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          targetWorkspacePath: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                title: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'string' } },
              },
              required: ['title'],
            },
          },
          successCriteria: { type: 'array' },
        },
        required: ['goal', 'tasks'],
      },
    } as RuntimeToolDefinition,
    {
      name: GOAL_TOOL_NAMES.updateTask,
      capabilityId: GOAL_CAPABILITY_IDS.update,
      modeScopes: [...GOAL_PLAN_TOOL_MODE_SCOPES],
      description: 'Record execution evidence for a goal/plan subtask.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string' },
          taskId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'waiting_user'],
          },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          result: { type: 'string' },
          failureReason: { type: 'string' },
          blockedReason: { type: 'string' },
          criterionResults: { type: 'array' },
        },
        required: ['planId', 'taskId'],
      },
    } as RuntimeToolDefinition,
    {
      name: GOAL_TOOL_NAMES.getPlan,
      capabilityId: GOAL_CAPABILITY_IDS.read,
      modeScopes: [...GOAL_PLAN_TOOL_MODE_SCOPES],
      description: 'Read back an existing goal/plan or list active plans for the conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string' },
        },
        required: [],
      },
    } as RuntimeToolDefinition,
    {
      name: GOAL_TOOL_NAMES.requestExplorer,
      capabilityId: GOAL_CAPABILITY_IDS.explore,
      modeScopes: [...GOAL_EXPLORER_TOOL_MODE_SCOPES],
      description: 'Register a focused read-only Explorer request for the Goal Runner to execute after this turn.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          reason: { type: 'string' },
          scope: {
            type: 'object',
            properties: {
              include: { type: 'array', items: { type: 'string' } },
              exclude: { type: 'array', items: { type: 'string' } },
            },
            required: ['include', 'exclude'],
          },
        },
        required: ['question', 'reason'],
      },
    } as RuntimeToolDefinition,
  ];

  function listPlansByConversation(conversationId: string | null | undefined): readonly any[] {
    if (!conversationId || typeof store.listPlansByConversation !== 'function') return [];
    try {
      return store.listPlansByConversation(conversationId) ?? [];
    } catch {
      return [];
    }
  }

  function getPlan(planId: string): any | null {
    if (!planId || typeof store.getPlan !== 'function') return null;
    try {
      return store.getPlan(planId) ?? null;
    } catch {
      return null;
    }
  }

  function listPlanDetailsByConversation(conversationId: string | null | undefined): readonly any[] {
    if (!conversationId) return [];
    try {
      if (typeof store.listPlanDetailsByConversation === 'function') {
        return store.listPlanDetailsByConversation(conversationId) ?? [];
      }
      return listPlansByConversation(conversationId)
        .map((meta) => getPlan(meta?.planId) ?? meta)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function evaluateIntake(options: {
    readonly mode: TuiMode | string | null | undefined;
    readonly conversationId?: string | null;
    readonly capabilityId: string;
  }): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
    const mode = String(options.mode ?? '');
    if (mode !== 'goal') return { allowed: true };
    const capabilityId = canonicalizeLocalCapabilityId(options.capabilityId);
    if (GOAL_ALWAYS_ALLOWED.has(capabilityId) || GOAL_CAPABILITY_SET.has(capabilityId)) {
      return { allowed: true };
    }
    if (!isSideEffectCapability(capabilityId)) return { allowed: true };

    const plans = listPlansByConversation(options.conversationId ?? null);
    if (hasReadyPlan(plans)) return { allowed: true };

    return {
      allowed: false,
      reason:
        'Goal intake is active: create a goal plan with goal_create_plan (and get user approval when required) before running side-effecting tools such as shell/write/edit.',
    };
  }

  async function execute(options: {
    readonly capabilityId: string;
    readonly args: Record<string, unknown>;
    readonly conversationId?: string | null;
    readonly mode?: string | null;
    readonly workspaceRoot?: string | null;
    readonly toolCallId?: string;
  }): Promise<RuntimeSdkProviderExecution> {
    const capabilityId = canonicalizeLocalCapabilityId(options.capabilityId);
    const call: RuntimeSdkToolCall = {
      toolCallId: options.toolCallId ?? `tui-goal-${Date.now()}`,
      capabilityId,
      arguments: options.args,
    } as RuntimeSdkToolCall;
    const conversationId = options.conversationId ?? null;
    const mode = options.mode ?? 'goal';
    const workspaceRoot = options.workspaceRoot ?? process.cwd();

    try {
      if (capabilityId === GOAL_CAPABILITY_IDS.create || capabilityId === GOAL_TOOL_NAMES.createPlan) {
        const goal = asString(options.args.goal);
        const tasks = normalizeTasks(options.args.tasks);
        if (!goal || tasks.length === 0) {
          return failedExecution(call, 'goal_create_plan failed', 'goal_create_plan requires goal and at least one task');
        }
        const draft = {
          conversationId,
          title: deriveTitle(options.args.title, goal),
          goal,
          originWorkspacePath: workspaceRoot,
          targetWorkspacePath: asString(options.args.targetWorkspacePath) || workspaceRoot,
          tasks,
          successCriteria: options.args.successCriteria,
          createdBy: 'agent',
        };

        let plan: any;
        if (mode === 'goal' && typeof store.upsertGoalContract === 'function') {
          plan = store.upsertGoalContract(conversationId, {
            ...draft,
            status: 'accepted',
            workflowKind: 'goal_self_driven',
            activation: {
              kind: 'accepted_goal',
              acceptedAt: new Date().toISOString(),
              acceptedBy: 'user',
            },
          });
        } else if (typeof store.createPlan === 'function') {
          plan = store.createPlan({
            ...draft,
            status: mode === 'plan' ? 'awaiting_approval' : 'accepted',
            workflowKind: mode === 'goal' ? 'goal_self_driven' : 'plan',
          });
        } else {
          return failedExecution(call, 'goal store unavailable', 'goal-plan-store createPlan is not available');
        }

        return okExecution(call, `Created plan ${plan?.planId ?? ''}`, {
          ok: true,
          planId: plan?.planId,
          status: plan?.status,
          workflowKind: plan?.workflowKind,
          taskCount: Array.isArray(plan?.tasks) ? plan.tasks.length : tasks.length,
          plan,
        });
      }

      if (capabilityId === GOAL_CAPABILITY_IDS.update || capabilityId === GOAL_TOOL_NAMES.updateTask) {
        const planId = asString(options.args.planId);
        const taskId = asString(options.args.taskId);
        if (!planId || !taskId) {
          return failedExecution(call, 'goal_update_task failed', 'planId and taskId are required');
        }
        if (typeof store.recordTaskEvidence !== 'function') {
          return failedExecution(call, 'goal store unavailable', 'recordTaskEvidence is not available');
        }
        const change = {
          status: asString(options.args.status) ?? undefined,
          evidenceRefs: Array.isArray(options.args.evidenceRefs) ? options.args.evidenceRefs : [],
          result: asString(options.args.result) ?? undefined,
          failureReason: asString(options.args.failureReason) ?? undefined,
          blockedReason: asString(options.args.blockedReason) ?? undefined,
        };
        let updated = store.recordTaskEvidence(planId, taskId, change);
        if (updated && options.args.criterionResults !== undefined
          && typeof store.recordCriterionResults === 'function') {
          const withCriteria = store.recordCriterionResults(planId, options.args.criterionResults);
          if (withCriteria) updated = withCriteria;
        }
        if (!updated) {
          return failedExecution(call, 'goal_update_task failed', `Goal plan not found: ${planId}`);
        }
        return okExecution(call, `Updated task ${taskId}`, {
          ok: true,
          planId,
          taskId,
          plan: updated,
        });
      }

      if (capabilityId === GOAL_CAPABILITY_IDS.read || capabilityId === GOAL_TOOL_NAMES.getPlan) {
        const planId = asString(options.args.planId);
        if (planId) {
          const plan = getPlan(planId);
          return okExecution(call, plan ? `Loaded plan ${planId}` : `Plan not found: ${planId}`, {
            ok: Boolean(plan),
            plan,
          });
        }
        const plans = listPlansByConversation(conversationId);
        return okExecution(call, `Listed ${plans.length} plan(s)`, {
          ok: true,
          plans,
        });
      }

      if (capabilityId === GOAL_CAPABILITY_IDS.explore || capabilityId === GOAL_TOOL_NAMES.requestExplorer) {
        const request = normalizeExplorerRequest(options.args);
        if (!request) {
          return failedExecution(call, 'request_explorer failed', 'question is required');
        }
        return okExecution(call, `Explorer request registered: ${request.question}`, {
          ok: true,
          registered: true,
          ...request,
        });
      }

      return failedExecution(call, 'unknown goal capability', `Unsupported goal capability: ${capabilityId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failedExecution(call, 'goal tool failed', message);
    }
  }

  return {
    store,
    toolDefinitions,
    isGoalCapability: (capabilityId) => {
      const canonicalCapabilityId = canonicalizeLocalCapabilityId(capabilityId);
      return GOAL_CAPABILITY_SET.has(canonicalCapabilityId)
        || capabilityId === GOAL_TOOL_NAMES.createPlan
        || capabilityId === GOAL_TOOL_NAMES.updateTask
        || capabilityId === GOAL_TOOL_NAMES.getPlan
        || capabilityId === GOAL_TOOL_NAMES.requestExplorer;
    },
    evaluateIntake,
    execute,
    listPlansByConversation,
    listPlanDetailsByConversation,
    getPlan,
    subscribeChanges: subscribeLocalChanges,
  };
}

export function goalPlansStoreDir(): string {
  return goalPlansDir();
}
