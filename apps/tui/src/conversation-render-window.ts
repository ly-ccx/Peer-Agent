import type { ChatMessage } from './chat-controller.ts';

export interface ConversationRenderWindowPolicy {
  /** Legacy field kept for compatibility; latest mode no longer applies this cap. */
  readonly fallbackMaxMessages: number;
  /** Legacy field kept for compatibility; latest mode no longer applies this budget. */
  readonly fallbackMaxChars: number;
  /** Maximum top-level messages in one history page. */
  readonly historyPageMessages: number;
  /** Maximum estimated characters in one history page. */
  readonly historyPageMaxChars: number;
  /** Defensive cap for an abnormally long tail after a completed compaction. */
  readonly emergencyMaxMessages: number;
  /** Defensive character cap for an abnormally large post-compaction tail. */
  readonly emergencyMaxChars: number;
}

export const DEFAULT_TUI_RENDER_WINDOW_POLICY: ConversationRenderWindowPolicy = Object.freeze({
  // Kept for API compatibility / history-page helpers; latest mode no longer uses these caps.
  fallbackMaxMessages: 120,
  fallbackMaxChars: 160_000,
  historyPageMessages: 80,
  historyPageMaxChars: 400_000,
  // Emergency-only guardrail for pathological transcripts (not the normal path).
  emergencyMaxMessages: 2000,
  emergencyMaxChars: 2_000_000,
});

export type ConversationRenderWindowState =
  | { readonly mode: 'latest' }
  | {
      readonly mode: 'history';
      readonly startMessageId: string;
      readonly endMessageId: string;
    };

export type ConversationRenderWindowReason =
  | 'latest-compaction'
  | 'full-session'
  | 'fallback-tail'
  | 'history-page'
  | 'empty';

export interface ConversationRenderWindow {
  readonly mode: ConversationRenderWindowState['mode'];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly reason: ConversationRenderWindowReason;
  readonly compactionMessageId?: string;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly canLoadEarlier: boolean;
  readonly canLoadLater: boolean;
  readonly emergencyTruncated: boolean;
  readonly estimatedRenderedChars: number;
}

export interface ConversationRenderProjection {
  readonly messages: readonly ChatMessage[];
  readonly window: ConversationRenderWindow;
}

export type ConversationHistoryDirection = 'earlier' | 'later' | 'latest';

const IMAGE_PLACEHOLDER_CHARS = 256;
const MAX_TURN_BOUNDARY_SCAN = 64;

export function createConversationRenderWindowState(): ConversationRenderWindowState {
  return { mode: 'latest' };
}

function finitePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizedPolicy(
  policy: ConversationRenderWindowPolicy,
): ConversationRenderWindowPolicy {
  return {
    fallbackMaxMessages: finitePositive(policy.fallbackMaxMessages, 1),
    fallbackMaxChars: finitePositive(policy.fallbackMaxChars, 1),
    historyPageMessages: finitePositive(policy.historyPageMessages, 1),
    historyPageMaxChars: finitePositive(policy.historyPageMaxChars, 1),
    emergencyMaxMessages: finitePositive(policy.emergencyMaxMessages, 1),
    emergencyMaxChars: finitePositive(policy.emergencyMaxChars, 1),
  };
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Cheap, conservative cost estimate used only to choose whole-message boundaries. */
export function estimateMessageChars(message: ChatMessage): number {
  let total = message.content.length;
  total += message.thinkingContent?.length ?? 0;
  total += (message.images?.length ?? 0) * IMAGE_PLACEHOLDER_CHARS;

  if (message.segments) {
    for (const segment of message.segments) {
      if (segment.type === 'tool-call') total += jsonChars(segment.tool);
      else total += segment.content.length;
    }
  } else {
    if (message.tool) total += jsonChars(message.tool);
    if (message.tools) total += jsonChars(message.tools);
  }

  return Math.max(1, total);
}

function isValidCompletedCompaction(message: ChatMessage): boolean {
  return message.role === 'system'
    && message.pending !== true
    && message.compact?.phase === 'done'
    && message.id.trim().length > 0;
}

function lastCompletedCompactionIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isValidCompletedCompaction(message)) return index;
  }
  return -1;
}

function lastMessageIndexById(messages: readonly ChatMessage[], messageId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.id === messageId) return index;
  }
  return -1;
}

function scanBackwardStart(
  messages: readonly ChatMessage[],
  endIndex: number,
  maxMessages: number,
  maxChars: number,
  lowerBound = 0,
): number {
  let startIndex = endIndex;
  let selectedMessages = 0;
  let selectedChars = 0;

  for (let index = endIndex; index >= lowerBound; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const nextChars = selectedChars + estimateMessageChars(message);
    if (
      selectedMessages > 0
      && (selectedMessages + 1 > maxMessages || nextChars > maxChars)
    ) {
      break;
    }
    startIndex = index;
    selectedMessages += 1;
    selectedChars = nextChars;
  }

  return startIndex;
}

