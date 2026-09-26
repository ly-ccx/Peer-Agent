import { randomUUID } from 'node:crypto';
import { projectConversationHistory } from '@peer-agent/runtime-core';
import {
  buildGoalRunnerTickMessage,
  createGoalRunner,
  describeVisualRepair,
} from '@peer-agent/runtime-node';
import { preparePlanExecutionWorkspace } from '../goal-preferred-worktree.mjs';
import {
  buildGoalRunnerStreamStartedPayload,
  createGoalRunnerAssistantPlaceholder,
  mapGoalTurnOutcome,
} from '../goal-runner-message-persistence.mjs';
import { createBroadcastSink, createCollectingSink } from './turn-sinks.mjs';
import { resolveDelegatedWorkTurn } from './work-session-profile.mjs';

export function buildGoalRunnerMessage(plan, turnNumber) {
  return buildGoalRunnerTickMessage(plan, turnNumber);
}

function buildGoalRunnerReminder(plan, turnNumber) {
  return {
    id: `goal-runner-${plan?.planId || 'unknown'}-${turnNumber}`,
    title: 'Goal Runner execution contract',
    kind: 'goal-runner',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: [
      'Continue autonomously within the active goal, boundaries, and success criteria.',
      'Use the existing tools and permission flow; when a subtask is completed, update it through the goal task evidence path.',
      'Open tasks are not finished by narrating the next read/search/edit. In this same turn emit a real tool call (read_file, bash, edit_file, or write_file).',
      'Do not send a planning-only reply such as "现在读" / "先读取" / "Let me read" and then stop.',
      'If you need user input, permission, or evidence is insufficient, stop and explain the blocker instead of pretending completion.',
      describeVisualRepair(plan),
    ].filter(Boolean).join(' '),
  };
}

function buildExplorerMessage({ plan, explorer }) {
  const request = explorer?.request || {};
  const targetWorkspacePath =
    typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim().length > 0
      ? plan.targetWorkspacePath.trim()
      : null;
  // 跨仓提示：当目标要改的代码仓与会话工作区不同（如"知识库驱动代码库"），
  // 显式告知 Explorer 目标仓绝对路径，并声明它有权用绝对路径跨仓检索/读取，
  // 避免 Explorer 因默认 cwd 在会话工作区而误判"读不到目标代码"。
  const targetWorkspaceLine = targetWorkspacePath
    ? `\nTarget code repository (may differ from the current workspace): ${targetWorkspacePath}`
      + `\nYou may search and read files under this absolute path across repositories; do not assume you are limited to the current workspace.`
    : '';
  return `Explorer mission for plan "${plan?.title || plan?.goal || plan?.planId || 'goal'}".
Question: ${request.question || 'Explore missing evidence for the active goal'}
Reason: ${request.reason || 'The Goal Runner needs more evidence before continuing.'}${targetWorkspaceLine}
Scope include: ${(request.scope?.include || []).join(', ') || '(not specified)'}
Scope exclude: ${(request.scope?.exclude || []).join(', ') || '(not specified)'}
Budget maxToolCalls: ${request.budget?.maxToolCalls || 4}`;
}

function buildExplorerReminder(explorer) {
  return {
    id: `goal-explorer-${explorer?.explorerId || 'unknown'}`,
    title: 'Explorer readonly contract',
    kind: 'goal-explorer',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: `Profile: readonly_explorer. You are a dynamically created evidence explorer, not a fixed role.
Use only the tools exposed to this explorer context. Do not modify files, do not update the goal plan, and do not claim evidence you did not inspect.
Use only evidenceRefs shown in your tool results; do not invent refs or cite paths as refs.
Return a concise JSON object only with: summary, findings[{claim,evidenceRefs}], evidenceRefs, recommendedNextStep, confidence(low|medium|high).`,
  };
}

function buildExplorerContext({ plan, explorer }) {
  const request = explorer?.request && typeof explorer.request === 'object' ? explorer.request : {};
  return {
    explorerId: explorer?.explorerId,
    planId: plan?.planId || request.planId,
    planTitle: plan?.title || plan?.goal || null,
    request: {
      ...request,
      explorerId: explorer?.explorerId || request.explorerId,
      planId: plan?.planId || request.planId,
    },
  };
}

function collectLeafTaskSummaries(plan) {
  const out = [];
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    out.push({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      evidenceRefs: Array.isArray(task.evidenceRefs) ? task.evidenceRefs : [],
    });
  }
  return out;
}

