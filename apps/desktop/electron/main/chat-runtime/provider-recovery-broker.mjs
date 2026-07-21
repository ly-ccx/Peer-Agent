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

const SAME_PROVIDER_RETRY_PATTERNS = [
  /fetch failed/i,
  /network/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /UND_ERR_|HeadersTimeoutError|ConnectTimeoutError|SocketError/i,
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

export function isSameProviderRetryableFailure(errorText) {
  const text = String(errorText || '');
  return SAME_PROVIDER_RETRY_PATTERNS.some((pattern) => pattern.test(text));
}

export function providerCanRun(provider) {
  return Boolean(provider && provider.enabled !== false && provider.apiKeyConfigured);
}

function modelKey(provider) {
  return String(provider?.model || '').trim().toLowerCase();
}

function providerModelExact(provider) {
  return String(provider?.model || '').trim();
}

function splitCompositeProviderId(modelProviderId) {
  if (!modelProviderId || !modelProviderId.includes('::')) {
    return { groupId: '', model: '' };
  }
  const separator = modelProviderId.indexOf('::');
  return {
    groupId: modelProviderId.slice(0, separator).trim(),
    model: modelProviderId.slice(separator + 2).trim(),
  };
}

/**
 * 解析会话绑定的 modelProviderId 到真实 provider 记录。
 *
 * 兼容历史形态：
 * - 模型条目 id（uuid）
 * - 复合 id：groupId::model
 * - 渠道 / 组 groupId（回退到该组下第一条记录）
 *
 * 解析失败返回 null，由调用方决定是否回退默认——不要在这里静默替换。
 */
export function resolvePreferredProvider(providers = [], preferredProviderId = null) {
  if (!preferredProviderId || !Array.isArray(providers) || !providers.length) return null;

  const exact = providers.find((provider) => provider?.id === preferredProviderId) || null;
  if (exact) return exact;

  const composite = splitCompositeProviderId(preferredProviderId);
  if (composite.groupId && composite.model) {
    const byComposite = providers.find((provider) => {
      const groupId = typeof provider?.groupId === 'string' ? provider.groupId.trim() : '';
      const model = providerModelExact(provider);
      return (
        model === composite.model
        && (
          groupId === composite.groupId
          || provider?.id === composite.groupId
        )
      );
    }) || null;
    if (byComposite) return byComposite;
  }

  // 纯 groupId：取该组下第一条（listProviders 顺序稳定）。
  return providers.find((provider) => {
    const groupId = typeof provider?.groupId === 'string' ? provider.groupId.trim() : '';
    return groupId === preferredProviderId || provider?.id === preferredProviderId;
  }) || null;
}

/**
 * 回答结束后写回会话 modelProviderId 的策略：
 * - 会话无绑定：写 actual（首轮绑定）
 * - 绑定可解析（含 legacy groupId::model）：写真实记录 id（顺带迁移）
 * - 绑定解析失败：不写 modelProviderId（避免默认覆盖）
 */
export function resolveConversationModelBindingPatch({
  providers = [],
  requestedModelProviderId = null,
  actualModelProviderId = null,
  actualModel = null,
} = {}) {
  const patch = {};
  if (actualModel) patch.model = actualModel;

  if (!requestedModelProviderId) {
    if (actualModelProviderId) patch.modelProviderId = actualModelProviderId;
    return patch;
  }

  const resolvedPreferred = resolvePreferredProvider(providers, requestedModelProviderId);
  if (resolvedPreferred?.id) {
    patch.modelProviderId = resolvedPreferred.id;
  }
  return patch;
}

export function orderProviderCandidates(providers = [], preferredProviderId = null) {
  const runnable = providers.filter(providerCanRun);
  if (!runnable.length) return [];
  // 会话级首选 provider（会话 meta 里的 modelProviderId）优先：若指定且该 provider 仍可运行，
  // 就把它排首位作为本轮主 provider。兼容历史 groupId::model / groupId 绑定。
  //
  // 强绑定校验：这里是「provider 被删/失效时回退默认」的落点。指定的 preferredProviderId
  // 若已被删除、禁用或未配置密钥，preferred 会落空，主 provider 自动
  // 回退到全局默认（isDefault）→ 首个可运行 provider，绝不因会话里残留的失效绑定而报错。
  const preferred = resolvePreferredProvider(runnable, preferredProviderId);
  const primary = preferred ?? runnable.find((provider) => provider.isDefault) ?? runnable[0] ?? null;
  if (!primary) return [];
  const primaryModel = modelKey(primary);
  return [
    primary,
    ...runnable.filter((provider) => (
      provider.id !== primary.id
      && modelKey(provider)
      && modelKey(provider) === primaryModel
    )),
  ];
}

export function canReplayProviderAttempt({ errorText, observedReplayUnsafeEvent = false } = {}) {
  return !observedReplayUnsafeEvent && isProviderTransportFailure(errorText);
}

export function canRetrySameProviderAttempt({ errorText, observedReplayUnsafeEvent = false } = {}) {
  return !observedReplayUnsafeEvent && isSameProviderRetryableFailure(errorText);
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
      sameProviderRetryable: Boolean(terminalError) && canRetrySameProviderAttempt({
        errorText,
        observedReplayUnsafeEvent,
      }),
    };
  }

  return { webContents: { send }, getResult, flushError };
}
