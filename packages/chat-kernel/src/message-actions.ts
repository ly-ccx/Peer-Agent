import type { ConversationView, MessageActions, MessageNodeOrigin, MessageRole } from '@peer-agent/protocol';

export function computeMessageActions(params: {
  readonly role: MessageRole | 'gap' | string;
  readonly hasContent: boolean;
  readonly streaming: boolean;
  readonly origin: MessageNodeOrigin;
  readonly view: ConversationView;
}): MessageActions {
  const isGap = params.role === 'gap';

  return {
    copy: params.hasContent && !isGap,
    regenerate:
      params.role === 'assistant' &&
      !params.streaming &&
      params.origin === 'live' &&
      params.view.capabilities.canEdit,
    delete:
      params.role === 'user' &&
      !params.streaming &&
      params.origin === 'live' &&
      params.view.capabilities.canEdit,
    branch: !isGap && params.view.capabilities.canBranch,
    snapshot: !isGap,
  };
}
