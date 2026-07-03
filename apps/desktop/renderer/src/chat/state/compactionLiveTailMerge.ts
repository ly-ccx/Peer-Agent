import type { ChatMsg } from './types';

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isSameAssistantLiveTailSnapshot(candidate: ChatMsg, liveTail: ChatMsg): boolean {
  if (candidate.role !== 'assistant' || liveTail.role !== 'assistant') return false;
  if (candidate.id && liveTail.id && candidate.id === liveTail.id) return true;

  return (
    String(candidate.content ?? '') === String(liveTail.content ?? '') &&
    stableSerialize(candidate.segments ?? []) === stableSerialize(liveTail.segments ?? [])
  );
}

export function mergeLoadedMessagesWithLiveTail(
  loaded: readonly ChatMsg[],
  liveTail: ChatMsg | undefined,
  options: { streamMatches: boolean },
): ChatMsg[] {
  if (!options.streamMatches || !liveTail || liveTail.role !== 'assistant') {
    return [...loaded];
  }

  return [
    ...loaded.filter((message) => !isSameAssistantLiveTailSnapshot(message, liveTail)),
    liveTail,
  ];
}