function scanForwardEnd(
  messages: readonly ChatMessage[],
  startIndex: number,
  maxMessages: number,
  maxChars: number,
  upperBound: number,
): number {
  let endIndex = startIndex;
  let selectedMessages = 0;
  let selectedChars = 0;

  for (let index = startIndex; index <= upperBound; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const nextChars = selectedChars + estimateMessageChars(message);
    if (
      selectedMessages > 0
      && (selectedMessages + 1 > maxMessages || nextChars > maxChars)
    ) {
      break;
    }
    endIndex = index;
    selectedMessages += 1;
    selectedChars = nextChars;
  }

  return endIndex;
}

/**
 * Avoid beginning in the middle of a user -> assistant/tool interaction.
 * A completed compaction is a hard boundary and is never crossed.
 */
function alignStartToTurn(
  messages: readonly ChatMessage[],
  startIndex: number,
  lowerBound: number,
): number {
  const first = messages[startIndex];
  if (!first || first.role === 'user' || first.role === 'system') return startIndex;

  const scanLimit = Math.max(lowerBound, startIndex - MAX_TURN_BOUNDARY_SCAN);
  for (let index = startIndex - 1; index >= scanLimit; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') return index;
    if (message.role === 'system') break;
  }
  return startIndex;
}

/** Keep a history page from ending in the middle of the same interaction. */
function alignEndToTurn(
  messages: readonly ChatMessage[],
  endIndex: number,
  upperBound: number,
): number {
  const last = messages[endIndex];
  if (!last || last.role === 'system') return endIndex;

  const scanLimit = Math.min(upperBound, endIndex + MAX_TURN_BOUNDARY_SCAN);
  for (let index = endIndex + 1; index <= scanLimit; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user' || message.role === 'system') return index - 1;
  }
  return endIndex;
}

function estimatedRangeChars(
  messages: readonly ChatMessage[],
  startIndex: number,
  endIndex: number,
): number {
  let total = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const message = messages[index];
    if (message) total += estimateMessageChars(message);
  }
  return total;
}

function projectRange(
  messages: readonly ChatMessage[],
  input: {
    readonly mode: ConversationRenderWindowState['mode'];
    readonly startIndex: number;
    readonly endIndex: number;
    readonly reason: ConversationRenderWindowReason;
    readonly compactionMessageId?: string;
    readonly emergencyTruncated?: boolean;
  },
): ConversationRenderProjection {
  const hiddenBefore = input.startIndex;
  const hiddenAfter = Math.max(0, messages.length - input.endIndex - 1);
  return {
    messages: messages.slice(input.startIndex, input.endIndex + 1),
    window: {
      mode: input.mode,
      startIndex: input.startIndex,
      endIndex: input.endIndex,
      reason: input.reason,
      ...(input.compactionMessageId
        ? { compactionMessageId: input.compactionMessageId }
        : {}),
      hiddenBefore,
      hiddenAfter,
      canLoadEarlier: hiddenBefore > 0,
      canLoadLater: hiddenAfter > 0,
      emergencyTruncated: input.emergencyTruncated ?? false,
      estimatedRenderedChars: estimatedRangeChars(
        messages,
        input.startIndex,
        input.endIndex,
      ),
    },
  };
}

function emptyProjection(): ConversationRenderProjection {
  return {
    messages: [],
    window: {
      mode: 'latest',
      startIndex: 0,
      endIndex: -1,
      reason: 'empty',
      hiddenBefore: 0,
      hiddenAfter: 0,
      canLoadEarlier: false,
      canLoadLater: false,
      emergencyTruncated: false,
      estimatedRenderedChars: 0,
    },
  };
}

function projectLatest(
  messages: readonly ChatMessage[],
  inputPolicy: ConversationRenderWindowPolicy,
): ConversationRenderProjection {
  if (messages.length === 0) return emptyProjection();
  const policy = normalizedPolicy(inputPolicy);
  const endIndex = messages.length - 1;
  const compactionIndex = lastCompletedCompactionIndex(messages);

  // Default UX: continuous transcript.
  // - With a completed compaction: show compaction boundary → now.
  // - Without compaction: show the full session.
  // Only emergency caps may hide messages on this path.
  let startIndex = compactionIndex >= 0 ? compactionIndex : 0;
  let reason: ConversationRenderWindowReason = compactionIndex >= 0
    ? 'latest-compaction'
    : 'full-session';
  let emergencyTruncated = false;

  const guardStart = scanBackwardStart(
    messages,
    endIndex,
    policy.emergencyMaxMessages,
    policy.emergencyMaxChars,
    startIndex,
  );
  const alignedGuardStart = alignStartToTurn(messages, guardStart, startIndex);
  if (alignedGuardStart > startIndex) {
    startIndex = alignedGuardStart;
    emergencyTruncated = true;
  }

  return projectRange(messages, {
    mode: 'latest',
    startIndex,
    endIndex,
    reason,
    compactionMessageId: compactionIndex >= 0 ? messages[compactionIndex]?.id : undefined,
    emergencyTruncated,
  });
}

