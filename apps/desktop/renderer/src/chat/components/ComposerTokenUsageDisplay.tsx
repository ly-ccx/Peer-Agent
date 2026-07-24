import type React from 'react';
import { useConversationDraft, useConversationStreamPreviewTokens } from '../hooks/useConversationState';
import { resolveContextOccupancyTokens } from '../state/contextOccupancy';
import { estimateDraftTokens } from '../state/tokenEstimate';
import type { ChatAttachment } from '../state/types';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'nextRequestInputTokens'> & {
  readonly conversationId: string | null;
  readonly contextReady: boolean;
  readonly attachments: readonly ChatAttachment[];
  readonly authoritativeNextRequestInputTokens?: number | null;
};

/** 高频草稿与流式预览变化只在工具栏叶子中叠加；历史投影由 Runtime 快照提供。 */
export function ComposerTokenUsageDisplay({
  conversationId,
  contextReady,
  attachments,
  authoritativeNextRequestInputTokens = null,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const draft = useConversationDraft(conversationId);
  const streamPreviewTokens = useConversationStreamPreviewTokens(conversationId);
  const draftContextTokens = estimateDraftTokens(draft, attachments);
  const nextRequestInputTokens = resolveContextOccupancyTokens({
    authoritativeNextRequestInputTokens,
    draftContextTokens,
    streamPreviewTokens,
    contextReady,
  });

  return (
    <TokenUsageDisplay
      {...props}
      nextRequestInputTokens={nextRequestInputTokens ?? undefined}
    />
  );
}
