import type { Conversation, ConversationChannel, ConversationChannelFilter } from '@zeus-atlas/protocol';

export const CHANNEL_FILTERS = [
  'all',
  'web',
  'dingtalk',
  'dingtalk-direct',
  'dingtalk-group',
  'roundtable',
  'automation',
  'share',
] as const satisfies readonly ConversationChannelFilter[];

export type ResolvedConversationChannel = Exclude<ConversationChannelFilter, 'all'>;

function metadataRecord(conversation: Conversation): Record<string, unknown> {
  return conversation.metadata ?? {};
}

function channelType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return undefined;
}

function isRoundtableConversation(conversation: Conversation): boolean {
  return Array.isArray(conversation.metadata?.roundtable?.participants) &&
    conversation.metadata.roundtable.participants.length > 0;
}

function isAutomationConversation(conversation: Conversation): boolean {
  const metadata = metadataRecord(conversation);
  const type = channelType(metadata.channel);
  return Boolean(
    metadata.agentCron ||
      metadata.source === 'cron' ||
      metadata.channel === 'cron' ||
      type === 'automation' ||
      type === 'cron',
  );
}

function isDingTalkConversation(conversation: Conversation): boolean {
  const metadata = metadataRecord(conversation);
  const type = channelType(metadata.channel);
  return Boolean(
    metadata.dingtalk ||
      metadata.source === 'dingtalk' ||
      metadata.sourcePlatform === 'dingtalk' ||
      metadata.channel === 'dingtalk' ||
      type === 'dingtalk' ||
      (metadata.sourceMetadata as { openConversationId?: unknown } | undefined)?.openConversationId,
  );
}

function isDingTalkGroupConversation(conversation: Conversation): boolean {
  const dingtalk = conversation.metadata?.dingtalk;
  return dingtalk?.conversationScope === 'agent_group_conversation' || dingtalk?.conversationType === '2';
}

export function resolveConversationChannel(conversation: Conversation): ResolvedConversationChannel {
  if (isRoundtableConversation(conversation)) return 'roundtable';
  if (isAutomationConversation(conversation)) return 'automation';
  if (conversation.channel === 'share') return 'share';
  if (isDingTalkConversation(conversation)) {
    return isDingTalkGroupConversation(conversation) ? 'dingtalk-group' : 'dingtalk-direct';
  }
  if (conversation.channel === 'dingtalk-direct' || conversation.channel === 'dingtalk-group') {
    return conversation.channel;
  }
  return conversation.channel === 'automation' || conversation.channel === 'roundtable' ? conversation.channel : 'web';
}

export function matchesChannelFilter(
  conversation: Conversation,
  filter: ConversationChannelFilter,
): boolean {
  if (filter === 'all') return true;
  const resolved = resolveConversationChannel(conversation);
  if (filter === 'dingtalk') {
    return resolved === 'dingtalk-direct' || resolved === 'dingtalk-group';
  }
  return resolved === filter;
}

export function countConversationsByChannel(
  conversations: readonly Conversation[],
): Record<ConversationChannelFilter, number> {
  const counts: Record<ConversationChannelFilter, number> = {
    all: conversations.length,
    web: 0,
    dingtalk: 0,
    'dingtalk-direct': 0,
    'dingtalk-group': 0,
    roundtable: 0,
    automation: 0,
    share: 0,
  };

  for (const conversation of conversations) {
    const channel = resolveConversationChannel(conversation);
    counts[channel] += 1;
    if (channel === 'dingtalk-direct' || channel === 'dingtalk-group') {
      counts.dingtalk += 1;
    }
  }

  return counts;
}
