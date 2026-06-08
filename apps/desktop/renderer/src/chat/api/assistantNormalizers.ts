import type {
  AgentListData,
  AgentSummary,
  AssistantSuggestion,
  AssistantSuggestionListData,
  InlineCompletionData,
} from '@zeus-atlas/protocol';
import { isRecord, readString } from './normalizerUtils';

function normalizeAgent(raw: unknown): AgentSummary | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'number' || typeof raw.id === 'string'
    ? raw.id
    : readString(raw, ['agentId', 'uuid']);
  const name = readString(raw, ['name', 'agentName', 'displayName', 'title']);
  if (id === undefined || !name) return null;
  return {
    id,
    name,
    description: readString(raw, ['description', 'desc', 'summary']),
    avatar: readString(raw, ['avatar', 'avatarUrl', 'icon']),
    status: readString(raw, ['status']),
    metadata: raw,
  };
}

export function normalizeAgentListData(raw: unknown): AgentListData {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.list)
      ? raw.list
      : isRecord(raw) && Array.isArray(raw.items)
        ? raw.items
        : isRecord(raw) && Array.isArray(raw.records)
          ? raw.records
          : [];
  return {
    list: source.map(normalizeAgent).filter((item): item is AgentSummary => Boolean(item)),
    total: isRecord(raw) && typeof raw.total === 'number' ? raw.total : source.length,
  };
}

function normalizeSuggestion(raw: unknown, index: number): AssistantSuggestion | null {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return {
      id: `suggestion_${index}`,
      label: raw,
      prompt: raw,
    };
  }
  if (!isRecord(raw)) return null;
  const prompt = readString(raw, ['prompt', 'content', 'text', 'message', 'value']);
  const label = readString(raw, ['label', 'title', 'name']) ?? prompt;
  if (!prompt || !label) return null;
  return {
    id: readString(raw, ['id', 'uuid']) ?? `suggestion_${index}`,
    label,
    prompt,
    description: readString(raw, ['description', 'desc', 'summary']),
    source: readString(raw, ['source']),
  };
}

export function normalizeSuggestionListData(raw: unknown): AssistantSuggestionListData {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.list)
      ? raw.list
      : isRecord(raw) && Array.isArray(raw.suggestions)
        ? raw.suggestions
        : isRecord(raw) && Array.isArray(raw.items)
          ? raw.items
          : [];
  return {
    list: source.map(normalizeSuggestion).filter((item): item is AssistantSuggestion => Boolean(item)),
  };
}

export function normalizeInlineCompletion(raw: unknown): InlineCompletionData {
  if (typeof raw === 'string') return { text: raw };
  if (!isRecord(raw)) return { text: '' };
  return {
    text: readString(raw, ['text', 'completion', 'content', 'value']) ?? '',
    source: readString(raw, ['source']),
  };
}
