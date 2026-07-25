import {
  CONTEXT_PROJECTION_CONFIG,
  decideContextCompaction,
  isPromptTooLongError,
  type CompactionDecision,
} from './context-projection.ts';

export type ContextCountCapability =
  | { readonly kind: 'provider_count_api' }
  | { readonly kind: 'provider_tokenizer'; readonly tokenizerVersion: string }
  | { readonly kind: 'observed_usage_only' }
  | { readonly kind: 'unavailable' };

export type ObservedUsageInput = Readonly<{
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  /**
   * Some providers report cached input as a subset of inputTokens. Existing Peer
   * adapters normalize cache as a separate amount, so false is the safe default.
   */
  inputIncludesCache?: boolean;
}>;

export type ExactCountResult = Readonly<{
  inputTokens: number;
  source: 'provider_count_api' | 'provider_tokenizer';
}>;

export type ContextOverflowEvidence = Readonly<{
  requestedTokens?: number;
  maximumTokens?: number;
  status?: number;
  message: string;
}>;

export type ContextAccountingSnapshot = Readonly<{
  version: 1;
  compactionEpoch: number;
  contextWindow: number | null;
  inputBudget: number | null;
  compactionThresholdTokens: number | null;
  authoritativeInputTokens: number | null;
  percent: number | null;
  pressureSource:
    | 'provider_usage'
    | 'provider_count_api'
    | 'provider_tokenizer'
    | 'provider_error_evidence'
    | 'unknown';
  pendingUncountedChanges: boolean;
  countCapability: ContextCountCapability;
  lastObserved?: Readonly<{
    inputTokens: number;
    requestFingerprint: string;
    compactionEpoch: number;
    source: 'provider_usage';
    observedAt: number;
    supersededByCompactionRevision?: number;
  }>;
  nextCounted?: Readonly<{
    inputTokens: number;
    requestFingerprint: string;
    compactionEpoch: number;
    source: 'provider_count_api' | 'provider_tokenizer';
    countedAt: number;
  }>;
  lastOverflow?: ContextOverflowEvidence;
}>;

export type ContextCompactionReason =
  | 'observed_threshold'
  | 'exact_count_threshold'
  | 'manual'
  | 'forced'
  | 'provider_overflow';

type MaybePromise<T> = T | Promise<T>;

type CompactResult<TState> = Readonly<{
  compacted: boolean;
  state: TState;
}>;

export type ContextAccountingPipelineOptions<TState, TRequest, TResponse> = Readonly<{
  contextWindow: number | null | undefined | (() => number | null | undefined);
  requiredOutputReserveTokens?: number;
  compactionThresholdRatio?: number;
  countCapability?: ContextCountCapability;
  buildRequest: (state: TState) => MaybePromise<TRequest>;
  countRequest?: (request: TRequest) => MaybePromise<ExactCountResult | number | null | undefined>;
  compact: (input: Readonly<{
    state: TState;
    reason: ContextCompactionReason;
    emergency: boolean;
    compactionEpoch: number;
  }>) => MaybePromise<CompactResult<TState>>;
  send: (request: TRequest) => Promise<TResponse>;
  getUsage?: (response: TResponse) => ObservedUsageInput | null | undefined;
  getOverflow?: (response: TResponse) => ContextOverflowEvidence | null | undefined;
  fingerprintRequest?: (request: TRequest) => string;
  now?: () => number;
}>;

export type ContextAccountingExecuteInput<TState> = Readonly<{
  state: TState;
  lastObservedUsage?: ObservedUsageInput | null;
  forceCompact?: boolean;
  command?: 'send' | 'manual_compact';
}>;

export type ContextAccountingExecuteResult<TState, TRequest, TResponse> = Readonly<{
  state: TState;
  request: TRequest;
  response: TResponse | null;
  snapshot: ContextAccountingSnapshot;
  decision: CompactionDecision | null;
  compactionEpoch: number;
  compacted: boolean;
  retriedAfterOverflow: boolean;
}>;

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function finiteWindow(value: unknown): number | null {
  const count = finiteTokenCount(value);
  return count > 0 ? count : null;
}

