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
 */
export function ComposerTokenUsageDisplay({
  conversationId,
  historyContextTokens,
  attachments,
  authoritativeContextTokens,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const draft = useConversationDraft(conversationId);
  const draftContextTokens = estimateDraftTokens(draft, attachments);
  const localContextTokens = historyContextTokens + draftContextTokens;
  const authoritativeWithDraft = (authoritativeContextTokens ?? 0) + draftContextTokens;
  const contextTokens = Math.max(authoritativeWithDraft, localContextTokens);

  return <TokenUsageDisplay {...props} contextTokens={contextTokens} />;
}
