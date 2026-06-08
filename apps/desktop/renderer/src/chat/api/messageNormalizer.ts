import type {
  AssistantAction,
  ChatMessage,
  MessageImage,
  MessageReference,
} from '@zeus-atlas/protocol';
import { isRecord, readString, toTimestamp } from './normalizerUtils.ts';

function normalizeImages(value: unknown): readonly MessageImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === 'string') return { url: item };
      if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
        return item as MessageImage;
      }
      return null;
    })
    .filter((item): item is MessageImage => Boolean(item));
}

function normalizeReferences(value: unknown): readonly MessageReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is MessageReference => {
    if (!item || typeof item !== 'object') return false;
    const ref = item as Partial<MessageReference>;
    return typeof ref.scopeId === 'string' && typeof ref.label === 'string' && typeof ref.text === 'string';
  });
}

function normalizeActions(value: unknown): readonly AssistantAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: AssistantAction[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) return;
    const label = readString(item, ['label', 'title', 'name']);
    const skillId = readString(item, ['skillId', 'skill_id', 'skill']);
    if (!label || !skillId) return;
    const payload = isRecord(item.payload)
      ? item.payload
      : {
          type: readString(item, ['type']) ?? 'unknown',
          data: item.data,
          messageUuid: readString(item, ['messageUuid']),
        };
    actions.push({
      id: readString(item, ['id', 'uuid']) ?? `action_${index}`,
      label,
      skillId,
      style: item.style === 'primary' || item.style === 'danger' ? item.style : 'default',
      payload: {
        type: readString(payload, ['type']) ?? 'unknown',
        data: payload.data,
        messageUuid: readString(payload, ['messageUuid']),
      },
    });
  });
  return actions.length > 0 ? actions : undefined;
}

function normalizeSender(value: unknown): ChatMessage['sender'] | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'number' ? value.id : Number(value.id);
  const depth = typeof value.depth === 'number' ? value.depth : Number(value.depth ?? 0);
  const name = readString(value, ['name', 'displayName', 'nickNameCn']);
  const type = value.type === 'siliconEmployee' || value.type === 'agent' ? value.type : undefined;
  if (!Number.isFinite(id) || !name || !type) return undefined;
  return {
    id,
    name,
    type,
    depth: Number.isFinite(depth) ? depth : 0,
    orgRole: readString(value, ['orgRole']),
  };
}

function recoverContentFromThinkingProcess(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.iterations)) return undefined;
  const iteration = [...value.iterations]
    .reverse()
    .find((iteration): iteration is Record<string, unknown> =>
      isRecord(iteration) &&
      typeof iteration.thinkingContent === 'string' &&
      iteration.thinkingContent.trim().length > 0,
    );
  return typeof iteration?.thinkingContent === 'string' ? iteration.thinkingContent : undefined;
}

export function normalizeChatMessage(raw: unknown): ChatMessage {
  if (!raw || typeof raw !== 'object') {
    return {
      id: `message_${Date.now()}`,
      role: 'assistant',
      content: String(raw ?? ''),
      timestamp: Date.now(),
      status: 'done',
    };
  }

  const record = raw as Record<string, unknown>;
  const role = record.role === 'user' || record.role === 'assistant' || record.role === 'system' || record.role === 'tool'
    ? record.role
    : 'assistant';
  const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
  const messageUuid = typeof record.messageUuid === 'string' ? record.messageUuid : uuid;
  const id =
    typeof record.id === 'string'
      ? record.id
      : messageUuid ?? (typeof record.id === 'number' ? String(record.id) : `message_${Date.now()}`);
  const content =
    typeof record.content === 'string'
      ? record.content
      : typeof record.contentSnapshot === 'string'
        ? record.contentSnapshot
        : '';
  const recoveredContent = content.trim() ? content : recoverContentFromThinkingProcess(record.thinkingProcess);

  return {
    id,
    role,
    content: recoveredContent ?? '',
    timestamp: toTimestamp(record.timestamp ?? record.gmtCreate ?? record.createdAt),
    status: record.status === 'streaming' || record.status === 'sending' || record.status === 'error' ? record.status : 'done',
    ...(messageUuid ? { messageUuid } : {}),
    ...(typeof record.id === 'number' ? { rawMessageId: record.id } : {}),
    ...(normalizeImages(record.images) ? { images: normalizeImages(record.images) } : {}),
    ...(normalizeReferences(record.references) ? { references: normalizeReferences(record.references) } : {}),
    ...(normalizeActions(record.actions) ? { actions: normalizeActions(record.actions) } : {}),
    ...(typeof record.skillId === 'string' || typeof record.skillId === 'number' ? { skillId: record.skillId } : {}),
    ...(typeof record.skillName === 'string' ? { skillName: record.skillName } : {}),
    ...(record.aiData !== undefined ? { aiData: record.aiData } : {}),
    ...(record.renderData !== undefined ? { renderData: record.renderData } : {}),
    ...(normalizeSender(record.sender) ? { sender: normalizeSender(record.sender) } : {}),
    ...(record.thinkingProcess && typeof record.thinkingProcess === 'object'
      ? { thinkingProcess: record.thinkingProcess as ChatMessage['thinkingProcess'] }
      : {}),
  };
}
