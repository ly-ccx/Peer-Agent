import {
  buildConversationView,
  FULL_CONVERSATION_CAPABILITIES,
  READ_ONLY_CONVERSATION_CAPABILITIES,
} from '@zeus-atlas/protocol';
import type {
  AuthState,
  CloudRuntimeState,
  Conversation,
} from '@zeus-atlas/protocol';

export function getWorkId(authState: AuthState | null): string {
  if (authState?.status !== 'authenticated') return '';
  return authState.user?.empId ?? authState.user?.account ?? '';
}

export function isCloudRuntimeUsable(cloudRuntime: CloudRuntimeState | null): boolean {
  return cloudRuntime?.status === 'configured' ||
    cloudRuntime?.status === 'connected' ||
    cloudRuntime?.status === 'degraded';
}

export function titleFromContent(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  if (!normalized) return '新会话';
  return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized;
}

export function resolveConversationView(conversation: Conversation) {
  return buildConversationView({
    source: {
      kind: 'live',
      conversationId: conversation.id,
    },
    capabilities: conversation.channel === 'share'
      ? READ_ONLY_CONVERSATION_CAPABILITIES
      : FULL_CONVERSATION_CAPABILITIES,
  });
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function localeFromAuthState(authState: AuthState | null) {
  return authState?.status === 'authenticated' && authState.user?.locale === 'en-US' ? 'en-US' : 'zh-CN';
}

export function isMissingEndpointError(error: unknown) {
  return errorMessage(error, '').includes('HTTP 404');
}
