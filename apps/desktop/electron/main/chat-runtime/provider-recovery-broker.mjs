// Provider recovery broker: classify provider transport failures and select a
// safe fallback provider for the same user turn.
//
// Boundary: this module does not execute tools and does not decide task
// completion. It only permits replay before any model output/tool intent was
// observed.

const TRANSPORT_FAILURE_PATTERNS = [
  /fetch failed/i,
  /network/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /UND_ERR_|HeadersTimeoutError|ConnectTimeoutError|SocketError/i,
  /unexpected status 403 forbidden/i,
  /HTTP 403/i,
  /not allowed by the default security policy/i,
  /不在安全策略默认允许的范围内/i,
  /域名拦截/i,
  /Domain Blocking/i,
];

const REPLAY_UNSAFE_CHANNELS = new Set([
  'chat:stream:delta',
  'chat:stream:thinking',
  'chat:stream:tool-call',
  'chat:stream:tool-progress',
  'chat:stream:tool-result',
  'chat:stream:permission-request',
  'chat:stream:usage',
]);

export function describeProviderTarget(provider) {
  return [provider?.name || provider?.provider || 'provider', provider?.model]
    .filter(Boolean)
    .join(' / ');
}

export function describeFetchFailure(error) {
  const base = error?.message || 'stream_failed';
  const cause = error?.cause;
  if (!cause) return base;
  const code = cause.code ? String(cause.code) : '';
  const detail = cause.message ? String(cause.message) : '';
  const extra = [code, detail].filter(Boolean).join(': ');
  return extra ? `${base} (${extra})` : base;
}

export function isProviderTransportFailure(errorText) {
  const text = String(errorText || '');
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function providerCanRun(provider) {
  return Boolean(provider && provider.enabled !== false && provider.apiKeyConfigured);
}

function modelKey(provider) {
  return String(provider?.model || '').trim().toLowerCase();
}

export function orderProviderCandidates(providers = []) {
  const runnable = providers.filter(providerCanRun);
  const defaultProvider = runnable.find((provider) => provider.isDefault) ?? runnable[0] ?? null;
  if (!defaultProvider) return [];
  const defaultModel = modelKey(defaultProvider);
  return [
    defaultProvider,
    ...runnable.filter((provider) => (
      provider.id !== defaultProvider.id
      && modelKey(provider)
      && modelKey(provider) === defaultModel
    )),
  ];
}

export function canReplayProviderAttempt({ errorText, observedReplayUnsafeEvent = false } = {}) {
  return !observedReplayUnsafeEvent && isProviderTransportFailure(errorText);
}

export function createProviderAttemptStream({ webContents, streamId, provider }) {
  let terminalError = null;
  let terminalSent = false;
  let observedReplayUnsafeEvent = false;

  function send(channel, payload) {
    if (REPLAY_UNSAFE_CHANNELS.has(channel)) {
      observedReplayUnsafeEvent = true;
    }
    if (channel === 'chat:stream:error') {
      terminalError = {
        channel,
        payload: {
          ...(payload || {}),
          streamId: payload?.streamId ?? streamId,
        },
      };
      return undefined;
    }
    if (channel === 'chat:stream:done' || channel === 'chat:stream:aborted') {
      terminalSent = true;
    }
    return webContents?.send?.(channel, payload);
  }

  function flushError() {
    if (!terminalError) return false;
    terminalSent = true;
    webContents?.send?.(terminalError.channel, terminalError.payload);
    return true;
  }

  function getResult() {
    const errorText = terminalError?.payload?.error ?? null;
    return {
      provider,
      terminalSent,
      terminalError,
      errorText,
      observedReplayUnsafeEvent,
      replayable: Boolean(terminalError) && canReplayProviderAttempt({
        errorText,
        observedReplayUnsafeEvent,
      }),
    };
  }

  return { webContents: { send }, getResult, flushError };
}
