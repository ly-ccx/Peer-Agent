import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  estimateToolsTokens,
  microcompactMessagesForContext,
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

export function computeContextBudget({ messages, contextWindow, tools = null }) {
  // 工具 schema（tools）每次请求都全量发送给 provider，必须计入上下文用量；
  // 否则进度条只算 messages，会远低于 provider 实际计入的 input tokens。
  const contextTokens =
    estimateTokensFromMessages(Array.isArray(messages) ? messages : []) +
    estimateToolsTokens(tools);
  const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const triggerRatio = COMPACTION_CONFIG.triggerRatio;
  const hardRatio = Math.max(triggerRatio, CONTEXT_BUDGET_GUARD.hardRatio);
  const softLimit = normalizedWindow ? Math.floor(normalizedWindow * triggerRatio) : null;
  const hardLimit = normalizedWindow ? Math.floor(normalizedWindow * hardRatio) : null;
  const overSoftLimit = softLimit != null && contextTokens > softLimit;
  const overHardLimit = hardLimit != null && contextTokens > hardLimit;
  const overContextWindow = normalizedWindow != null && contextTokens > normalizedWindow;
  const force = overHardLimit || overContextWindow;
  const emergency = force;
  const shouldCompact = overSoftLimit || force;
  const mode = overContextWindow
    ? 'overflow'
    : overHardLimit
      ? 'hard'
      : overSoftLimit
        ? 'soft'
        : 'ok';

  return {
    contextTokens,
    contextWindow: normalizedWindow,
    triggerRatio,
    softLimit,
    hardRatio,
    hardLimit,
    overSoftLimit,
    overHardLimit,
    overContextWindow,
    shouldCompact,
    force,
    emergency,
    mode,
  };
}

// 口径统一单一来源：进度条用量、压缩触发判定都从这里取数，避免「进度条到 80%
// 但主进程不压缩」这类两套估算打架的偏差。contextTokens 用与压缩触发完全相同的
// estimateTokensFromMessages（含图片固定 token、tool 块 JSON 体积、每条 +overhead），
// compactionSuggested 用与发送前预算守卫完全相同的 soft 阈值。
export function computeContextInfo({ messages, contextWindow, tools = null }) {
  const budget = computeContextBudget({ messages, contextWindow, tools });
  return {
    contextTokens: budget.contextTokens,
    contextWindow: budget.contextWindow,
    triggerRatio: budget.triggerRatio,
    compactionSuggested: budget.overSoftLimit,
  };
}

async function persistAndNotifyCompaction({
  persistCompaction,
  conversationId,
  compactResult,
  streamId,
  webContents,
  emergency = false,
}) {
  if (persistCompaction && conversationId) {
    await persistCompaction({ conversationId, compactResult, preservePendingAssistant: true });
  }
  // 登记表收尾与事件 emit 单一来源：先清登记表再 emit done。
  endCompaction({ conversationId, streamId });
  webContents.send('chat:compaction', { streamId, stage: 'done', emergency, ...compactResult.notification });
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
}) {
  const budget = computeContextBudget({ messages, contextWindow, tools });
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
      `[compaction-trigger] path=${path} mode=${budget.mode} est=${budget.contextTokens} window=${budget.contextWindow || 'unset'} ` +
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
    webContents.send('chat:compaction', { streamId, stage: 'start', emergency });
    let lastSentPercent = -1;
    onProgress = ({ receivedChars, estimatedTotalChars }) => {
      const total = estimatedTotalChars > 0 ? estimatedTotalChars : 1;
      const percent = Math.min(99, Math.round((receivedChars / total) * 100));
      // 节流：百分比无变化时不重复发，减少 IPC 噪声。
      if (percent === lastSentPercent) return;
      lastSentPercent = percent;
      updateCompactionProgress({ conversationId, streamId, percent });
      webContents.send('chat:compaction', {
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
    webContents.send('chat:compaction', { streamId, stage: 'idle', emergency });
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
    });

    if (compactResult.compacted) {
      // done 通知本身即为 start 的收尾,标记 banner 已结算,避免再补发 idle。
      settledBanner = true;
      await persistAndNotifyCompaction({
        persistCompaction,
        conversationId,
        compactResult,
        streamId,
        webContents,
        emergency,
      });
      return { compacted: true, messages: compactResult.messages, compactResult };
    }

    settleBannerIdle();
    return { compacted: false, messages };
  } catch (err) {
    // 压缩失败不应静默吞掉:收尾横幅后继续抛出,交由上游统一的终态兜底处理。
    settleBannerIdle();
    throw err;
  }
}
