import type React from 'react';
import { useConversationDraft } from '../hooks/useConversationState';
import { resolveContextOccupancyTokens } from '../state/contextOccupancy';
import { estimateDraftTokens } from '../state/tokenEstimate';
import type { ChatAttachment, TokenUsageState } from '../state/types';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'contextTokens'> & {
  readonly conversationId: string | null;
  readonly historyContextTokens: number;
  readonly attachments: readonly ChatAttachment[];
  readonly authoritativeContextTokens?: number | null;
  readonly activeUsage?: TokenUsageState | null;
};

/**
 * 只在工具栏叶子中订阅高频草稿变化。
 *
 * ChatSurface 负责低频的历史消息估算与权威上下文快照；这里仅叠加当前草稿和附件，
 * 避免每输入一个字符都重新执行整棵消息表面及虚拟列表的渲染逻辑。
 *
 * 占用显示口径（contextOccupancy）：
 * - 有运行时权威有效上下文（stream done / 发送种子 / 微压缩 idle）时，优先采用它 + 草稿增量。
 * - 流式阶段仅可用本轮 activeUsage 的 input+cacheRead 抬升，绝不用 lifetime 计费累计。
 * - 无权威快照时，回退到本地历史估算 + 草稿增量。
 */
export function ComposerTokenUsageDisplay({
  conversationId,
  historyContextTokens,
  attachments,
  authoritativeContextTokens = null,
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

  return <TokenUsageDisplay {...props} activeUsage={activeUsage} contextTokens={contextTokens} />;
}
