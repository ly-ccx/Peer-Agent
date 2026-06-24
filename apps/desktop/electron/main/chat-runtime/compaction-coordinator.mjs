import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  microcompactMessagesForContext,
} from '../context-compactor.mjs';
import { beginCompaction, endCompaction } from './compaction-registry.mjs';

export function isPromptTooLongResponse(status, text) {
  if (status === 413) return true;
  const value = String(text || '').toLowerCase();
  return (
    value.includes('prompt_too_long') ||
    value.includes('context_length_exceeded') ||
    value.includes('maximum context length') ||
    value.includes('too many tokens') ||
    value.includes('token limit')
  );
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

function shouldShowCompactionStart(messages, contextWindow) {
  if (!contextWindow) return false;
  return estimateTokensFromMessages(messages) > contextWindow * COMPACTION_CONFIG.triggerRatio;
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
}) {
  // 压缩时机诊断:在唯一入口打印触发判定的全部输入,便于定位"何时/因何压缩"。
  // path 区分: emergency(provider 报超长) / force(手动 /compact) / threshold(比例越线) / skip。
  {
    const estimatedTokens = estimateTokensFromMessages(messages);
    const threshold = contextWindow ? contextWindow * COMPACTION_CONFIG.triggerRatio : null;
    const overThreshold = threshold != null && estimatedTokens > threshold;
    const nonSystemCount = messages.filter((m) => m.role !== 'system').length;
    const path = emergency
      ? 'emergency'
      : force
        ? 'force'
        : overThreshold
          ? 'threshold'
          : 'skip';
    console.log(
      `[compaction-trigger] path=${path} est=${estimatedTokens} window=${contextWindow || 'unset'} ` +
        `triggerRatio=${COMPACTION_CONFIG.triggerRatio} threshold=${threshold != null ? Math.round(threshold) : 'n/a'} ` +
        `overThreshold=${overThreshold} nonSystemMsgs=${nonSystemCount} ` +
        `streamId=${streamId || 'n/a'} conversationId=${conversationId || 'n/a'}`,
    );
  }

  if (!contextWindow && !force) {
    return { compacted: false, messages };
  }

  const showStart = emergency || shouldShowCompactionStart(messages, contextWindow);
  if (showStart) {
    // 登记表与事件 emit 单一来源：先登记会话压缩态再 emit start，
    // 使切会话查询（chat:compaction:get）与横幅事件流一致。
    beginCompaction({ conversationId, streamId, manual: false });
    webContents.send('chat:compaction', { streamId, stage: 'start', emergency });
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