function collectExplorerReports(plan) {
  return (Array.isArray(plan?.runner?.explorers) ? plan.runner.explorers : [])
    .filter((run) => run?.status === 'completed' && run.report)
    .map((run) => ({
      explorerId: run.explorerId,
      summary: run.report.summary,
      evidenceRefs: Array.isArray(run.report.evidenceRefs) ? run.report.evidenceRefs : [],
      confidence: run.report.confidence,
    }));
}

function buildVerifierContext({ plan, verifierRunId }) {
  return {
    verifierRunId,
    planId: plan?.planId,
    plan,
    tasks: collectLeafTaskSummaries(plan),
    explorerReports: collectExplorerReports(plan),
  };
}

function buildVerifierMessage({ plan, verifierRunId }) {
  return `Verifier mission for plan "${plan?.title || plan?.goal || plan?.planId || 'goal'}" (verifierRunId=${verifierRunId}).
Review the existing task evidence, success criteria, criterionResults, and explorer reports. Do not modify files or update the plan.
Return JSON only with: passed, failedCriteria[{criterionId,reason,evidenceRefs}], missingEvidence[{taskId,reason}], risks[], evidenceRefs[], recommendedNextAction.`;
}

function buildVerifierReminder(verifierRunId) {
  return {
    id: `goal-verifier-${verifierRunId || 'unknown'}`,
    title: 'Verifier readonly contract',
    kind: 'goal-verifier',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: `Profile: readonly_verifier. Use only read-only tools. Do not modify files, do not update the goal plan, and do not create completion evidence.
Return JSON only with: passed, failedCriteria[{criterionId,reason,evidenceRefs}], missingEvidence[{taskId,reason}], risks[], evidenceRefs[], recommendedNextAction.`,
  };
}

function addEvidenceRefs(target, value) {
  if (typeof value === 'string' && value.trim()) {
    target.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) target.add(item.trim());
  }
}

function tryParseJsonObject(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectExplorerEvidenceRefs(events) {
  const refs = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.channel !== 'chat:stream:tool-result') continue;
    const payload = event.payload ?? {};
    addEvidenceRefs(refs, payload.evidenceRefs);

    const parsed = tryParseJsonObject(payload.result);
    if (!parsed) continue;
    addEvidenceRefs(refs, parsed.evidenceRefs);
    addEvidenceRefs(refs, parsed.artifactRef);
    addEvidenceRefs(refs, parsed.artifactRefs);
    addEvidenceRefs(refs, parsed.outputPreview?.artifactRef);
    addEvidenceRefs(refs, parsed.outputPreview?.artifactRefs);
    addEvidenceRefs(refs, parsed.outputPreview?.localToolResultRef?.artifactRef);
    addEvidenceRefs(refs, parsed.outputPreview?.localToolResultRef?.artifactRefs);
  }
  return Array.from(refs);
}

function normalizeVerifierIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const reason = typeof item.reason === 'string' && item.reason.trim()
        ? item.reason.trim()
        : '';
      if (!reason) return null;
      return {
        ...(typeof item.taskId === 'string' && item.taskId.trim() ? { taskId: item.taskId.trim() } : {}),
        ...(typeof item.criterionId === 'string' && item.criterionId.trim() ? { criterionId: item.criterionId.trim() } : {}),
        reason,
        evidenceRefs: Array.isArray(item.evidenceRefs)
          ? item.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
          : [],
      };
    })
    .filter(Boolean);
}

function parseVerifierReport(rawText, fallback = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
  }
  const report = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : { passed: false, risks: [text || fallback.summary || 'Verifier finished without structured output.'] };
  return {
    passed: report.passed === true,
    failedCriteria: normalizeVerifierIssues(report.failedCriteria),
    missingEvidence: normalizeVerifierIssues(report.missingEvidence),
    risks: Array.isArray(report.risks)
      ? report.risks.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    evidenceRefs: Array.isArray(report.evidenceRefs)
      ? report.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
      : [],
    recommendedNextAction: typeof report.recommendedNextAction === 'string'
      ? report.recommendedNextAction
      : undefined,
    summary: typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : report.passed === true
        ? 'Verifier passed.'
        : fallback.summary || 'Verifier found issues.',
  };
}

function parseExplorerReport(rawText, fallback = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
  }
  const report = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : { summary: text || fallback.summary || 'Explorer finished without textual output.' };
  const evidenceRefs = Array.isArray(report.evidenceRefs)
    ? report.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
    : [];
  return {
    summary: typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : fallback.summary || 'Explorer completed.',
    findings: Array.isArray(report.findings) ? report.findings : [],
    evidenceRefs,
    recommendedNextStep: typeof report.recommendedNextStep === 'string' ? report.recommendedNextStep : undefined,
    confidence: ['low', 'medium', 'high'].includes(report.confidence) ? report.confidence : 'medium',
  };
}

