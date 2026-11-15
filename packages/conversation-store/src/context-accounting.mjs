import {contextAccountingModelKey,normalizeContextUsageBreakdown} from '@peer-agent/protocol';
const normalizeModelProviderId=v=>typeof v==='string'&&v.trim()?v.trim():null;
export function unknownCompactionContext(meta,binding) {
  if(!binding || binding.selectionVersion!==1)return null;
  const revision=Number(meta.contentRevision??0);
  if(!Number.isSafeInteger(revision)||revision<0)return null;
  return {version:1,conversationId:meta.id,contentRevision:revision,modelKey:contextAccountingModelKey(meta.modelProviderId,meta.model),revision:0,phase:'post_compaction',compactionEpoch:binding.compactionEpoch,contextWindow:null,inputBudget:null,compactionThresholdTokens:null,authoritativeInputTokens:null,percent:null,pressureSource:'unknown',pendingUncountedChanges:true,pendingContentChars:0,countCapability:{kind:'unavailable'},counterStatus:'active',updatedAt:0,projectorVersion:3,compactionBoundaryId:binding.compactionBoundaryId};
}
const owned=new Set(['version','conversationId','contentRevision','modelKey','revision','phase','compactionEpoch','contextWindow','inputBudget','compactionThresholdTokens','authoritativeInputTokens','percent','pressureSource','pendingUncountedChanges','pendingContentChars','countCapability','counterStatus','updatedAt','lastObserved','nextCounted','lastOverflow','verification','usageBreakdown','projectorVersion','compactionBoundaryId']);
export function mergeContextSnapshot(previous,next) {
  return {...Object.fromEntries(Object.entries(previous??{}).filter(([key])=>!owned.has(key))),...next};
}
export function normalizeContextSnapshot(snapshot, meta) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.version !== 1) return null;
  const conversationId = typeof snapshot.conversationId === 'string'
    ? snapshot.conversationId.trim()
    : '';
  const contentRevision = Number(snapshot.contentRevision);
  const modelKey = typeof snapshot.modelKey === 'string' ? snapshot.modelKey.trim() : '';
  const revision = Number(snapshot.revision);
  const compactionEpoch = Number(snapshot.compactionEpoch);
  if (!conversationId || !modelKey) return null;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 0) return null;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  if (!Number.isSafeInteger(compactionEpoch) || compactionEpoch < 0) return null;
  const phases = new Set([
    'request_preflight',
    'stream_preview',
    'tool_result',
    'post_compaction',
    'turn_complete',
    'restored',
    'model_changed',
  ]);
  if (!phases.has(snapshot.phase)) return null;
  const normalizeNullablePositive = (value) => {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
  };
  const normalizeNullableNonNegative = (value) => {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const contextWindow = normalizeNullablePositive(snapshot.contextWindow);
  const inputBudget = normalizeNullablePositive(snapshot.inputBudget);
  const compactionThresholdTokens = normalizeNullablePositive(snapshot.compactionThresholdTokens);
  const authoritativeInputTokens = normalizeNullableNonNegative(snapshot.authoritativeInputTokens);
  const percent = normalizeNullableNonNegative(snapshot.percent);
  if (
    contextWindow === undefined
    || inputBudget === undefined
    || compactionThresholdTokens === undefined
    || authoritativeInputTokens === undefined
    || percent === undefined
  ) return null;
  const pressureSources = new Set([
    'provider_usage',
    'provider_count_api',
    'provider_tokenizer',
    'provider_error_evidence',
    'unknown',
  ]);
  if (!pressureSources.has(snapshot.pressureSource)) return null;
  if (typeof snapshot.pendingUncountedChanges !== 'boolean') return null;
  const pendingContentChars = Number(snapshot.pendingContentChars);
  if (!Number.isSafeInteger(pendingContentChars) || pendingContentChars < 0) return null;
  const capability = snapshot.countCapability;
  if (!capability || typeof capability !== 'object') return null;
  if (![
    'provider_count_api',
    'provider_tokenizer',
    'observed_usage_only',
    'unavailable',
  ].includes(capability.kind)) return null;
  if (
    capability.kind === 'provider_tokenizer'
    && (typeof capability.tokenizerVersion !== 'string' || !capability.tokenizerVersion.trim())
  ) return null;
  if (snapshot.counterStatus !== 'active' && snapshot.counterStatus !== 'degraded') return null;
  const updatedAt = Number(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (conversationId !== String(meta?.id ?? '')) return null;
  if (contentRevision !== Number(meta?.contentRevision ?? 0)) return null;
  const providerBinding = normalizeModelProviderId(meta?.modelProviderId);
  const storedModel = typeof meta?.model === 'string' && meta.model.trim()
    ? meta.model.trim()
    : null;
  const expectedModelKey = contextAccountingModelKey(providerBinding, storedModel);
  const legacyModelKey = providerBinding ?? storedModel;
  if (modelKey !== expectedModelKey && modelKey !== legacyModelKey) return null;
  const usageBreakdown = normalizeContextUsageBreakdown(snapshot.usageBreakdown);
  const normalized = {
    ...snapshot,
    version: 1,
    conversationId,
    contentRevision,
    modelKey: expectedModelKey,
    revision,
    phase: snapshot.phase,
    compactionEpoch,
    contextWindow,
    inputBudget,
    compactionThresholdTokens,
    authoritativeInputTokens,
    percent,
    pressureSource: snapshot.pressureSource,
    pendingUncountedChanges: snapshot.pendingUncountedChanges,
    pendingContentChars,
    countCapability: capability.kind === 'provider_tokenizer'
      ? { kind: capability.kind, tokenizerVersion: capability.tokenizerVersion.trim() }
      : { kind: capability.kind },
    counterStatus: snapshot.counterStatus,
    updatedAt,
  };
  if (usageBreakdown) normalized.usageBreakdown = usageBreakdown;
  else delete normalized.usageBreakdown;
  return normalized;
}

export function projectDurableContextSnapshot(snapshot, meta) {
  const exact = normalizeContextSnapshot(snapshot, meta);
  if (exact) return exact;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.version !== 1) return null;
  const conversationId = typeof snapshot.conversationId === 'string'
    ? snapshot.conversationId.trim()
    : '';
  if (!conversationId || conversationId !== String(meta?.id ?? '')) return null;
  const observation = snapshot.lastObserved;
  if (observation?.supersededByCompactionRevision !== undefined || Number(observation?.compactionEpoch) !== Number(snapshot.compactionEpoch)) return null;
  if (!observation || typeof observation !== 'object') return null;
  if (observation.source !== 'provider_usage') return null;
  const inputTokens = Number(observation.inputTokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
  const modelKey = typeof snapshot.modelKey === 'string' ? snapshot.modelKey.trim() : '';
  if (!modelKey) return null;
  const providerBinding = normalizeModelProviderId(meta?.modelProviderId);
  const storedModel = typeof meta?.model === 'string' && meta.model.trim()
    ? meta.model.trim()
    : null;
  const expectedModelKey = contextAccountingModelKey(providerBinding, storedModel);
  const legacyModelKey = providerBinding ?? storedModel;
  if (modelKey !== expectedModelKey && modelKey !== legacyModelKey) return null;
  const contentRevisionRaw = Number(meta?.contentRevision);
  const contentRevision = Number.isSafeInteger(contentRevisionRaw) && contentRevisionRaw >= 0
    ? contentRevisionRaw
    : 0;
  const revisionRaw = Number(snapshot.revision);
  const revision = Number.isSafeInteger(revisionRaw) && revisionRaw >= 0 ? revisionRaw : 0;
  const compactionEpochRaw = Number(
    observation.compactionEpoch ?? snapshot.compactionEpoch ?? 0,
  );
  const compactionEpoch = Number.isSafeInteger(compactionEpochRaw) && compactionEpochRaw >= 0
    ? compactionEpochRaw
    : 0;
  const normalizeNullablePositive = (value) => {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
  };
  const contextWindow = normalizeNullablePositive(snapshot.contextWindow);
  const inputBudget = normalizeNullablePositive(snapshot.inputBudget) ?? contextWindow;
  const compactionThresholdTokens = normalizeNullablePositive(snapshot.compactionThresholdTokens)
    ?? (contextWindow == null ? null : Math.floor(contextWindow * 0.8));
  const observedAtRaw = Number(observation.observedAt ?? snapshot.updatedAt);
  const updatedAt = Number.isFinite(observedAtRaw) && observedAtRaw >= 0
    ? observedAtRaw
    : Date.now();
  const requestFingerprint = typeof observation.requestFingerprint === 'string'
    ? observation.requestFingerprint.trim()
    : '';
  const countCapability = snapshot.countCapability && typeof snapshot.countCapability === 'object'
    ? snapshot.countCapability
    : { kind: 'observed_usage_only' };
  const counterStatus = snapshot.counterStatus === 'degraded' ? 'degraded' : 'active';
  const usageBreakdown = normalizeContextUsageBreakdown(snapshot.usageBreakdown);
  return {
    version: 1,
    conversationId,
    contentRevision,
    modelKey,
    revision,
    phase: 'restored',
    compactionEpoch,
    contextWindow,
    inputBudget,
    compactionThresholdTokens,
    authoritativeInputTokens: inputTokens,
    percent: contextWindow == null
      ? null
      : Math.min(100, Math.round((inputTokens / contextWindow) * 100)),
    pressureSource: 'provider_usage',
    pendingUncountedChanges: true,
    pendingContentChars: 0,
    countCapability,
    counterStatus,
    updatedAt,
    lastObserved: {
      inputTokens,
      requestFingerprint: requestFingerprint
        || `restored_observation_${conversationId}_${compactionEpoch}`,
      compactionEpoch,
      source: 'provider_usage',
      observedAt: updatedAt,
    },
    ...(usageBreakdown ? { usageBreakdown } : {}),
  };
}



