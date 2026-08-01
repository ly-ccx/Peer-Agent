import { isPromptTooLongError } from '@peer-agent/runtime-core';
import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  estimateToolsTokens,
  microcompactMessagesForContext,
  resolveSummaryTokenBudget,
} from '../context-compactor.mjs';
import {
  beginCompaction,
  endCompaction,
  failCompaction,
  updateCompactionProgress,
} from './compaction-registry.mjs';

/**
 * 同会话压缩互斥锁：同一会话同一时间只允许一个 Layer 2 压缩在跑。
 *
 * 为什么独立于 compaction-registry：registry 的 beginCompaction 只在需要展示
 * 横幅（showStart）时登记，showStart=false 的自动压缩不会留下条目；而并发竞态
 * （两次 summarize 交叠 + 两次 persist 整写同一会话文件）正是"压缩成功却显示失败"
 * 的根因，自动压缩同样必须被互斥保护。这里用独立的执行锁覆盖所有进入 Layer 2 的路径。
 */
const activeCompactionLocks = new Map();

/**
 * 尝试为某会话获取压缩锁。
 * @returns {'acquired' | 'skipped'} acquired=可继续压缩；skipped=同会话已有其他流在压缩。
 *   同 streamId 视为同一请求的重入，直接放行（覆盖为最新，语义与 beginCompaction 一致）。
 * @note 导出仅供测试直接断言互斥语义；生产路径只由 runCompactionCheck 调用。
 */
export function acquireCompactionLock(conversationId, streamId) {
  if (!conversationId || !streamId) return 'acquired';
  const running = activeCompactionLocks.get(conversationId);
  if (running && running !== streamId) return 'skipped';
  activeCompactionLocks.set(conversationId, streamId);
  return 'acquired';
}

/**
 * 释放某会话的压缩锁。仅当锁仍属于当前 streamId 时才删除，避免误释他人新锁。
 * @note 导出仅供测试直接断言互斥语义；生产路径只由 runCompactionCheck 调用。
 */
export function releaseCompactionLock(conversationId, streamId) {
  if (!conversationId || !streamId) return;
  if (activeCompactionLocks.get(conversationId) === streamId) {
    activeCompactionLocks.delete(conversationId);
  }
}

export function buildCompactionProviderConfig({
  provider,
  baseUrl,
  apiKey,
  model,
  maxOutputTokens,
  resolvedChannel = null,
  useResponses = false,
  authMethod = 'api_key',
} = {}) {
  return {
    provider,
    baseUrl: resolvedChannel?.baseUrl || baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    wire: useResponses ? 'openai-responses' : resolvedChannel?.wire,
    endpoint: resolvedChannel?.endpoint,
    headers: resolvedChannel?.headers,
    omitMaxOutputTokens: authMethod === 'oauth_chatgpt',
  };
}

// PTL 分类单一来源在 runtime-core isPromptTooLongError(双端同策略);
// 保留旧名供 Desktop 既有调用方/测试使用。
export function isPromptTooLongResponse(status, text) {
  return isPromptTooLongError(status, text);
}

