import {
  createRuntimePipeline,
  type RuntimePipelineToolExecution,
} from '@peer-agent/runtime-sdk';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type {
  ChatMessage,
  ChatModelInput,
  ChatModelPort,
  ChatModelState,
  ChatModelToolCall,
  ChatSupplementalSystemContextInput,
} from './chat-controller.ts';
import type { TuiHost } from './tui-host.ts';

const DEFAULT_MAX_TURNS = 8;

export interface TuiGoalWorkerAdapter {
  runExplorer(input: {
    readonly plan: any;
    readonly planId: string;
    readonly runner?: any;
    readonly explorer: any;
    readonly signal?: AbortSignal;
  }): Promise<any>;
  runVerifier(input: {
    readonly plan: any;
    readonly planId: string;
    readonly verifierRunId: string;
    readonly gate?: any;
    readonly signal?: AbortSignal;
  }): Promise<any>;
}

export interface CreateTuiGoalWorkerAdapterOptions {
  readonly model: ChatModelPort;
  readonly host: TuiHost;
  readonly idFactory?: () => string;
  readonly maxTurns?: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const text = asString(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function addEvidenceRefs(target: Set<string>, value: unknown): void {
  for (const ref of asStringArray(value)) target.add(ref);
}

function collectExecutionEvidence(executions: readonly RuntimeSdkProviderExecution[]): string[] {
  const refs = new Set<string>();
  for (const execution of executions) {
    const result = execution.result;
    const evidence = result.evidence as {
      refs?: readonly { uri?: string }[];
      records?: readonly { refs?: readonly { uri?: string }[] }[];
    } | undefined;
    if (result.toolCallId) refs.add(`tool-result://${result.toolCallId}`);
    addEvidenceRefs(refs, evidence?.refs?.map((ref) => ref.uri));
    for (const record of evidence?.records ?? []) {
      addEvidenceRefs(refs, record.refs?.map((ref) => ref.uri));
    }
    addEvidenceRefs(refs, (result.output as { artifactRefs?: unknown } | undefined)?.artifactRefs);
    addEvidenceRefs(refs, (result.outputPreview as { artifactRefs?: unknown } | undefined)?.artifactRefs);
  }
  return [...refs];
}

function collectLeafTasks(plan: any): any[] {
  const leaves: any[] = [];
  const queue = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task || typeof task !== 'object') continue;
    const children = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (children.length > 0) queue.push(...children);
    else leaves.push({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      evidenceRefs: asStringArray(task.evidenceRefs),
    });
  }
  return leaves;
}

function collectExplorerReports(plan: any): any[] {
  return (Array.isArray(plan?.runner?.explorers) ? plan.runner.explorers : [])
    .filter((run: any) => run?.status === 'completed' && run.report)
    .map((run: any) => ({
      explorerId: run.explorerId,
      summary: run.report.summary,
      evidenceRefs: asStringArray(run.report.evidenceRefs),
      confidence: run.report.confidence,
    }));
}

function explorerContext(plan: any, explorer: any): Record<string, unknown> {
  const request = explorer?.request && typeof explorer.request === 'object' ? explorer.request : {};
  return {
    explorerId: explorer?.explorerId,
    planId: plan?.planId ?? request.planId,
    planTitle: plan?.title ?? plan?.goal ?? null,
    request: {
      ...request,
      explorerId: explorer?.explorerId ?? request.explorerId,
      planId: plan?.planId ?? request.planId,
    },
  };
}

function verifierContext(plan: any, verifierRunId: string): Record<string, unknown> {
  return {
    verifierRunId,
    planId: plan?.planId,
    plan,
    tasks: collectLeafTasks(plan),
    successCriteria: Array.isArray(plan?.successCriteria) ? plan.successCriteria : [],
    explorerReports: collectExplorerReports(plan),
  };
}

function explorerMission(plan: any, explorer: any): string {
  const request = explorer?.request ?? {};
  const target = asString(plan?.targetWorkspacePath);
  return [
    `Explorer mission for plan "${asString(plan?.title) || asString(plan?.goal) || asString(plan?.planId) || 'goal'}".`,
    `Question: ${asString(request.question) || 'Explore missing evidence for the active goal'}`,
    `Reason: ${asString(request.reason) || 'The Goal Runner needs more evidence before continuing.'}`,
    ...(target ? [
      `Target code repository: ${target}`,
      'You may search and read files under this absolute path across repositories.',
    ] : []),
    `Scope include: ${asStringArray(request.scope?.include).join(', ') || '(not specified)'}`,
    `Scope exclude: ${asStringArray(request.scope?.exclude).join(', ') || '(not specified)'}`,
  ].join('\n');
}

function verifierMission(plan: any, verifierRunId: string): string {
  return [
    `Verifier mission for plan "${asString(plan?.title) || asString(plan?.goal) || asString(plan?.planId) || 'goal'}" (verifierRunId=${verifierRunId}).`,
    'Review the existing task evidence, success criteria, criterionResults, and explorer reports.',
    'Do not modify files or update the plan.',
  ].join('\n');
}

