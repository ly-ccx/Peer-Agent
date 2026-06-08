import type { ClientToolCall, ClientToolCallPollResult } from '@zeus-atlas/protocol';
import { isRecord, readString } from './normalizerUtils';

function normalizeClientToolCall(raw: unknown): ClientToolCall | null {
  if (!isRecord(raw)) return null;
  const policy = isRecord(raw.policySnapshot) ? raw.policySnapshot : {};
  const toolCallId = readString(raw, ['toolCallId', 'callId', 'id']);
  const capabilityId = readString(raw, ['capabilityId', 'toolName', 'name']);
  if (!toolCallId || !capabilityId) return null;
  return {
    toolCallId,
    capabilityId,
    displayName: readString(raw, ['displayName', 'toolName', 'name']) ?? capabilityId,
    reason: readString(raw, ['reason', 'description']) ?? 'Cloud requested a local capability.',
    argumentsPreview: isRecord(raw.arguments)
      ? raw.arguments
      : isRecord(raw.args)
        ? raw.args
        : {},
    riskLevel: readString(raw, ['riskLevel']) as ClientToolCall['riskLevel'] ??
      readString(policy, ['capabilityLevel']) as ClientToolCall['riskLevel'] ??
      'L0_inert',
    dataLevel: readString(raw, ['dataLevel']) as ClientToolCall['dataLevel'] ??
      readString(policy, ['dataLevel']) as ClientToolCall['dataLevel'] ??
      'D0_public',
    requestedAt: readString(raw, ['requestedAt', 'createdAt']) ?? new Date().toISOString(),
  };
}

export function normalizeClientToolCallPollResult(raw: unknown): ClientToolCallPollResult {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.calls)
      ? raw.calls
      : isRecord(raw) && Array.isArray(raw.list)
        ? raw.list
        : isRecord(raw) && Array.isArray(raw.tasks)
          ? raw.tasks
          : [];
  return {
    calls: source.map(normalizeClientToolCall).filter((item): item is ClientToolCall => Boolean(item)),
    cursor: isRecord(raw) ? readString(raw, ['cursor', 'nextCursor']) : undefined,
    idleUntil: isRecord(raw) ? readString(raw, ['idleUntil']) : undefined,
  };
}
