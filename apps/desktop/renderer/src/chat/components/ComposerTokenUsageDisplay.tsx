import type React from 'react';
import { useConversationDraft } from '../hooks/useConversationState';
import { resolveContextOccupancyTokens } from '../state/contextOccupancy';
import { estimateDraftTokens } from '../state/tokenEstimate';
import type { ChatAttachment } from '../state/types';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'nextRequestInputTokens'> & {
  readonly conversationId: string | null;
  readonly historyContextTokens: number;
  readonly contextReady: boolean;
  readonly attachments: readonly ChatAttachment[];
  readonly authoritativeNextRequestInputTokens?: number | null;
};

/** 高频草稿变化只在工具栏叶子中叠加；历史投影由 Runtime 快照提供。 */
export function ComposerTokenUsageDisplay({
  conversationId,
  historyContextTokens,
  contextReady,
  attachments,
  authoritativeNextRequestInputTokens = null,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const draft = useConversationDraft(conversationId);
  const draftContextTokens = estimateDraftTokens(draft, attachments);
  const nextRequestInputTokens = resolveContextOccupancyTokens({
    authoritativeNextRequestInputTokens,
    historyContextTokens,
    draftContextTokens,
    contextReady,
  });

  return (
    <TokenUsageDisplay
      {...props}
      nextRequestInputTokens={nextRequestInputTokens ?? undefined}
    />
  );
}