export function normalizeObservedInputTokens(usage: ObservedUsageInput | null | undefined): number | null {
  if (!usage) return null;
  const input = finiteTokenCount(usage.inputTokens);
  const cacheRead = finiteTokenCount(usage.cacheReadTokens);
  const total = usage.inputIncludesCache ? input : input + cacheRead;
  return total > 0 ? total : null;
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new TypeError('Canonical provider request must not contain cycles.');
  seen.add(value);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') continue;
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

export function fingerprintCanonicalRequest(request: unknown): string {
  const text = JSON.stringify(stableValue(request, new WeakSet<object>()));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ctx_${(hash >>> 0).toString(16).padStart(8, '0')}_${text.length}`;
}

function errorDetails(error: unknown): { status?: number; message: string } {
  if (error instanceof Error) {
    const status = finiteTokenCount((error as Error & { status?: number }).status) || undefined;
    return { ...(status ? { status } : {}), message: error.message };
  }
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const status = finiteTokenCount(record.status) || undefined;
    const message = String(record.errorText ?? record.message ?? record.error ?? JSON.stringify(record));
    return { ...(status ? { status } : {}), message };
  }
  return { message: String(error ?? '') };
}

function tokenFromMatch(match: RegExpMatchArray | null): number | undefined {
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function parseContextOverflowEvidence(error: unknown): ContextOverflowEvidence | null {
  const details = errorDetails(error);
  if (!isPromptTooLongError(details.status, details.message)) return null;
  const text = details.message;
  const requestedTokens = tokenFromMatch(
    text.match(/request\s+(?:contains|has)\s+([\d,]+)\s+tokens?/i)
      ?? text.match(/requested\s+([\d,]+)\s+tokens?/i)
      ?? text.match(/([\d,]+)\s+tokens?\s*(?:>|over|exceeds)/i),
  );
  const maximumTokens = tokenFromMatch(
    text.match(/maximum\s+(?:prompt|context)(?:\s+length)?\s+(?:is|of)\s+([\d,]+)/i)
      ?? text.match(/([\d,]+)\s+(?:token\s+)?(?:maximum|limit)/i),
  );
  return {
    ...(requestedTokens ? { requestedTokens } : {}),
    ...(maximumTokens ? { maximumTokens } : {}),
    ...(details.status ? { status: details.status } : {}),
    message: text,
  };
}

function resolveCapability(
  configured: ContextCountCapability | undefined,
  hasCounter: boolean,
): ContextCountCapability {
  if (configured) return configured;
  return hasCounter ? { kind: 'provider_tokenizer', tokenizerVersion: 'adapter' } : { kind: 'observed_usage_only' };
}

function exactResult(
  value: ExactCountResult | number | null | undefined,
  capability: ContextCountCapability,
): ExactCountResult | null {
  if (typeof value === 'number') {
    const count = finiteTokenCount(value);
    if (!count) return null;
    return {
      inputTokens: count,
      source: capability.kind === 'provider_count_api' ? 'provider_count_api' : 'provider_tokenizer',
    };
  }
  if (!value) return null;
  const count = finiteTokenCount(value.inputTokens);
  return count ? { inputTokens: count, source: value.source } : null;
}

export function createContextAccountingCompactionPipeline<TState, TRequest, TResponse>(
  options: ContextAccountingPipelineOptions<TState, TRequest, TResponse>,
) {
  const now = options.now ?? Date.now;
  const fingerprint = options.fingerprintRequest ?? fingerprintCanonicalRequest;
  const capability = resolveCapability(options.countCapability, typeof options.countRequest === 'function');
  let compactionEpoch = 0;
  let lastObserved: ContextAccountingSnapshot['lastObserved'];
  let nextCounted: ContextAccountingSnapshot['nextCounted'];
  let lastOverflow: ContextOverflowEvidence | undefined;
  let lastOverflowEpoch: number | undefined;
  let compactionRevision = 0;

  const contextWindow = () => finiteWindow(
    typeof options.contextWindow === 'function' ? options.contextWindow() : options.contextWindow,
  );

  const buildSnapshot = (): ContextAccountingSnapshot => {
    const window = contextWindow();
    const reserve = Math.max(0, finiteTokenCount(options.requiredOutputReserveTokens));
    const inputBudget = window == null ? null : Math.max(1, window - reserve);
    const thresholdRatio = options.compactionThresholdRatio ?? CONTEXT_PROJECTION_CONFIG.triggerRatio;
    const compactionThresholdTokens = inputBudget == null
      ? null
      : Math.floor(inputBudget * thresholdRatio);
    const activeObserved = lastObserved?.compactionEpoch === compactionEpoch
      && lastObserved.supersededByCompactionRevision == null
      ? lastObserved
      : undefined;
    const activeCounted = nextCounted?.compactionEpoch === compactionEpoch ? nextCounted : undefined;
    const activeOverflowTokens =
      lastOverflowEpoch === compactionEpoch
        ? finiteTokenCount(lastOverflow?.requestedTokens) || null
        : null;
    const authority = activeCounted ?? activeObserved;
    const authoritativeInputTokens = authority?.inputTokens ?? activeOverflowTokens;
    const pressureSource = authority?.source
      ?? (activeOverflowTokens ? 'provider_error_evidence' : 'unknown');
    return {
      version: 1,
      compactionEpoch,
      contextWindow: window,
      inputBudget,
      compactionThresholdTokens,
      authoritativeInputTokens,
      percent: window == null || authoritativeInputTokens == null
        ? null
        : Math.min(100, Math.round((authoritativeInputTokens / window) * 100)),
      pressureSource,
      pendingUncountedChanges: !activeCounted,
      countCapability: capability,
      ...(lastObserved ? { lastObserved } : {}),
      ...(activeCounted ? { nextCounted: activeCounted } : {}),
      ...(lastOverflow ? { lastOverflow } : {}),
    };
  };

  const observe = (
    usage: ObservedUsageInput | null | undefined,
    requestFingerprint: string,
  ) => {
    const inputTokens = normalizeObservedInputTokens(usage);
    if (inputTokens == null) return;
    lastObserved = {
      inputTokens,
      requestFingerprint,
      compactionEpoch,
      source: 'provider_usage',
      observedAt: now(),
    };
  };

  const count = async (request: TRequest, requestFingerprint: string) => {
    nextCounted = undefined;
    if (!options.countRequest) return;
    const before = fingerprint(request);
    if (before !== requestFingerprint) {
      throw new Error('context_request_fingerprint_mismatch: request changed before exact count');
    }
    const counted = exactResult(await options.countRequest(request), capability);
    const after = fingerprint(request);
    if (after !== requestFingerprint) {
      throw new Error('context_request_fingerprint_mismatch: exact counter mutated the canonical request');
    }
    if (!counted) return;
    nextCounted = {
      inputTokens: counted.inputTokens,
      requestFingerprint,
      compactionEpoch,
      source: counted.source,
      countedAt: now(),
    };
  };

  const build = async (state: TState) => {
    const request = await options.buildRequest(state);
    const requestFingerprint = fingerprint(request);
    await count(request, requestFingerprint);
    return { request, requestFingerprint };
  };

  const decide = (): CompactionDecision | null => {
    const snapshot = buildSnapshot();
    if (snapshot.authoritativeInputTokens == null || snapshot.inputBudget == null) return null;
    return decideContextCompaction({
      pressureTokens: snapshot.authoritativeInputTokens,
      contextWindow: snapshot.inputBudget,
      triggerRatio: options.compactionThresholdRatio,
    });
  };

  const advanceEpoch = () => {
    compactionEpoch += 1;
    compactionRevision += 1;
    if (lastObserved && lastObserved.supersededByCompactionRevision == null) {
      lastObserved = {
        ...lastObserved,
        supersededByCompactionRevision: compactionRevision,
      };
    }
    nextCounted = undefined;
  };

  const runCompaction = async (
    state: TState,
    reason: ContextCompactionReason,
    emergency: boolean,
  ): Promise<CompactResult<TState>> => {
    const result = await options.compact({
      state,
      reason,
      emergency,
      compactionEpoch,
    });
    if (result.compacted) advanceEpoch();
    return result;
  };

  const overflowFromResponse = (response: TResponse): ContextOverflowEvidence | null => {
    return options.getOverflow?.(response) ?? null;
  };

  const execute = async (
    input: ContextAccountingExecuteInput<TState>,
  ): Promise<ContextAccountingExecuteResult<TState, TRequest, TResponse>> => {
    if (input.lastObservedUsage) {
      const provisional = await options.buildRequest(input.state);
      observe(input.lastObservedUsage, fingerprint(provisional));
    }

    let state = input.state;
    let built = await build(state);
    let decision = decide();
    let compacted = false;
    const forceReason: ContextCompactionReason | null = input.command === 'manual_compact'
      ? 'manual'
      : input.forceCompact
        ? 'forced'
        : null;
    const thresholdReason: ContextCompactionReason | null = decision?.shouldCompact
      ? nextCounted
        ? 'exact_count_threshold'
        : 'observed_threshold'
      : null;
    const initialReason = forceReason ?? thresholdReason;

    if (initialReason) {
      const compactResult = await runCompaction(state, initialReason, false);
      if (compactResult.compacted) {
        compacted = true;
        state = compactResult.state;
        built = await build(state);
        decision = decide();
      }
    }

    if (input.command === 'manual_compact') {
      return {
        state,
        request: built.request,
        response: null,
        snapshot: buildSnapshot(),
        decision,
        compactionEpoch,
        compacted,
        retriedAfterOverflow: false,
      };
    }

    const assertFingerprint = () => {
      if (fingerprint(built.request) !== built.requestFingerprint) {
        throw new Error('context_request_fingerprint_mismatch: canonical request changed before send');
      }
    };

    let retriedAfterOverflow = false;
    let response: TResponse;
    try {
      assertFingerprint();
      response = await options.send(built.request);
    } catch (error) {
      const evidence = parseContextOverflowEvidence(error);
      if (!evidence) throw error;
      lastOverflow = evidence;
      lastOverflowEpoch = compactionEpoch;
      const recovered = await runCompaction(state, 'provider_overflow', true);
      if (!recovered.compacted) throw error;
      compacted = true;
      retriedAfterOverflow = true;
      state = recovered.state;
      built = await build(state);
      assertFingerprint();
      response = await options.send(built.request);
    }

    const responseOverflow = overflowFromResponse(response);
    if (responseOverflow) {
      lastOverflow = responseOverflow;
      lastOverflowEpoch = compactionEpoch;
      const recovered = await runCompaction(state, 'provider_overflow', true);
      if (recovered.compacted) {
        compacted = true;
        retriedAfterOverflow = true;
        state = recovered.state;
        built = await build(state);
        assertFingerprint();
        response = await options.send(built.request);
      }
    }

    // A retry is terminal for this execute call. If the retried response is
    // still over the limit, retain its exact requested-token evidence for UI
    // and diagnostics without entering a second retry loop.
    const finalOverflow = overflowFromResponse(response);
    if (finalOverflow) {
      lastOverflow = finalOverflow;
      lastOverflowEpoch = compactionEpoch;
    }

    observe(options.getUsage?.(response), built.requestFingerprint);
    return {
      state,
      request: built.request,
      response,
      snapshot: buildSnapshot(),
      decision,
      compactionEpoch,
      compacted,
      retriedAfterOverflow,
    };
  };

  return Object.freeze({
    execute,
    snapshot: buildSnapshot,
    observe,
  });
}
