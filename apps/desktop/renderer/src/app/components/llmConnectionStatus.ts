import type { LlmConnectionState } from '@peer-agent/protocol';

export type ConnectionStateCarrier = {
  readonly connectionState?: LlmConnectionState;
};

const UNTESTED = new Set<LlmConnectionState | undefined>([
  undefined,
  'draft',
  'pending_verification',
]);

export type ModelConnectionBadge = {
  readonly text: string;
  readonly tone: 'bad' | 'warn';
};

/**
 * 折叠模型行只标出需要处理的连接问题。
 * 不可用 → 红标；需要操作 → 黄标；可用或未测不标。
 */
export function modelConnectionBadge(
  state: LlmConnectionState | undefined,
  zh: boolean,
): ModelConnectionBadge | null {
  if (state === 'unavailable') {
    return { text: zh ? '不可用' : 'Unavailable', tone: 'bad' };
  }
  if (state === 'needs_attention') {
    return { text: zh ? '需要操作' : 'Needs attention', tone: 'warn' };
  }
  return null;
}

/**
 * 渠道卡片看的是组状态，不是组里第一条模型。
 * 只有组内全部（未停用）模型都不可用时才返回 unavailable；
 * 有的可用、有的不可用，或失败与未测并存，都归成 partial。
 */
export function aggregateGroupConnectionState(
  models: readonly ConnectionStateCarrier[],
): LlmConnectionState | undefined {
  if (models.length === 0) return undefined;

  const states = models.map((model) => model.connectionState);
  if (states.some((state) => state === 'checking')) return 'checking';

  const active = states.filter((state) => state !== 'disabled');
  if (active.length === 0) return 'disabled';

  const allMatch = (expected: LlmConnectionState) => active.every((state) => state === expected);
  if (allMatch('unavailable')) return 'unavailable';
  if (allMatch('available')) return 'available';
  if (allMatch('needs_attention')) return 'needs_attention';
  if (allMatch('partial')) return 'partial';

  const hasUnavailable = active.some((state) => state === 'unavailable');
  const hasUsable = active.some((state) => state === 'available' || state === 'partial');
  const hasUntested = active.some((state) => UNTESTED.has(state));
  const hasAttention = active.some((state) => state === 'needs_attention');

  if (hasUnavailable && (hasUsable || hasUntested || hasAttention)) return 'partial';
  if (hasUsable && (hasUntested || hasAttention)) return 'partial';
  if (active.some((state) => state === 'partial')) return 'partial';
  if (active.some((state) => state === 'available')) return 'available';
  if (hasAttention) return 'needs_attention';

  return active.find((state) => state !== undefined);
}
