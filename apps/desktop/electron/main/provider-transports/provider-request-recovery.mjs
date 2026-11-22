import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { classifyProjectAgentFailure } from '@peer-agent/protocol';
import { createRuntimeUsageAccounting } from '@peer-agent/runtime-core';

const requestScopes = new AsyncLocalStorage();
export const PROVIDER_REQUEST_RETRY_DELAYS_MS = Object.freeze([500, 1500, 3000]);
const OUTPUT_CHANNELS = new Set([
  'chat:stream:delta', 'chat:stream:thinking', 'chat:stream:tool-call',
  'chat:stream:tool-progress', 'chat:stream:tool-result',
  'chat:stream:permission-request', 'chat:stream:permission-settled',
]);

function abortError() { return Object.assign(new Error('aborted'), { name: 'AbortError' }); }
function assertActive(signal) { if (signal?.aborted) throw abortError(); }
function wait(ms, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function hasManagedProviderRequest() { return Boolean(requestScopes.getStore()); }
export function providerRequestDispatchIndex() { return requestScopes.getStore()?.attempts ?? null; }
export function recordProviderRequestUsage(usage) {
  const scope = requestScopes.getStore();
  if (!scope || !scope.attempts || scope.observedAttempts.has(scope.attempts)) return;
  scope.observedAttempts.add(scope.attempts);
  const normalized = usage
    ? { ...usage, ...createRuntimeUsageAccounting().observeProviderRequest(usage).turnTotal }
    : null;
  scope.budgetGuard?.observeUsage?.(normalized, `${scope.requestId}:${scope.attempts}:${scope.requestPurpose}`);
}
export function observeProviderRequestOutput(channel, payload) {
  const scope = requestScopes.getStore();
  if (!scope || !OUTPUT_CHANNELS.has(channel)) return;
  if ((channel === 'chat:stream:delta' || channel === 'chat:stream:thinking') && !payload?.content) return;
  scope.partial = true;
}

// This admission runs immediately before the model transport is invoked. Requests
// made by an adapter during the same scope share the physical allowance.
export async function dispatchProviderRequest(send, { connection = null } = {}) {
  const scope = requestScopes.getStore();
  if (!scope) return send();
  scope.transportObserved = true;
  if (connection) scope.connection = connection;
  assertActive(scope.signal);
  if (scope.attempts >= scope.maxAttempts) {
    const error = new Error('provider_request_recovery_exhausted');
    error.providerRecovery = { ...scope.lastFailure, requestId: scope.requestId,
      attempts: scope.attempts, maxAttempts: scope.maxAttempts, exhausted: true,
      replaySafe: !scope.partial, retryable: Boolean(scope.lastFailure?.retryable) };
    throw error;
  }
  recordProviderRequestUsage(null);
  scope.budgetGuard?.beforeRequest?.({ accounting: 'physical_dispatch' });
  scope.attempts++;
  scope.headersReceived = false;
  const response = await send();
  scope.headersReceived = Boolean(response?.headers);
  return response;
}

function failureDetails(failure, scope) {
  const text = [failure?.code, failure?.cause?.code, failure?.message, failure?.cause?.message,
    failure?.errorText, failure?.streamError?.message].filter(Boolean).join(' ');
  const status = Number(failure?.status || 0);
  const type = failure?.streamError?.type;
  let classified;
  if (failure?.name === 'AbortError') classified = { kind: 'cancelled', retryable: false };
  else if (failure?.providerRecovery?.kind) classified = classifyProjectAgentFailure(text, failure.providerRecovery);
  else if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(text)) classified = { kind: 'configuration', retryable: false };
  else if (status) classified = classifyProjectAgentFailure(`HTTP ${status}: ${text}`);
  else if (type === 'server_error' || type === 'server_is_overloaded') classified = classifyProjectAgentFailure(type);
  else if (/provider_stream_idle_timeout|stream interrupted|premature close|other side closed|socket hang up/i.test(text)) classified = { kind: 'stream_interrupted', retryable: true };
  else classified = classifyProjectAgentFailure(text, failure?.providerRecovery);
  if (classified.kind === 'network' && scope.headersReceived) classified = { kind: 'stream_interrupted', retryable: true };
  const phase = classified.kind === 'response_headers_timeout' ? 'response_headers'
    : classified.kind === 'stream_interrupted' || failure?.streamError ? 'stream' : 'request';
  return { ...classified, phase };
}

function hasPartial(failure) {
  return Boolean(String(failure?.content || '').trim() || String(failure?.thinkingContent || '').trim()
    || failure?.toolCalls?.length);
}

/** Own one canonical provider request, never a tool loop or a new user turn. */
export async function runProviderRequestWithRecovery(send, {
  signal = null, budgetGuard = null, webContents = null, streamId = null,
  provider = null, model = null, retryDelaysMs = PROVIDER_REQUEST_RETRY_DELAYS_MS,
  waitImpl = wait, requestPurpose = 'model',
} = {}) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : PROVIDER_REQUEST_RETRY_DELAYS_MS;
  const scope = { requestId: `provider-request-${randomUUID()}`, signal, budgetGuard,
    attempts: 0, maxAttempts: delays.length + 1, partial: false, lastFailure: null,
    observedAttempts: new Set(), requestPurpose };
  return requestScopes.run(scope, async () => {
    for (let invocation = 0; invocation < scope.maxAttempts; invocation++) {
      assertActive(signal);
      let result;
      let thrown;
      const before = scope.attempts;
      try { result = await send(); } catch (error) { thrown = error instanceof Error ? error : new Error(String(error)); }
      if (!thrown && result?.ok !== false) {
        recordProviderRequestUsage(result?.streamUsage ?? null);
        if (invocation) webContents?.send?.('chat:stream:connection-recovery', {
          streamId, provider, model, status: 'recovered', attempt: scope.attempts,
          maxRetries: scope.maxAttempts - 1, connection: scope.connection ?? null,
        });
        return result;
      }
      const failure = thrown || result;
      scope.partial ||= hasPartial(failure);
      const detail = failureDetails(failure, scope);
      const count = scope.transportObserved ? scope.attempts : invocation + 1;
      const exhausted = count >= scope.maxAttempts;
      const metadata = { ...detail, requestId: scope.requestId, attempts: count,
        maxAttempts: scope.maxAttempts, exhausted, replaySafe: !scope.partial,
        retryable: detail.retryable };
      scope.lastFailure = metadata;
      if (scope.attempts > before) recordProviderRequestUsage(result?.streamUsage ?? null);
      if (thrown) thrown.providerRecovery = metadata;
      else result = { ...result, providerRecovery: metadata };
      if (!metadata.retryable || !metadata.replaySafe || exhausted) {
        if (thrown) throw thrown;
        return result;
      }
      const delayMs = delays[Math.min(count - 1, delays.length - 1)];
      webContents?.send?.('chat:stream:connection-recovery', { streamId, provider, model,
        status: 'retrying', attempt: count, maxRetries: scope.maxAttempts - 1,
        delayMs, reason: detail.kind, connection: scope.connection ?? null, providerRecovery: metadata });
      await waitImpl(delayMs, signal);
    }
    throw new Error('provider_request_recovery_exhausted');
  });
}
