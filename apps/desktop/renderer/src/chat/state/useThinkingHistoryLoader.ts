import { hydrateThinkingProcessFromBackend } from '@zeus-atlas/chat-kernel';
import type { ChatMessage, ThinkingProcess } from '@zeus-atlas/protocol';
import { useCallback, useRef, useState } from 'react';
import { chatClient } from '../api/chatClient';

/**
 * 切换会话后历史消息的 thinkingProcess 由后端 list 接口轻量返回（去掉了
 * stepsData，详见 cbu-xiaoer-node-service aiChatMessage.ts:703），iterations
 * 为空 → ThinkingTimeline 渲染「暂无可展开的思考或工具事件」。
 *
 * 本 hook 在用户展开 details 时按 messageId 调 by-message includeFull=true
 * 拉完整 stepsData，再走 hydrateThinkingProcessFromBackend 归一成前端
 * ThinkingProcess（含 iterations + toolCards）。结果缓存到内存，同一消息
 * 不重复拉取。
 */
export function useThinkingHistoryLoader() {
  const [version, setVersion] = useState(0);
  const cacheRef = useRef<Map<number, ThinkingProcess>>(new Map());
  const loadingRef = useRef<Set<number>>(new Set());
  const errorRef = useRef<Map<number, string>>(new Map());

  const bumpVersion = useCallback(() => {
    // 用版本号触发 re-render；不放具体数据进 state 避免 Map 引用相等导致的更新丢失
    setVersion((v) => v + 1);
  }, []);

  const hydrate = useCallback(
    async (messageId: number): Promise<void> => {
      if (!Number.isFinite(messageId) || messageId <= 0) return;
      if (cacheRef.current.has(messageId)) return;
      if (loadingRef.current.has(messageId)) return;

      loadingRef.current.add(messageId);
      errorRef.current.delete(messageId);
      bumpVersion();

      try {
        const data = (await chatClient.getThinkingByMessage({
          messageId,
          includeFull: true,
        })) as unknown as {
          process?: Record<string, unknown> | null;
          stepsData?: Parameters<typeof hydrateThinkingProcessFromBackend>[0]['stepsData'];
        };

        const hydrated = hydrateThinkingProcessFromBackend({
          process: data?.process,
          stepsData: data?.stepsData,
        });
        cacheRef.current.set(messageId, hydrated);
      } catch (error) {
        errorRef.current.set(
          messageId,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        loadingRef.current.delete(messageId);
        bumpVersion();
      }
    },
    [bumpVersion],
  );

  const getCached = useCallback(
    (messageId: number | undefined): ThinkingProcess | undefined => {
      if (!Number.isFinite(messageId as number)) return undefined;
      // 读 cacheRef 时附带订阅 version，避免 React 跳过同一 Map 引用的 re-render
      void version;
      return cacheRef.current.get(messageId as number);
    },
    [version],
  );

  const isLoading = useCallback(
    (messageId: number | undefined): boolean => {
      if (!Number.isFinite(messageId as number)) return false;
      void version;
      return loadingRef.current.has(messageId as number);
    },
    [version],
  );

  const getError = useCallback(
    (messageId: number | undefined): string | undefined => {
      if (!Number.isFinite(messageId as number)) return undefined;
      void version;
      return errorRef.current.get(messageId as number);
    },
    [version],
  );

  return { hydrate, getCached, isLoading, getError };
}

/**
 * 检查 message 的当前 thinkingProcess 是否需要从后端 hydrate：
 * - 没有 iterations 字段或是空数组（list 接口给的轻量元数据）
 * - 元数据声明有 toolCount/totalToolCalls > 0 或 totalIterations > 0，说明
 *   实际有内容但当前没渲染出来。若元数据本身就是 0，hydrate 也没意义
 */
export function needsThinkingHydration(message: ChatMessage): boolean {
  const tp = message.thinkingProcess;
  if (!tp) return false;
  // 已经有 iterations（流式构造或已 hydrate 过）→ 不需要再拉
  const hasIterations = Array.isArray(tp.iterations) && tp.iterations.length > 0;
  if (hasIterations) return false;

  // 后端 list 接口 strip 了 stepsData，返回的 thinkingProcess 只有元数据。
  // 只要这是一条真实存在的 thinking_process（有 processUuid / executionUuid），
  // 就该 hydrate——不能靠 totalToolCalls/totalIterations 判断，因为纯思考型
  // 回复（有 LLM 调用但没工具调用）这俩都是 0/undefined，会漏掉。
  // 这正是「切到其他会话再切回来 thinking 过程空白」的根因。
  const meta = tp as unknown as Record<string, unknown>;
  return Boolean(
    tp.processUuid ||
      tp.executionUuid ||
      meta.totalSteps ||
      meta.totalLlmCalls ||
      tp.totalToolCalls ||
      tp.totalIterations,
  );
}
