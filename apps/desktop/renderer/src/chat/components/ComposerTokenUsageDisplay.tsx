import type React from 'react';
import { useConversationDraft } from '../hooks/useConversationState';
import { estimateDraftTokens } from '../state/tokenEstimate';
import type { ChatAttachment } from '../state/types';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'contextTokens'> & {
  readonly conversationId: string | null;
  readonly historyContextTokens: number;
  readonly attachments: readonly ChatAttachment[];
  readonly authoritativeContextTokens?: number | null;
};

/**
 * 只在工具栏叶子中订阅高频草稿变化。
 *
 * ChatSurface 负责低频的历史消息估算与权威上下文快照；这里仅叠加当前草稿和附件，
 * 避免每输入一个字符都重新执行整棵消息表面及虚拟列表的渲染逻辑。
 *
 * 占用显示口径：
 * - 有运行时权威有效上下文（stream done / 微压缩 idle 上报）时，优先采用它 + 草稿增量。
 *   这样 87% 经静默 microcompaction 后能回落到实际发送量，而不会被本地完整历史 max 锁死。
 * - 无权威快照时，回退到本地历史估算 + 草稿增量。
 */
export function ComposerTokenUsageDisplay({
  conversationId,
  historyContextTokens,
  attachments,
  authoritativeContextTokens = null,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const draft = useConversationDraft(conversationId);
  const draftContextTokens = estimateDraftTokens(draft, attachments);
  const localContextTokens = historyContextTokens + draftContextTokens;
  const hasAuthoritative =
    typeof authoritativeContextTokens === 'number' && Number.isFinite(authoritativeContextTokens);
  const contextTokens = hasAuthoritative
    ? Math.max(0, authoritativeContextTokens + draftContextTokens)
    : localContextTokens;

  return <TokenUsageDisplay {...props} contextTokens={contextTokens} />;
}
