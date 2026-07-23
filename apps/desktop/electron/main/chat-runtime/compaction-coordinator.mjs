import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  estimateToolsTokens,
  microcompactMessagesForContext,
  resolveSummaryTokenBudget,
} from '../context-compactor.mjs';
import { beginCompaction, endCompaction, updateCompactionProgress } from './compaction-registry.mjs';

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

export function isPromptTooLongResponse(status, text) {
  if (status === 413) return true;
  const value = String(text || '').toLowerCase();
  return (
    value.includes('prompt_too_long') ||
    value.includes('context_length_exceeded') ||
    value.includes('maximum context length') ||
    value.includes('context window') ||
    value.includes('context too long') ||
    value.includes('input is too long') ||
    value.includes('exceeds model context') ||
    value.includes('too many tokens') ||
    value.includes('token limit')
  );
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

// 发送前预算守卫（方案 A 最小闭环）：soft 线沿用既有自动压缩触发线，hard 线
// 是 provider 请求前的硬拦截线。方案 C 的完整 Context Budget Manager 会把这里抽象为
// 跨 provider 的预算规划器；本轮只在 coordinator 内集中计算，避免扩大 adapter 改动面。
export const CONTEXT_BUDGET_GUARD = Object.freeze({
  hardRatio: 0.95,
});

export function computeContextBudget({
  messages,
  contextWindow,
  tools = null,
  usageSnapshot = null,
  // 可选：providerConfig 用于解析摘要输出预算；也可直接传 maxOutputTokens。
  providerConfig = null,
  maxOutputTokens = null,
}) {
  // ADR 52：预算只统计下一次最终请求投影。调用方负责传入经过 provider 清洗与
  // microcompaction 后会真正发送的 messages；tools schema 也属于每次请求输入。
  // 上一次 provider usage 仅保留为诊断/校准信息，不得把下一请求预算锁在历史高水位。
  const estimatedTokens =
    estimateTokensFromMessages(Array.isArray(messages) ? messages : []) +
    estimateToolsTokens(tools);
  const usageTokens = contextTokensFromUsageSnapshot(usageSnapshot);
  const contextTokens = estimatedTokens;
  const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const triggerRatio = COMPACTION_CONFIG.triggerRatio;
  const hardRatio = Math.max(triggerRatio, CONTEXT_BUDGET_GUARD.hardRatio);

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
  const overSoftLimit = softLimit != null && contextTokens > softLimit;
  const overSummaryHeadroom =
    summaryHeadroomLimit != null && contextTokens > summaryHeadroomLimit;
  const overHardLimit = hardLimit != null && contextTokens > hardLimit;
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

// 从 provider 真实 usage 快照折算「实际发送的上下文 token」。
// 取「最后一轮请求」的 input + cacheRead（不含 output），这正是 provider 计入的输入上下文大小。
// ⚠️ 必须是「最后一轮快照」而非跨轮累加值（kernel.usage 是 lifetime 累加，用于计费 ledger，
// 不能当上下文大小用）。无可用快照时返回 null，由上层回退到发送切片估算。
export function contextTokensFromUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const input = Number(snapshot.inputTokens) || 0;
  const cacheRead = Number(snapshot.cacheReadTokens) || 0;
  const total = input + cacheRead;
  return total > 0 ? total : null;
}

// 口径（ADR 42 数据面；UI 主圆环消费 contextTokens，压缩触发与 tooltip 消费 triggerTokens）：
// - 实际发送口径（contextTokens）：表示「本回合实际发送给模型的上下文大小」，取值优先级：
//     1) provider 真实 usage 快照（最后一轮 input + cacheRead）；
//     2) 回退为对「实际发送切片 displayMessages」的估算；
//     3) 再回退为对完整会话 messages 的估算（兼容未传 displayMessages 的旧调用）。
// - 压缩压力口径（compactionSuggested / triggerTokens）：与 preflight 一致，取
//   max(完整会话本地估算, usage 快照)。有真实 usage 高水位时必须建议压缩，
//   避免实际输入已满但自动压缩不跑；无 usage 时仍退回本地估算。
// - 分母口径（contextWindow）：与触发判定同一 normalizedWindow，不变。
export function computeContextInfo({
  messages,
  contextWindow,
  tools = null,
  displayMessages = null,
  usageSnapshot = null,
}) {
  // ADR 52：先形成下一次最终请求投影。调用方若已经持有 provider 最终发送切片，
  // 通过 displayMessages 传入；否则按所有 provider 共享的 Layer 1 规则投影。
  const projectedMessages = Array.isArray(displayMessages)
    ? displayMessages
    : applyMicrocompaction(Array.isArray(messages) ? messages : [], { log: () => {} }).messages;
  const budget = computeContextBudget({
    messages: projectedMessages,
    contextWindow,
    tools,
    usageSnapshot,
  });

  return {
    // ADR 52：下一次最终请求预计输入是唯一上下文占用口径。
    nextRequestInputTokens: budget.contextTokens,
    contextWindow: budget.contextWindow,
    triggerRatio: budget.triggerRatio,
    compactionSuggested: budget.overSoftLimit,
    // 上一次 provider 实测只用于诊断，不参与当前占用或压缩判断。
    lastActualInputTokens: contextTokensFromUsageSnapshot(usageSnapshot),
  };
}

async function persistAndNotifyCompaction({
  persistCompaction,
  conversationId,
  compactResult,
  streamId,
  webContents,
  emergency = false,
  contextWindow = null,
  tools = null,
}) {
  // 压缩后的真实请求消息和工具 schema 共同构成下一次最终请求投影。
  // 必须先算出投影并随消息一起持久化，确保共享快照绑定 replaceMessages 产生的新 revision。
  const compactedBudget = computeContextBudget({
    messages: compactResult.messages,
    contextWindow,
    tools,
  });
  if (persistCompaction && conversationId) {
    await persistCompaction({
      conversationId,
      compactResult,
      preservePendingAssistant: true,
      requestProjection: {
        nextRequestInputTokens: compactedBudget.contextTokens,
        contextWindow: compactedBudget.contextWindow,
      },
    });
  }
  // 登记表收尾与事件 emit 单一来源：先清登记表再 emit done。
  endCompaction({ conversationId, streamId });
  // notification.afterTokens 仅覆盖 system + messages；工具 schema 同样会在每次
  // 请求全量发送，因此完成事件要沿用预算器口径给出可直接投影的完整快照。
  webContents.send('chat:compaction', {
    conversationId,
    streamId,
    stage: 'done',
    emergency,
    ...compactResult.notification,
    nextRequestInputTokens: compactedBudget.contextTokens,
    contextWindow: compactedBudget.contextWindow,
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
  continuityContext = [],
  tools = null,
  preserveLatestUserTurn = false,
  usageSnapshot = null,
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
  force = Boolean(force || budget.force);
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

  const showStart = emergency || shouldShowCompactionStart(messages, budget);
  // 字符级真实进度：仅在展示横幅时构造回调，压缩器流式收摘要时逐 chunk 回调，
  // 转发为 progress 事件。载荷与节流策略与手动 /compact 路径（main.mjs）保持一致。
  let onProgress;
  if (showStart) {
    // 登记表与事件 emit 单一来源：先登记会话压缩态再 emit start，
    // 使切会话查询（chat:compaction:get）与横幅事件流一致。
    beginCompaction({ conversationId, streamId, manual: false });
    webContents.send('chat:compaction', { conversationId, streamId, stage: 'start', emergency });
    let lastSentPercent = -1;
    onProgress = ({ receivedChars, estimatedTotalChars }) => {
      const total = estimatedTotalChars > 0 ? estimatedTotalChars : 1;
      const percent = Math.min(99, Math.round((receivedChars / total) * 100));
      // 节流：百分比无变化时不重复发，减少 IPC 噪声。
      if (percent === lastSentPercent) return;
      lastSentPercent = percent;
      updateCompactionProgress({ conversationId, streamId, percent });
      webContents.send('chat:compaction', {
        conversationId,
        streamId,
        stage: 'progress',
        emergency,
        receivedChars,
        estimatedTotalChars,
        percent,
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
    webContents.send('chat:compaction', { conversationId, streamId, stage: 'idle', emergency });
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
      tools,
      preserveLatestUserTurn,
      usageTokens: budget.usageTokens,
    });

    if (compactResult.compacted) {
      await persistAndNotifyCompaction({
        persistCompaction,
        conversationId,
        compactResult,
        streamId,
        webContents,
        emergency,
        contextWindow,
        tools,
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
      const effectiveInfo = computeContextInfo({
        messages: effectiveMessages,
        contextWindow,
        tools,
        displayMessages: effectiveMessages,
        // 计算 Layer 1 后的有效发送量：忽略上一轮高水位 usage，避免旧快照锁死新预算。
        usageSnapshot: null,
      });
      settledBanner = true;
      endCompaction({ conversationId, streamId });
      webContents.send('chat:compaction', {
        conversationId,
        streamId,
        stage: 'idle',
        emergency,
        nextRequestInputTokens: effectiveInfo.nextRequestInputTokens,
        contextWindow: effectiveInfo.contextWindow,
        microcompacted: true,
      });
      return {
        compacted: false,
        messages: effectiveMessages,
        compactResult,
        microcompacted: true,
        nextRequestInputTokens: effectiveInfo.nextRequestInputTokens,
        contextWindow: effectiveInfo.contextWindow,
      };
    }

    settleBannerIdle();
    return { compacted: false, messages: effectiveMessages, compactResult };
  } catch (err) {
    // 压缩失败不应静默吞掉:收尾横幅后继续抛出,交由上游统一的终态兜底处理。
    settleBannerIdle();
    throw err;
  }
}