/**
 * Desktop assembly for Goal Runner, Explorer, and Verifier.
 * Dependencies are injected. The turn bodies are the previous main.mjs implementation.
 * @param {object} deps
 */
export function createDesktopGoalRunnerHost({
  goalPlanStore,
  conversationStore,
  agentTurnExecutor,
  broadcast,
  llmChatService,
  goalWorktreeAdapter,
  goalTaskBranchAdapter,
  desktopPreviewProvider,
  runPlanVisualVerifier,
  resolveConversationModelProviderId,
  toDesktopProviderMessages,
  desktopContinuityContextFromProjection,
  workspaceRoot,
  getMainWindows,
} = {}) {
  function routeRole(role, plan) {
    const workerModelProviderId = resolveConversationModelProviderId({
      conversationId: plan?.conversationId,
      conversationStore,
    });
    if (typeof llmChatService?.resolveGoalRole !== 'function') {
      return {
        ok: true,
        selection: {
          modelProviderId: workerModelProviderId,
          providerId: workerModelProviderId || '',
          modelId: '',
          family: '',
        },
        source: 'global',
        candidateIds: workerModelProviderId ? [workerModelProviderId] : [],
      };
    }
    return llmChatService.resolveGoalRole({ role, workerModelProviderId });
  }

  function roleTurnProfile(role, routed) {
    if (!routed?.ok) return { role };
    return {
      role,
      modelSelection: {
        ...routed.selection,
        ...(routed.source ? { source: routed.source } : {}),
        ...(typeof routed.sameFamilyAsWorker === 'boolean'
          ? { sameFamilyAsWorker: routed.sameFamilyAsWorker }
          : {}),
      },
      ...(Array.isArray(routed.candidateIds) && routed.candidateIds.length
        ? { recoveryCandidateIds: routed.candidateIds }
        : {}),
    };
  }

  function conversationModelId(plan) {
    return resolveConversationModelProviderId({
      conversationId: plan?.conversationId,
      conversationStore,
    });
  }

  /**
   * 任务回合用冻结快照。快照缺这一角色时退回 B1-09。
   * 普通 Goal 返回 null，调用方保持原来的画像和模型。
   */
  function resolveDelegatedTurn(plan, kind) {
    return resolveDelegatedWorkTurn(plan, kind, {
      conversationModelProviderId: conversationModelId(plan),
      routeRole: (role) => routeRole(role, plan),
    });
  }

  const goalRunnerOptions = {
    goalPlanStore,
    uiDeliveryAuthority: desktopPreviewProvider?.authority ?? null,
    prepareIsolation: async (plan) => {
      if (!plan) return plan;
      const conversation = plan.conversationId
        ? conversationStore.getConversation(plan.conversationId)
        : null;
      return preparePlanExecutionWorkspace({
        plan,
        conversation,
        ensureTaskBranch: goalTaskBranchAdapter?.ensureTaskBranch,
        prepareForPlan: goalWorktreeAdapter?.prepareForPlan,
        isolatePlan: goalWorktreeAdapter?.isolatePlan,
      });
    },
    chatRuntime: {
      async runGoalTurn({ plan, turnNumber }) {
        const conversation = conversationStore.getConversation(plan.conversationId);
        if (!conversation) {
          return { failed: true, failureReason: 'Goal conversation not found' };
        }
        const streamId = randomUUID();
        // Goal Runner 执行回合必须主进程落盘：先创建 assistant 占位并拿到 id，
        // 再把 assistantMessageId 同时交给 streamStarted（渲染绑定）与 sendMessage（正文回写）。
        // 没有 assistantMessageId 时 llm-chat-service 会跳过 persistStreamRecord。
        const startedAt = Date.now();
        const { id: assistantMessageId, message: assistantPlaceholder } =
          createGoalRunnerAssistantPlaceholder({ now: startedAt });
        conversationStore.appendMessage(plan.conversationId, assistantPlaceholder);
        broadcast('goalRunner:changed', buildGoalRunnerStreamStartedPayload({
          planId: plan.planId,
          conversationId: plan.conversationId ?? null,
          streamId,
          turnNumber,
          assistantMessageId,
          startedAt,
        }));
      
        const canonicalHistory = projectConversationHistory(conversation.messages);
        const messages = [
          ...toDesktopProviderMessages(canonicalHistory.messages),
          { role: 'user', content: buildGoalRunnerMessage(plan, turnNumber) },
        ];
        const goalContinuityContext = desktopContinuityContextFromProjection(canonicalHistory);
        // Goal Runner 实时计数 sink：把「模型每轮」和「每次工具调用」即时写回 store。
        // setRunnerState 内部 persist→notifyChanged 会广播 goalRunner:changed，
        // 渲染层据此实时刷新底部「轮次 / 工具」数字（roundCount 为展示计数，与预算 turnCount 解耦）。
        const planId = plan.planId;
        const bumpRunnerCount = (field) => {
          const current = goalPlanStore.getPlan(planId)?.runner;
          if (!current) return;
          const prev = Number.isFinite(current[field]) ? current[field] : 0;
          goalPlanStore.setRunnerState(planId, { [field]: prev + 1 });
        };
        // per-run Explorer 请求收集器：模型在本回合内调用 request_explorer 工具时，
        // 经 agentProgress.onToolCall 带上的 input（question/reason/scope）登记到这里。
        // sendMessage 结束后组装成 result.explorers 返回，交给 goal-runner 既有派发循环
        // （normalizeExploreRequests → dispatchExplorer → runExplorer）真正执行，
        // 使底部「explorers x/3」随真实派发增长。explorerId/planId 由 store 兜底补齐。
        const collectedExplorers = [];
        const agentProgress = {
          onRound: () => bumpRunnerCount('roundCount'),
          onToolCall: ({ tool, input } = {}) => {
            bumpRunnerCount('toolCallCount');
            if (tool === 'request_explorer') {
              const req = input && typeof input === 'object' ? input : {};
              const question = typeof req.question === 'string' ? req.question.trim() : '';
              if (!question) return;
              const scope = req.scope && typeof req.scope === 'object' ? req.scope : undefined;
              collectedExplorers.push({
                planId,
                question,
                reason: typeof req.reason === 'string' ? req.reason.trim() : undefined,
                ...(scope ? { scope } : {}),
              });
            }
          },
        };
        const delegated = resolveDelegatedTurn(plan, 'worker');
        const outcome = await agentTurnExecutor.runTurn({
          turnProfile: delegated?.turnProfile ?? { role: 'goal_runner' },
          sink: createBroadcastSink({ getWindows: getMainWindows }),
          messages,
          streamId,
          effort: 'default',
          // Runner 归 goal 模式独占(A1):托管推进的 turn 以 goal 模式驱动,使 goal-runner-source
          // 注入续推上下文、goal-mode-gate 放行自驱。plan 为纯审批门,不再托管续推。
          mode: 'goal',
          conversationId: plan.conversationId,
          modelProviderId: delegated?.modelProviderId || conversationModelId(plan),
          assistantMessageId,
          continuityContext: goalContinuityContext,
          runtimeReminders: [buildGoalRunnerReminder(plan, turnNumber)],
          agentProgress,
        });
        // 有 Explorer 请求时返回 explorers，让 Runner 进入 explore 派发分支；
        // 否则维持原有 verify 收尾语义。
        if (collectedExplorers.length > 0) {
          return {
            intent: 'explore',
            explorers: collectedExplorers,
            terminalStatus: outcome?.terminalStatus ?? null,
            toolCallCount: outcome?.toolCallCount ?? 0,
          };
        }
        return mapGoalTurnOutcome(outcome);
      },
    },
    explorerRunner: {
      async runExplorer({ plan, explorer }) {
        const streamId = randomUUID();
        const webContents = createCollectingSink();
        const delegated = resolveDelegatedTurn(plan, 'explorer');
        const routed = delegated ? null : routeRole('explorer', plan);
        if (delegated?.error) throw new Error(delegated.error.missing || '没有可用的模型');
        if (!delegated && !routed.ok) throw new Error(routed.missing || '没有可用的模型');
        broadcast('goalRunner:changed', {
          type: 'goalRunner:explorerStreamStarted',
          planId: plan.planId,
          conversationId: plan.conversationId ?? null,
          changeKind: 'runner-state',
          explorerId: explorer.explorerId,
          streamId,
          startedAt: Date.now(),
        });
        await agentTurnExecutor.runTurn({
          turnProfile: delegated?.turnProfile ?? roleTurnProfile('explorer', routed),
          sink: webContents,
          messages: [{ role: 'user', content: buildExplorerMessage({ plan, explorer }) }],
          streamId,
          effort: 'default',
          mode: 'explorer',
          // 旁路只读调查：不写会话正文，避免内部过程进聊天。
          conversationId: null,
          modelProviderId: delegated ? delegated.modelProviderId : routed.selection.modelProviderId,
          ephemeral: true,
          explorerContext: buildExplorerContext({ plan, explorer }),
          runtimeReminders: [buildExplorerReminder(explorer)],
        });
        const terminal = webContents.getTerminal();
        if (terminal?.channel === 'chat:stream:error') {
          throw new Error(terminal.payload?.error || 'Explorer stream failed');
        }
        if (terminal?.channel === 'chat:stream:aborted') {
          throw new Error('Explorer stream aborted');
        }
        const report = parseExplorerReport(webContents.getText(), {
          summary: 'Explorer completed without a structured report.',
        });
        const events = webContents.getEvents();
        report.toolCallCount = events.filter((event) => event.channel === 'chat:stream:tool-call').length;
        report.allowedEvidenceRefs = collectExplorerEvidenceRefs(events);
        return report;
      },
    },
    verifierRunner: {
      async runVerifier({ plan, verifierRunId, stage, signal }) {
        if (stage === 'visual') {
          const delegated = resolveDelegatedTurn(plan, 'visual_verifier');
          const routed = delegated ? null : routeRole('visual_verifier', plan);
          const routeError = delegated?.error || (!delegated && !routed?.ok ? routed : null);
          if (routeError) {
            return {
              passed: false,
              summary: routeError.missing || '没有能看图的模型',
              missing: routeError.missing || '没有能看图的模型',
              reason: routeError.reason || 'capability',
              evidenceRefs: [],
              findings: [],
              repairSuggestions: [],
            };
          }
          return runPlanVisualVerifier({ plan, verifierRunId, signal, goalPlanStore,
            workspacePath: (plan?.deliveryBinding?.executionIsolation === 'worktree' ? plan.deliveryBinding.worktreePath : null)
              || plan?.targetWorkspacePath || conversationStore?.getConversation?.(plan.conversationId)?.workspacePath || workspaceRoot,
            llmChatService, modelProviderId: delegated ? delegated.modelProviderId : routed.selection.modelProviderId });
        }
        const delegated = resolveDelegatedTurn(plan, 'verifier');
        const routed = delegated ? null : routeRole('verifier', plan);
        if (delegated?.error) throw new Error(delegated.error.missing || '没有可用的模型');
        if (!delegated && !routed.ok) throw new Error(routed.missing || '没有可用的模型');
        const streamId = randomUUID();
        const webContents = createCollectingSink();
        broadcast('goalRunner:changed', {
          type: 'goalRunner:verifierStreamStarted',
          planId: plan.planId,
          conversationId: plan.conversationId ?? null,
          changeKind: 'runner-state',
          verifierRunId,
          streamId,
          startedAt: Date.now(),
        });
        await agentTurnExecutor.runTurn({
          turnProfile: delegated?.turnProfile ?? roleTurnProfile('verifier', routed),
          sink: webContents,
          messages: [{ role: 'user', content: buildVerifierMessage({ plan, verifierRunId }) }],
          streamId,
          effort: 'default',
          // Verifier 复用 explorer 的只读工具投影；任务语义由 verifierContext Source 注入。
          mode: 'explorer',
          // 验收旁路流：不写会话、不进活跃流投影，JSON 只给 runner 解析。
          conversationId: null,
          modelProviderId: delegated ? delegated.modelProviderId : routed.selection.modelProviderId,
          ephemeral: true,
          verifierContext: buildVerifierContext({ plan, verifierRunId }),
          runtimeReminders: [buildVerifierReminder(verifierRunId)],
        });
        const terminal = webContents.getTerminal();
        if (terminal?.channel === 'chat:stream:error') {
          throw new Error(terminal.payload?.error || 'Verifier stream failed');
        }
        if (terminal?.channel === 'chat:stream:aborted') {
          throw new Error('Verifier stream aborted');
        }
        return parseVerifierReport(webContents.getText(), {
          summary: 'Verifier completed without a structured report.',
        });
      },
    },
    emitEvent: (payload) => {
      const planId = payload?.planId ?? null;
      const plan = planId ? goalPlanStore.getPlan(planId) : null;
      broadcast('goalRunner:changed', {
        ...payload,
        planId,
        conversationId: payload?.conversationId ?? plan?.conversationId ?? null,
        changeKind: payload?.changeKind ?? 'runner-state',
      });
    },
  };
  const goalRunner = createGoalRunner(goalRunnerOptions);
  return {
    goalRunner,
    explorerRunner: goalRunnerOptions.explorerRunner,
    verifierRunner: goalRunnerOptions.verifierRunner,
  };
}
