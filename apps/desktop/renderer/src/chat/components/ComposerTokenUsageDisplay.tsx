import type React from 'react';
import { useConversationDraft } from '../hooks/useConversationState';
import { resolveContextOccupancyTokens } from '../state/contextOccupancy';
import { estimateDraftTokens } from '../state/tokenEstimate';
import type { ChatAttachment, TokenUsageState } from '../state/types';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'contextTokens' | 'triggerTokens'> & {
  readonly conversationId: string | null;
  readonly historyContextTokens: number;
  readonly attachments: readonly ChatAttachment[];
  /** 实际发送上下文权威快照（主圆环）。 */
  readonly authoritativeContextTokens?: number | null;
  /** 压缩触发压力权威快照（tooltip）。 */
  readonly authoritativeTriggerTokens?: number | null;
  readonly activeUsage?: TokenUsageState | null;
};

/**
 * 只在工具栏叶子中订阅高频草稿变化。
 *
 * ChatSurface 负责低频的历史消息估算与权威双口径快照；这里仅叠加当前草稿和附件，
 * 避免每输入一个字符都重新执行整棵消息表面及虚拟列表的渲染逻辑。
 *
 * 双口径：
 * - 主圆环：实际上下文占用（contextTokens = 权威发送量 + 草稿；可被本轮 streaming input 抬升）。
 * - tooltip 压缩压力：triggerTokens（权威 trigger + 草稿；至少不低于主圆环）。
 * - 绝不用 lifetime 计费累计充当上下文。
 */
export function ComposerTokenUsageDisplay({
  conversationId,
  historyContextTokens,
  attachments,
  authoritativeContextTokens = null,
  authoritativeTriggerTokens = null,
  activeUsage = null,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const draft = useConversationDraft(conversationId);
  const draftContextTokens = estimateDraftTokens(draft, attachments);
  // activeUsage 是本轮流式 usage；仅取输入侧作为可选抬升，不混入 output / lifetime。
  const streamingInputTokens =
    activeUsage != null
      ? Math.max(0, (activeUsage.input ?? 0) + (activeUsage.cacheRead ?? 0))
      : null;
  const contextTokens = resolveContextOccupancyTokens({
    authoritativeContextTokens,
    historyContextTokens,
    draftContextTokens,
    streamingInputTokens,
  });
  const triggerBase =
    typeof authoritativeTriggerTokens === 'number' && Number.isFinite(authoritativeTriggerTokens)
      ? Math.max(0, authoritativeTriggerTokens)
      : null;
  const triggerTokens = Math.max(
    contextTokens,
    triggerBase != null ? triggerBase + draftContextTokens : contextTokens,
  );

  return (
    <TokenUsageDisplay
      {...props}
      activeUsage={activeUsage}
      contextTokens={contextTokens}
      triggerTokens={triggerTokens}
    />
  );
}
