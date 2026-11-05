import type React from 'react';
import {
  useConversationActiveUsage,
  useConversationContextAccounting,
} from '../hooks/useConversationState';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'contextAccounting' | 'activeUsage'> & {
  readonly conversationId: string | null;
};

/** Renderer does not estimate draft/stream tokens; it renders the shared snapshot verbatim. */
export function ComposerTokenUsageDisplay({
  conversationId,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const contextAccounting = useConversationContextAccounting(conversationId);
  const activeUsage = useConversationActiveUsage(conversationId);

  return (
    <TokenUsageDisplay
      {...props}
      activeUsage={activeUsage}
      contextAccounting={contextAccounting}
      emptyContext={conversationId == null}
    />
  );
}