export function projectConversationRenderWindow(
  messages: readonly ChatMessage[],
  state: ConversationRenderWindowState = createConversationRenderWindowState(),
  policy: ConversationRenderWindowPolicy = DEFAULT_TUI_RENDER_WINDOW_POLICY,
): ConversationRenderProjection {
  if (state.mode === 'latest' || messages.length === 0) {
    return projectLatest(messages, policy);
  }

  const startIndex = lastMessageIndexById(messages, state.startMessageId);
  const endIndex = lastMessageIndexById(messages, state.endMessageId);
  if (startIndex < 0 || endIndex < startIndex) return projectLatest(messages, policy);

  return projectRange(messages, {
    mode: 'history',
    startIndex,
    endIndex,
    reason: 'history-page',
  });
}

/**
 * Move between bounded pages. Pages overlap by one complete turn so the user
 * retains a visual anchor without accumulating every page in the React tree.
 */
export function navigateConversationHistory(
  messages: readonly ChatMessage[],
  state: ConversationRenderWindowState,
  direction: ConversationHistoryDirection,
  inputPolicy: ConversationRenderWindowPolicy = DEFAULT_TUI_RENDER_WINDOW_POLICY,
): ConversationRenderWindowState {
  if (direction === 'latest' || messages.length === 0) {
    return createConversationRenderWindowState();
  }

  const current = projectConversationRenderWindow(messages, state, inputPolicy);
  const policy = normalizedPolicy(inputPolicy);

  if (direction === 'earlier') {
    if (!current.window.canLoadEarlier) return state;
    // Prefer a one-turn visual overlap on the current page head. When that head
    // message alone already fills the page budget, overlapping re-selects the
    // same singleton page forever (e.g. one short user turn after a huge tool
    // result). Force an exclusive end before the current start so earlier always
    // progresses while canLoadEarlier is true.
    const currentStart = current.window.startIndex;
    const exclusiveEnd = Math.max(0, currentStart - 1);
    const headMessage = messages[currentStart];
    const headAloneFillsBudget = !!headMessage
      && estimateMessageChars(headMessage) >= policy.historyPageMaxChars;
    const singletonPage = currentStart === current.window.endIndex;
    let endAnchor = (headAloneFillsBudget || singletonPage)
      ? exclusiveEnd
      : currentStart;

    const buildEarlierState = (anchor: number): ConversationRenderWindowState | null => {
      const selectedStart = scanBackwardStart(
        messages,
        anchor,
        policy.historyPageMessages,
        policy.historyPageMaxChars,
      );
      const startIndex = alignStartToTurn(messages, selectedStart, 0);
      // Cap end so turn alignment cannot expand back into the previous page
      // when we intentionally stepped before the current start.
      const alignedEnd = alignEndToTurn(messages, anchor, messages.length - 1);
      const endIndex = anchor < currentStart
        ? Math.min(alignedEnd, exclusiveEnd)
        : alignedEnd;
      if (startIndex >= currentStart && currentStart > 0) return null;
      const startMessage = messages[startIndex];
      const endMessage = messages[endIndex];
      if (!startMessage || !endMessage) return null;
      return {
        mode: 'history',
        startMessageId: startMessage.id,
        endMessageId: endMessage.id,
      };
    };

    const preferred = buildEarlierState(endAnchor);
    if (preferred) return preferred;
    if (endAnchor !== exclusiveEnd) {
      const forced = buildEarlierState(exclusiveEnd);
      if (forced) return forced;
    }
    return state;
  }

  if (!current.window.canLoadLater) return createConversationRenderWindowState();
  const startAnchor = current.window.endIndex;
  const selectedEnd = scanForwardEnd(
    messages,
    startAnchor,
    policy.historyPageMessages,
    policy.historyPageMaxChars,
    messages.length - 1,
  );
  const startIndex = alignStartToTurn(messages, startAnchor, 0);
  const endIndex = alignEndToTurn(messages, selectedEnd, messages.length - 1);
  if (endIndex >= messages.length - 1) return createConversationRenderWindowState();
  const startMessage = messages[startIndex];
  const endMessage = messages[endIndex];
  if (!startMessage || !endMessage) return state;
  return {
    mode: 'history',
    startMessageId: startMessage.id,
    endMessageId: endMessage.id,
  };
}
