import {
  estimateContextTextTokens,
  projectContext,
  type ContextProjection,
  type ContextProjectionPhase,
} from './context-projection.ts';

type ProjectionMessage = Parameters<typeof projectContext>[0]['messages'];
type ProjectionTools = Parameters<typeof projectContext>[0]['tools'];

export type ContextProjectionLifecycleSnapshot = Readonly<{
  revision: number;
  projection: ContextProjection;
}>;

export type ContextProjectionLifecycleInput = Readonly<{
  messages?: ProjectionMessage;
  tools?: ProjectionTools;
  contextWindow?: number | null;
  currentInputTokens?: number | null;
  reason?: string;
  now?: number;
}>;

export type ContextProjectionLifecycle = Readonly<{
  requestPreflight(input: ContextProjectionLifecycleInput): ContextProjectionLifecycleSnapshot;
  streamPreview(delta: string, input?: Omit<ContextProjectionLifecycleInput, 'messages'>): ContextProjectionLifecycleSnapshot;
  toolResult(input: ContextProjectionLifecycleInput): ContextProjectionLifecycleSnapshot;
  postCompaction(input: ContextProjectionLifecycleInput): ContextProjectionLifecycleSnapshot;
  turnComplete(input: ContextProjectionLifecycleInput): ContextProjectionLifecycleSnapshot;
  restored(input: ContextProjectionLifecycleInput): ContextProjectionLifecycleSnapshot;
  current(): ContextProjectionLifecycleSnapshot | null;
}>;

/**
 * Owns the ordering and transient state for one Runtime turn's context projection.
 * Hosts provide their actual request messages/tools at stable boundaries. During a
 * provider stream only the assistant delta is provisional; it is replaced by the
 * next stable boundary rather than being added to an already persisted message.
 */
export function createContextProjectionLifecycle(
  onProjection?: (snapshot: ContextProjectionLifecycleSnapshot) => void,
): ContextProjectionLifecycle {
  let revision = 0;
  let lastSnapshot: ContextProjectionLifecycleSnapshot | null = null;
  let stableInput: ContextProjectionLifecycleInput = {};
  let streamedAssistantText = '';

  const publish = (
    phase: ContextProjectionPhase,
    input: ContextProjectionLifecycleInput,
    previewInputTokens?: number | null,
  ): ContextProjectionLifecycleSnapshot => {
    stableInput = { ...stableInput, ...input };
    const projection = projectContext({
      messages: stableInput.messages,
      tools: stableInput.tools,
      contextWindow: stableInput.contextWindow,
      currentInputTokens: input.currentInputTokens ?? stableInput.currentInputTokens,
      previewInputTokens,
      phase,
      quality: phase === 'stream_preview' ? 'preview' : 'projected',
      reason: input.reason ?? phase,
      now: input.now,
    });
    const snapshot = Object.freeze({ revision: ++revision, projection });
    lastSnapshot = snapshot;
    onProjection?.(snapshot);
    return snapshot;
  };

  const stableBoundary = (
    phase: Exclude<ContextProjectionPhase, 'stream_preview'>,
    input: ContextProjectionLifecycleInput,
  ) => {
    streamedAssistantText = '';
    return publish(phase, input);
  };

  return Object.freeze({
    requestPreflight(input) {
      return stableBoundary('request_preflight', input);
    },
    streamPreview(delta, input = {}) {
      streamedAssistantText += typeof delta === 'string' ? delta : '';
      const base = lastSnapshot?.projection.nextRequestInputTokens ?? 0;
      const previewInputTokens = base + estimateContextTextTokens(streamedAssistantText);
      return publish('stream_preview', input, previewInputTokens);
    },
    toolResult(input) {
      return stableBoundary('tool_result', input);
    },
    postCompaction(input) {
      return stableBoundary('post_compaction', input);
    },
    turnComplete(input) {
      return stableBoundary('turn_complete', input);
    },
    restored(input) {
      return stableBoundary('restored', input);
    },
    current() {
      return lastSnapshot;
    },
  });
}
