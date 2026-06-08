export type ConversationChannel =
  | 'web'
  | 'dingtalk'
  | 'dingtalk-direct'
  | 'dingtalk-group'
  | 'roundtable'
  | 'automation'
  | 'share';

export type ConversationChannelFilter = ConversationChannel | 'all';

export type ChannelRuntimeStatus = 'available' | 'disabled' | 'degraded' | 'unsupported';

export interface ChannelIdentity {
  readonly channel: ConversationChannel;
  readonly sourceId?: string;
  readonly sourceName?: string;
  readonly status: ChannelRuntimeStatus;
}

export interface DingTalkChannelMetadata {
  readonly openConversationId?: string;
  readonly conversationScope?: 'agent_direct_conversation' | 'agent_group_conversation';
  readonly conversationType?: '1' | '2' | string;
}

export interface RoundTableParticipant {
  readonly agentId: number | string;
  readonly role: 'host' | 'member';
  readonly name?: string;
  readonly icon?: string;
}

export interface RoundTableChannelMetadata {
  readonly roundTableUuid?: string;
  readonly participants: readonly RoundTableParticipant[];
}

export interface AutomationChannelMetadata {
  readonly sessionUuid?: string;
  readonly runUuid?: string;
  readonly status?: string;
}

export interface ConversationChannelMetadata {
  readonly channel?: ChannelIdentity | string | { readonly type?: string };
  readonly dingtalk?: DingTalkChannelMetadata;
  readonly roundtable?: RoundTableChannelMetadata;
  readonly automation?: AutomationChannelMetadata;
  readonly source?: string;
  readonly sourcePlatform?: string;
  readonly sourceMetadata?: Record<string, unknown>;
  readonly agentCron?: unknown;
}