export function buildPromptTooLongRecoveryError({ text = '', providerTracePath = null, retryUsed = false } = {}) {
  const detail = String(text || '').trim().slice(0, 300);
  const reason = retryUsed
    ? 'Automatic compaction was retried once, but the provider still rejected the request as too long.'
    : 'Automatic compaction could not reduce the conversation enough to safely retry.';
  return [
    `Context window exceeded. ${reason}`,
    'Please run /compact manually or shorten the conversation before continuing.',
    detail ? `provider_error=${detail}` : '',
    providerTracePath ? `provider_trace=${providerTracePath}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function applyMicrocompaction(messages, { log = console.log } = {}) {
  const result = microcompactMessagesForContext(messages);
  if (result.stats.compactedCount > 0) {
    // 微压缩(Layer 1)是静默的、不发横幅;这里打印它实际改动的消息数与节省字符,
    // 用于区分"5k→5k 横幅"到底是微压缩在动手,还是 Layer 2 语义压缩在动手。
    log(
      `[microcompaction] compacted=${result.stats.compactedCount} savedChars=${result.stats.savedChars} ` +
        `(silent, no banner)`,
    );
  }
  return result;
}

function shouldShowCompactionStart(messages, budget) {
  if (budget?.shouldCompact) return true;
  if (!budget?.contextWindow) return false;
  return estimateTokensFromMessages(messages) > budget.contextWindow * budget.triggerRatio;
}

// hard 线不再在 coordinator 另设常量:runtime-core CONTEXT_PROJECTION_CONFIG.hardRatio
// 是唯一真值(经 COMPACTION_CONFIG 透传),保证 Desktop 预算拦截与 TUI/共享投影的
// pressure 分级同一条 hard 线。历史上这里曾有独立 CONTEXT_BUDGET_GUARD(0.95),
// 与 runtime-core(0.92)分叉,已收敛删除。

export function computeContextBudget({
  messages,
  contextWindow,
  tools = null,
  usageSnapshot = null,
  // 可选：providerConfig 用于解析摘要输出预算；也可直接传 maxOutputTokens。
  providerConfig = null,
  maxOutputTokens = null,
}) {
  // ADR 56：provider observed usage 一旦存在，就成为显示和压缩判断的权威下界。
  // legacy estimate 仅在尚未取得 provider usage / exact count 的迁移期回退使用。
  const estimatedTokens =
    estimateTokensFromMessages(Array.isArray(messages) ? messages : []) +
    estimateToolsTokens(tools);
  const usageTokens = contextTokensFromUsageSnapshot(usageSnapshot);
  const contextTokens = usageTokens ?? estimatedTokens;
  const contextSource = usageTokens != null ? 'provider_usage' : 'legacy_estimate';
  const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const triggerRatio = COMPACTION_CONFIG.triggerRatio;
  const hardRatio = Math.max(triggerRatio, COMPACTION_CONFIG.hardRatio);

  // 摘要输出 + 安全区预留：不改写公开 soft/hard 触发线（仍按 window*ratio），
  // 但暴露 reserved/effective 字段，并在「剩余窗口已不够摘要」时提前触发压缩。
  const summaryBudget = resolveSummaryTokenBudget(
    {
      maxOutputTokens:
        maxOutputTokens
        ?? providerConfig?.maxOutputTokens
        ?? null,
    },
    { contextWindow: normalizedWindow },
  );
  const summaryOutputReserveTokens = summaryBudget.outputReserveTokens;
  const safetyReserveTokens = summaryBudget.safetyReserveTokens;
  const reservedTokens = summaryOutputReserveTokens + safetyReserveTokens;
  const effectiveWindow =
    normalizedWindow != null
      ? Math.max(1, normalizedWindow - reservedTokens)
      : null;

  const softLimit = normalizedWindow != null ? Math.floor(normalizedWindow * triggerRatio) : null;
  const hardLimit = normalizedWindow != null ? Math.floor(normalizedWindow * hardRatio) : null;
  // 剩余空间不足摘要输出/安全区时，即使未越过 soft 线也建议压缩。
  const summaryHeadroomLimit = effectiveWindow;
  const overSoftLimit = softLimit != null && contextTokens >= softLimit;
  const overSummaryHeadroom =
    summaryHeadroomLimit != null && contextTokens >= summaryHeadroomLimit;
  const overHardLimit = hardLimit != null && contextTokens >= hardLimit;
  const overContextWindow = normalizedWindow != null && contextTokens > normalizedWindow;
  const force = overHardLimit || overContextWindow;
  const emergency = force;
  const shouldCompact = overSoftLimit || overSummaryHeadroom || force;
  const mode = overContextWindow
    ? 'overflow'
    : overHardLimit
      ? 'hard'
      : overSoftLimit
        ? 'soft'
        : 'ok';

  return {
    contextTokens,
    estimatedTokens,
    usageTokens,
    contextSource,
    contextWindow: normalizedWindow,
    effectiveContextWindow: effectiveWindow,
    triggerRatio,
    softLimit,
    hardRatio,
    hardLimit,
    summaryOutputReserveTokens,
    safetyReserveTokens,
    reservedTokens,
    summaryMaxTokens: summaryBudget.summaryMaxTokens,
    summaryMaxInputTokens: summaryBudget.summaryMaxInputTokens,
    overSoftLimit,
    overSummaryHeadroom,
    overHardLimit,
    overContextWindow,
    shouldCompact,
    force,
    emergency,
    mode,
  };
}

/**
 * 压缩后通过既有 Context Source 重建 system prompt（goal/mode/continuity 等权威工作状态）。
 * 失败时回退旧 systemPrompt，不阻断主链路。
 */
export async function rehydrateSystemPromptAfterCompaction({
  systemPrompt,
  rebuildSystemPrompt = null,
  continuityContext = [],
  compactedMessages = null,
  reason = 'post-compact',
} = {}) {
  if (typeof rebuildSystemPrompt !== 'function') {
    return {
      systemPrompt,
      rehydrated: false,
      reason: 'no_rebuild_hook',
    };
  }

  try {
    const next = await rebuildSystemPrompt({
      reason,
      continuityContext,
      compactedMessages,
      previousSystemPrompt: systemPrompt,
    });
    if (typeof next === 'string' && next.trim()) {
      return {
        systemPrompt: next,
        rehydrated: next !== systemPrompt,
        reason,
      };
    }
    return {
      systemPrompt,
      rehydrated: false,
      reason: 'empty_rebuild_result',
    };
  } catch (error) {
    console.warn(
      '[compaction] post-compact system prompt rehydration failed:',
      error?.message || error,
    );
    return {
      systemPrompt,
      rehydrated: false,
      reason: 'rebuild_failed',
      error: error?.message || String(error),
    };
  }
}

// 从 provider 真实 usage 快照折算「上一请求实测输入」。
// 取「最后一轮请求」的 input + cacheRead（不含 output）。
// ⚠️ 必须是「最后一轮快照」而非跨轮累加值（kernel.usage 是 lifetime 累加，用于计费 ledger）。
// ADR 56：该值是 provider 已观测请求的权威输入，不得被本地估算覆盖。
export function contextTokensFromUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const input = Number(snapshot.inputTokens) || 0;
  const cacheRead = Number(snapshot.cacheReadTokens) || 0;
  const total = input + cacheRead;
  return total > 0 ? total : null;
}

async function persistAndNotifyCompaction({
  persistCompaction,
  conversationId,
  compactResult,
  streamId,
  webContents,
  emergency = false,
  manual = false,
  goalPlanStore = null,
  goalCheckpointId = null,
  goalPlanId = null,
}) {
  if (persistCompaction && conversationId) {
    await persistCompaction({
      conversationId,
      compactResult,
      preservePendingAssistant: true,
    });
  }

  // Milestone C: conversation 持久化成功后，才把 Goal checkpoint 标为 compaction persisted。
  // 崩溃在「会话已压、checkpoint 未标」时仍可从 committed checkpoint 恢复。
  if (
    goalPlanStore
    && typeof goalPlanStore.markContextCompactionPersisted === 'function'
    && goalPlanId
    && goalCheckpointId
  ) {
    try {
      const conversationRevision = [
        conversationId || 'conv',
        compactResult?.notification?.method || 'compact',
        goalCheckpointId,
        Date.now(),
      ].join(':');
      goalPlanStore.markContextCompactionPersisted(goalPlanId, {
        checkpointId: goalCheckpointId,
        conversationRevision,
        runnerStatus: 'resuming_after_compaction',
      });
    } catch (error) {
      console.warn(
        '[compaction] markContextCompactionPersisted failed:',
        error?.message || error,
      );
    }
  }

  // 登记表收尾与事件 emit 单一来源：先清登记表再 emit done。
  endCompaction({ conversationId, streamId });
  // Compaction events report lifecycle and compactor diagnostics only. The
  // rebuilt request is counted by ContextAccountingSnapshot after this stage.
  webContents.send('chat:compaction', {
    conversationId,
    streamId,
    stage: 'done',
    emergency,
    ...(manual ? { manual: true } : {}),
    ...compactResult.notification,
    ...(goalPlanId ? { planId: goalPlanId } : {}),
    ...(goalCheckpointId ? { checkpointId: goalCheckpointId } : {}),
  });
}

export async function runCompactionCheck({
  messages,
  systemPrompt,
  contextWindow,
  providerConfig,
  signal,
  persistCompaction,
  conversationId,
  streamId,
  webContents,
  emergency = false,
  force = false,
  // 手动 /compact：强制展示横幅并在全部横幅事件上标记 manual，
  // 使手动路径与自动/紧急路径共用同一入口而不丢 UI 语义。
  manual = false,
  continuityContext = [],
  tools = null,
  preserveLatestUserTurn = false,
  // Goal 模式有界 keep；true 或 partial policy 对象。
  goalKeepPolicy = null,
  // Milestone C: Goal Store 用于压缩前 prepare/commit、压缩后 mark persisted。
  goalPlanStore = null,
  goalPlanId = null,
  usageSnapshot = null,
  runtimeUsageAccounting = null,
  rebuildSystemPrompt = null,
}) {
  // ADR 52：preflight 与 UI 对同一下一请求投影计数。Layer 2 语义压缩仍接收
  // 原始 messages，以便在需要时总结完整历史；预算判断只看 Layer 1 后的发送切片。
  const projectedMessages = applyMicrocompaction(messages, { log: () => {} }).messages;
  const budget = computeContextBudget({
    messages: projectedMessages,
    contextWindow,
    tools,
    usageSnapshot,
    providerConfig,
  });
  // Provider 实测越过 soft 线时必须强制进入 Layer 2；否则 compactIfNeeded 会用
  // 较低的 legacy estimate 重新判定并把这次权威触发吞掉。
  force = Boolean(
    force
    || budget.force
    || (budget.contextSource === 'provider_usage' && budget.shouldCompact),
  );
  emergency = Boolean(emergency || budget.emergency);

  // 压缩时机诊断:在唯一入口打印触发判定的全部输入,便于定位"何时/因何压缩"。
  // path 区分: emergency(provider 报超长或已越过 hard/window) / force(手动 /compact) / threshold(soft 比例越线) / skip。
  {
    const nonSystemCount = messages.filter((m) => m.role !== 'system').length;
    const path = emergency
      ? 'emergency'
      : force
        ? 'force'
        : budget.overSoftLimit
          ? 'threshold'
          : 'skip';
    console.log(
      `[compaction-trigger] path=${path} mode=${budget.mode} est=${budget.estimatedTokens ?? budget.contextTokens}` +
        `${budget.usageTokens != null ? ` usage=${budget.usageTokens}` : ''} ` +
        `tokens=${budget.contextTokens} window=${budget.contextWindow || 'unset'} ` +
        `triggerRatio=${budget.triggerRatio} threshold=${budget.softLimit != null ? Math.round(budget.softLimit) : 'n/a'} ` +
        `hardRatio=${budget.hardRatio} hardLimit=${budget.hardLimit != null ? Math.round(budget.hardLimit) : 'n/a'} ` +
        `overThreshold=${budget.overSoftLimit} overHard=${budget.overHardLimit} overWindow=${budget.overContextWindow} ` +
        `nonSystemMsgs=${nonSystemCount} streamId=${streamId || 'n/a'} conversationId=${conversationId || 'n/a'}`,
    );
  }

  if (!budget.contextWindow && !force) {
    return { compacted: false, messages };
  }


  // Milestone C: Goal 自动压缩前先写 checkpoint（write-ahead）。
  // 仅在 Goal keep 路径启用；普通 chat / 手动 compact 不改语义。
  let activeGoalPlanId = goalPlanId || null;
  let activeGoalCheckpointId = null;
  // 只在真正会进入 Layer2 压缩时写 checkpoint，避免每次 preflight 误写。
  const willAttemptLayer2 = Boolean(force || emergency || budget.shouldCompact);

  // 同会话压缩互斥：同一会话已有其他流在压缩时，跳过本次触发。
  // 并发 summarize + 并发 persist 整写同一会话文件，是"压缩成功却显示失败"的根因。
  // 必须在 beginCompaction/start 横幅之前判定，被跳过的触发不得露出任何压缩 UI。
  if (willAttemptLayer2 && acquireCompactionLock(conversationId, streamId) === 'skipped') {
    console.log(
      `[compaction] skip concurrent trigger conversation=${conversationId} stream=${streamId} (already running)`,
    );
    return { compacted: false, skipped: true, reason: 'compaction_already_running', messages };
  }
  if (
    willAttemptLayer2
    && goalKeepPolicy
    && goalPlanStore
    && typeof goalPlanStore.getActivePlanByConversation === 'function'
    && typeof goalPlanStore.prepareContextCheckpoint === 'function'
    && typeof goalPlanStore.commitContextCheckpoint === 'function'
  ) {
    try {
      const activePlan = activeGoalPlanId
        ? goalPlanStore.getPlan?.(activeGoalPlanId)
        : goalPlanStore.getActivePlanByConversation(conversationId);
      if (activePlan?.planId && activePlan?.status === 'executing') {
        activeGoalPlanId = activePlan.planId;
        let prepared = null;
        const reason = emergency ? 'provider_overflow' : force ? 'hard_threshold' : 'soft_threshold';
        if (typeof goalPlanStore.prepareAndCommitContextCheckpoint === 'function') {
          prepared = goalPlanStore.prepareAndCommitContextCheckpoint(activePlan.planId, {
            reason,
            conversationId,
            streamId,
          });
        } else {
          prepared = goalPlanStore.prepareContextCheckpoint(activePlan.planId, {
            expectedPlanVersion: activePlan.version,
            expectedRunId: activePlan.runner?.runId,
            reason,
            conversationId,
            checkpoint: {
              objectiveNow: activePlan.goal || activePlan.title || 'Continue the active goal',
              currentWork: activePlan.runner?.currentTaskId
                ? `Resume task ${activePlan.runner.currentTaskId}`
                : 'Resume the current executable scene',
              mostImportantFact: activePlan.runner?.currentTaskId
                ? `Current task is ${activePlan.runner.currentTaskId}`
                : 'Continue the active goal after context compaction',
              handoffNote: 'Context is about to compact. Resume from this checkpoint after rehydrate.',
              firstAction: {
                kind: 'inspect',
                instruction: activePlan.runner?.currentTaskId
                  ? `Continue task ${activePlan.runner.currentTaskId} after compaction`
                  : 'Inspect the active goal plan and continue the next runnable task',
                successCheck: 'Task progress or verification evidence is written back with evidenceRefs',
                requiredEvidenceRefs: [],
              },
              progress: activePlan.progress || {
                total: 0,
                completed: 0,
                failed: 0,
                blocked: 0,
                percent: 0,
                nextRunnableTaskIds: [],
              },
            },
          });
          if (prepared?.runner?.contextCheckpoint) {
            prepared = goalPlanStore.commitContextCheckpoint(activePlan.planId, {
              expectedPlanVersion: prepared.version,
              expectedRunId: prepared.runner?.runId,
              checkpoint: prepared.runner.contextCheckpoint,
            });
          }
        }
        activeGoalCheckpointId = prepared?.runner?.contextCheckpoint?.checkpointId || null;
        if (webContents?.send && activeGoalCheckpointId) {
          webContents.send('chat:compaction', {
            conversationId,
            streamId,
            stage: 'checkpointing',
            emergency,
            ...(manual ? { manual: true } : {}),
            planId: activeGoalPlanId,
            checkpointId: activeGoalCheckpointId,
          });
        }
      }
    } catch (error) {
      // Checkpoint prepare failure must not hard-fail ordinary chat compaction.
      console.warn(
        '[compaction] prepare/commit Goal checkpoint failed:',
        error?.message || error,
      );
    }
  }

  const showStart = manual || emergency || shouldShowCompactionStart(messages, budget);
  // 字符级真实进度：仅在展示横幅时构造回调，压缩器流式收摘要时逐 chunk 回调，
  // 转发为 progress 事件。手动与自动路径同源，载荷与节流策略一致。
  let onProgress;
  if (showStart) {
    // 登记表与事件 emit 单一来源：先登记会话压缩态再 emit start，
    // 使切会话查询（chat:compaction:get）与横幅事件流一致。
    beginCompaction({ conversationId, streamId, manual });
    webContents.send('chat:compaction', {
      conversationId,
      streamId,
      stage: 'start',
      emergency,
      ...(manual ? { manual: true } : {}),
    });
    let lastSentPercent = -1;
    let lastSentProgressStage = 'preparing';
    onProgress = ({ receivedChars, estimatedTotalChars, progressStage, attempt, maxAttempts, inputTokenBudget }) => {
      const hasCharacterProgress = Number.isFinite(receivedChars) && Number.isFinite(estimatedTotalChars);
      const total = hasCharacterProgress && estimatedTotalChars > 0 ? estimatedTotalChars : 1;
      const percent = hasCharacterProgress
        ? Math.min(99, Math.round((receivedChars / total) * 100))
        : null;
      const stageChanged = typeof progressStage === 'string' && progressStage !== lastSentProgressStage;
      // 节流：百分比和阶段都无变化时不重复发，减少 IPC 噪声。
      if (!stageChanged && percent === lastSentPercent) return;
      if (typeof progressStage === 'string') lastSentProgressStage = progressStage;
      if (percent !== null) {
        lastSentPercent = percent;
        updateCompactionProgress({ conversationId, streamId, percent });
      }
      webContents.send('chat:compaction', {
        conversationId,
        streamId,
        stage: 'progress',
        emergency,
        ...(manual ? { manual: true } : {}),
        ...(typeof receivedChars === 'number' ? { receivedChars } : {}),
        ...(typeof estimatedTotalChars === 'number' ? { estimatedTotalChars } : {}),
        ...(percent !== null ? { percent } : {}),
        ...(typeof progressStage === 'string' ? { progressStage } : {}),
        ...(Number.isInteger(attempt) ? { attempt } : {}),
        ...(Number.isInteger(maxAttempts) ? { maxAttempts } : {}),
        ...(Number.isFinite(inputTokenBudget) ? { inputTokenBudget } : {}),
      });
    };
  }

  // 横幅去悬挂:一旦发过 start,任何抛错/中断路径都必须收尾为 idle,
  // 否则压缩横幅会一直停留、且会向上抛错导致 sendMessage 卡住停止按钮。
  let settledBanner = !showStart;
  const settleBannerIdle = () => {
    if (settledBanner) return;
    settledBanner = true;
    endCompaction({ conversationId, streamId });
    webContents.send('chat:compaction', {
      conversationId,
      streamId,
      stage: 'idle',
      emergency,
      ...(manual ? { manual: true } : {}),
    });
  };

  try {
    const compactResult = await compactIfNeeded({
      messages,
      systemPrompt,
      contextWindow,
      providerConfig,
      signal,
      force,
      continuityContext,
      onProgress,
      webContents,
      streamId,
      // circuit breaker 按会话隔离(23 号治理文档不变式 6)。
      conversationId,
      tools,
      preserveLatestUserTurn,
      goalKeepPolicy,
      // Provider usage 已在 coordinator 单点决策并转成 force；Layer2 不再二次解释。
      usageTokens: budget.usageTokens,
      onProviderUsage: (usage) => {
        runtimeUsageAccounting?.observeProviderRequest?.(usage, {
          requestPurpose: 'compaction_summary',
          capacityBearing: false,
        });
      },
    });

    if (compactResult.compacted) {
      await persistAndNotifyCompaction({
        persistCompaction,
        conversationId,
        compactResult,
        streamId,
        webContents,
        emergency,
        manual,
        goalPlanStore,
        goalPlanId: activeGoalPlanId,
        goalCheckpointId: activeGoalCheckpointId,
      });
      // done 通知本身即为 start 的收尾。只有持久化与 done 都完成后才标记已结算；
      // 若 persistCompaction 抛错，catch 分支必须还能补发 idle，避免压缩态悬挂。
      settledBanner = true;
      const rehydration = await rehydrateSystemPromptAfterCompaction({
        systemPrompt,
        rebuildSystemPrompt,
        continuityContext,
        compactedMessages: compactResult.messages,
        reason: emergency ? 'post-emergency-compact' : force ? 'post-force-compact' : 'post-compact',
      });
      let messagesOut = compactResult.messages;
      if (rehydration.rehydrated && Array.isArray(messagesOut) && messagesOut[0]?.role === 'system') {
        messagesOut = [
          { ...messagesOut[0], content: rehydration.systemPrompt },
          ...messagesOut.slice(1),
        ];
      }
      return {
        compacted: true,
        messages: messagesOut,
        compactResult,
        systemPrompt: rehydration.systemPrompt,
        rehydrated: rehydration.rehydrated,
        rehydration,
      };
    }

    // Layer 1 微压缩可能已把实际发送上下文压回 soft 线以下，从而取消 Layer 2。
    // 此时 compactResult.compacted=false，但仍必须：
    // 1) 把微压缩后的消息交给上游实际发送；
    // 2) 把「有效上下文」占用回传给 UI，避免圆环继续锁在压缩前高位。
    const effectiveMessages = Array.isArray(compactResult?.messages)
      ? compactResult.messages
      : messages;
    const microApplied = Boolean(
      compactResult?.microcompacted
      || effectiveMessages !== messages,
    );
    if (microApplied && webContents?.send && conversationId) {
      settledBanner = true;
      endCompaction({ conversationId, streamId });
      webContents.send('chat:compaction', {
        conversationId,
        streamId,
        stage: 'idle',
        emergency,
        microcompacted: true,
      });
      return {
        compacted: false,
        messages: effectiveMessages,
        compactResult,
        microcompacted: true,
      };
    }

    settleBannerIdle();
    return { compacted: false, messages: effectiveMessages, compactResult };
  } catch (err) {
    // Failure is a queryable terminal state owned by the main process. Do not immediately erase it
    // with idle; retry, success, or explicit dismissal will replace/clear the registry entry.
    if (webContents?.send && conversationId) {
      settledBanner = true;
      const errorCode = err?.code === 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION'
        ? err.code
        : err?.code || 'CONTEXT_COMPACTION_PERSIST_FAILED';
      const budget = {
        beforeRequestTokens: err?.beforeRequestTokens ?? null,
        minimalCandidateTokens: err?.minimalCandidateTokens ?? null,
        requestTarget: err?.requestTarget ?? null,
      };
      failCompaction({
        conversationId,
        streamId,
        errorCode,
        message: err?.message || 'Context compaction failed.',
        budget,
      });
      webContents.send('chat:compaction', {
        conversationId,
        streamId,
        stage: 'failed',
        errorCode,
        message: err?.message || 'Context compaction failed.',
        budget,
        emergency,
      });
    }
    throw err;
  } finally {
    // 压缩结束（成功/失败/异常）都必须释放会话锁，否则同会话后续压缩会被永久跳过。
    releaseCompactionLock(conversationId, streamId);
  }
}