function normalizeExplorerReport(
  output: unknown,
  toolEvidenceRefs: readonly string[],
  toolCallCount: number,
): any {
  const parsed = parseJsonObject(output) ?? {};
  const requestedRefs = new Set(asStringArray(parsed.evidenceRefs));
  const allowed = new Set(toolEvidenceRefs);
  const evidenceRefs = [...requestedRefs].filter((ref) => allowed.has(ref));
  if (evidenceRefs.length === 0) evidenceRefs.push(...toolEvidenceRefs);
  if (evidenceRefs.length === 0) {
    throw new Error('explorer_completed_without_tool_evidence');
  }
  return {
    status: 'completed',
    summary: asString(parsed.summary) || 'Explorer completed with tool evidence.',
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    evidenceRefs,
    toolEvidenceRefs,
    recommendedNextStep: asString(parsed.recommendedNextStep) || null,
    confidence: ['low', 'medium', 'high'].includes(asString(parsed.confidence))
      ? asString(parsed.confidence)
      : 'medium',
    toolCallCount,
  };
}

function normalizeVerifierReport(
  output: unknown,
  toolEvidenceRefs: readonly string[],
  toolCallCount: number,
): any {
  const parsed = parseJsonObject(output) ?? {};
  const requestedRefs = new Set(asStringArray(parsed.evidenceRefs));
  const allowed = new Set(toolEvidenceRefs);
  const evidenceRefs = [...requestedRefs].filter((ref) => allowed.has(ref));
  if (evidenceRefs.length === 0) evidenceRefs.push(...toolEvidenceRefs);
  const failedCriteria = asStringArray(parsed.failedCriteria);
  const missingEvidence = asStringArray(parsed.missingEvidence);
  const risks = asStringArray(parsed.risks);
  const passed = parsed.passed === true
    && failedCriteria.length === 0
    && missingEvidence.length === 0
    && evidenceRefs.length > 0;
  return {
    passed,
    summary: asString(parsed.summary) || (passed ? 'Verifier passed.' : 'Verifier found issues.'),
    failedCriteria,
    missingEvidence,
    risks,
    evidenceRefs,
    recommendedNextAction: asString(parsed.recommendedNextAction) || (passed ? 'complete' : 'repair'),
    toolCallCount,
  };
}

export function createTuiGoalWorkerAdapter(
  options: CreateTuiGoalWorkerAdapterOptions,
): TuiGoalWorkerAdapter {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  async function runWorker(input: {
    readonly workerId: string;
    readonly mission: string;
    readonly systemContextInput: ChatSupplementalSystemContextInput;
    readonly signal?: AbortSignal;
  }): Promise<{ output: unknown; executions: readonly RuntimeSdkProviderExecution[]; toolCalls: number }> {
    const pipeline = createRuntimePipeline<
      ChatModelInput,
      ChatModelState,
      ChatModelToolCall,
      RuntimeSdkProviderExecution,
      string
    >({
      model: options.model,
      defaultMaxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      tools: {
        async execute(call, context): Promise<RuntimePipelineToolExecution<ChatModelToolCall, RuntimeSdkProviderExecution>> {
          const execution = await options.host.execute(call.capabilityId, call.arguments, {
            sessionId: context.run.sessionId,
            conversationId: context.run.conversationId,
            streamId: context.run.streamId,
            turnId: input.workerId,
            turnIndex: context.turn,
            mode: 'explorer',
            signal: input.signal,
          });
          return { call, result: execution };
        },
      },
    });
    const result = await pipeline.run({
      sessionId: `tui-worker:${input.workerId}`,
      conversationId: `tui-worker:${input.workerId}`,
      streamId: `tui-worker:${input.workerId}`,
      mode: 'explorer',
      input: {
        content: input.mission,
        history: [] as ChatMessage[],
        modelMessages: [],
        systemContextInput: input.systemContextInput,
        turnId: input.workerId,
        turnIndex: 0,
      },
    }, { signal: input.signal });
    if (result.status !== 'completed') {
      throw new Error(result.reason || `goal_worker_${result.status}`);
    }
    return {
      output: result.output,
      executions: result.state?.toolExecutions ?? [],
      toolCalls: result.toolCalls,
    };
  }

  return {
    async runExplorer(input) {
      const workerId = asString(input.explorer?.explorerId) || `explorer:${idFactory()}`;
      const context = explorerContext(input.plan, input.explorer);
      const result = await runWorker({
        workerId,
        mission: explorerMission(input.plan, input.explorer),
        systemContextInput: { explorerContext: context },
        signal: input.signal,
      });
      const toolEvidenceRefs = collectExecutionEvidence(result.executions);
      return normalizeExplorerReport(result.output, toolEvidenceRefs, result.toolCalls);
    },
    async runVerifier(input) {
      const workerId = input.verifierRunId || `verifier:${idFactory()}`;
      const context = verifierContext(input.plan, workerId);
      const result = await runWorker({
        workerId,
        mission: verifierMission(input.plan, workerId),
        systemContextInput: { verifierContext: context },
        signal: input.signal,
      });
      const toolEvidenceRefs = collectExecutionEvidence(result.executions);
      return normalizeVerifierReport(result.output, toolEvidenceRefs, result.toolCalls);
    },
  };
}

export const __testables = {
  collectExecutionEvidence,
  normalizeExplorerReport,
  normalizeVerifierReport,
};
