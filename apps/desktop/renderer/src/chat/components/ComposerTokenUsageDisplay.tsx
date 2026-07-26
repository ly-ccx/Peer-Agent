import type React from 'react';
import { useConversationContextAccounting } from '../hooks/useConversationState';
import { TokenUsageDisplay } from './thread/TokenUsageDisplay';

type TokenUsageDisplayProps = React.ComponentProps<typeof TokenUsageDisplay>;

type ComposerTokenUsageDisplayProps = Omit<TokenUsageDisplayProps, 'contextAccounting'> & {
  readonly conversationId: string | null;
};

/** Renderer does not estimate draft/stream tokens; it renders the shared snapshot verbatim. */
export function ComposerTokenUsageDisplay({
  conversationId,
  ...props
}: ComposerTokenUsageDisplayProps) {
  const contextAccounting = useConversationContextAccounting(conversationId);

  return (
    <TokenUsageDisplay
      {...props}
      contextAccounting={contextAccounting}
      emptyContext={conversationId == null}
    />
  );
}
