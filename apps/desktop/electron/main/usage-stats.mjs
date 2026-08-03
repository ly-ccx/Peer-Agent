/**
 * 跨会话用量汇总（精简版使用统计）。
 *
 * 数据源（主）：usage/requests.jsonl 请求级快照（当次请求实际模型 + 当时单价），
 * 切换 Provider 后历史成本仍归因到各自模型，不串账。
 * 数据源（回退）：conversation index meta.lifetimeUsage + 当前配置单价估算，
 * 仅在没有请求快照时使用。
 */

import { createUsageRequestLog } from './usage-request-log.mjs';

const TOKENS_PER_MILLION = 1_000_000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function emptyTokenBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

export function readLifetimeUsage(meta) {
  const usage = meta?.lifetimeUsage || {};
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens);
  const cacheWriteTokens = finiteNumber(usage.cacheWriteTokens);
  const totalTokens = finiteNumber(usage.totalTokens)
    || (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export function addTokenBuckets(a, b) {
  return {
    inputTokens: finiteNumber(a?.inputTokens) + finiteNumber(b?.inputTokens),
    outputTokens: finiteNumber(a?.outputTokens) + finiteNumber(b?.outputTokens),
    cacheReadTokens: finiteNumber(a?.cacheReadTokens) + finiteNumber(b?.cacheReadTokens),
    cacheWriteTokens: finiteNumber(a?.cacheWriteTokens) + finiteNumber(b?.cacheWriteTokens),
    totalTokens: finiteNumber(a?.totalTokens) + finiteNumber(b?.totalTokens),
  };
}

/**
 * @param {object} usage token bucket
 * @param {{ inputPrice?: number|null, outputPrice?: number|null, cacheReadPrice?: number|null, cacheWritePrice?: number|null }} pricing
 * @returns {{ estimatedCostUsd: number|null, hasPricing: boolean }}
 */
export function estimateUsageCostUsd(usage, pricing = {}) {
  const inputPrice = optionalPrice(pricing.inputPrice);
  const outputPrice = optionalPrice(pricing.outputPrice);
  const cacheReadPrice = optionalPrice(pricing.cacheReadPrice);
  const cacheWritePrice = optionalPrice(pricing.cacheWritePrice);
  const hasPricing = [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice]
    .some((price) => price != null);
  if (!hasPricing) {
    return { estimatedCostUsd: null, hasPricing: false };
  }

  const cost =
    (finiteNumber(usage.inputTokens) * (inputPrice ?? 0)
      + finiteNumber(usage.outputTokens) * (outputPrice ?? 0)
      + finiteNumber(usage.cacheReadTokens) * (cacheReadPrice ?? 0)
      + finiteNumber(usage.cacheWriteTokens) * (cacheWritePrice ?? 0))
    / TOKENS_PER_MILLION;

  return { estimatedCostUsd: cost, hasPricing: true };
}

const UNBOUND_PROVIDER_KEY = 'unbound';
const UNBOUND_PROVIDER_LABEL = '未绑定 Provider';
const UNBOUND_MODEL_LABEL = '未绑定模型';

function providerLookupKey(provider) {
  if (!provider) return '';
  return String(provider.id || '').trim();
}

function providerGroupKey(provider) {
  if (!provider) return '';
  return String(provider.groupId || provider.id || '').trim();
}

function providerModelKey(provider) {
  if (!provider) return '';
  return String(provider.model || '').trim();
}

function providerDisplayName(provider) {
  if (!provider) return '';
  return typeof provider.name === 'string' ? provider.name.trim() : '';
}

function providerModelLabel(provider) {
  if (!provider) return '';
  const label = typeof provider.modelLabel === 'string' ? provider.modelLabel.trim() : '';
  if (label) return label;
  return providerModelKey(provider);
}

/**
 * 索引真实会话里常见的 modelProviderId 形态：
 * - 模型条目 id（uuid）
 * - 渠道 / 组 groupId
 * - 复合 id：groupId::model
 */
export function buildProviderIndex(providers = []) {
  const byId = new Map();
  const byGroupId = new Map();
  const byComposite = new Map();

  for (const provider of providers) {
    const id = providerLookupKey(provider);
    const groupId = providerGroupKey(provider);
    const model = providerModelKey(provider);

    if (id) {
      byId.set(id, provider);
    }
    if (groupId && !byGroupId.has(groupId)) {
      byGroupId.set(groupId, provider);
    }
    // 有些历史/展开记录把 groupId 也当成 id 写过。
    if (groupId && !byId.has(groupId)) {
      byId.set(groupId, provider);
    }
    if (groupId && model) {
      byComposite.set(`${groupId}::${model}`, provider);
    }
  }

  return { byId, byGroupId, byComposite };
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

function resolveProviderRecord(modelProviderId, providerIndex) {
  if (!modelProviderId || !providerIndex) return null;

  const exact = providerIndex.byId.get(modelProviderId)
    || providerIndex.byComposite.get(modelProviderId)
    || null;
  if (exact) return exact;

  const composite = splitCompositeProviderId(modelProviderId);
  if (composite.groupId && composite.model) {
    const byComposite = providerIndex.byComposite.get(`${composite.groupId}::${composite.model}`);
    if (byComposite) return byComposite;

    // 组内任意模型先拿来回填渠道名 / 单价；具体 model 文案用 composite.model。
    return providerIndex.byGroupId.get(composite.groupId)
      || providerIndex.byId.get(composite.groupId)
      || null;
  }

  return providerIndex.byGroupId.get(modelProviderId) || null;
}

/**
 * 稳定的「按模型」分组 key：groupId::modelId。
 * 把 groupId / groupId::model / 模型条目 id 等不同绑定形态合并到同一行。
 */
function stableModelGroupKey(groupKey, modelId) {
  const group = String(groupKey || UNBOUND_PROVIDER_KEY).trim() || UNBOUND_PROVIDER_KEY;
  const model = String(modelId || UNBOUND_MODEL_LABEL).trim() || UNBOUND_MODEL_LABEL;
  return `${group}::${model}`;
}

function resolveConversationPricing(meta, providerIndex) {
  const modelProviderId = typeof meta?.modelProviderId === 'string'
    ? meta.modelProviderId.trim()
    : '';
  const composite = splitCompositeProviderId(modelProviderId);
  const provider = resolveProviderRecord(modelProviderId, providerIndex);

  // 未绑定会话：走全局默认 provider，不要显示 unknown。
  if (!modelProviderId) {
    return {
      modelProviderId: null,
      provider: null,
      model: UNBOUND_MODEL_LABEL,
      modelId: UNBOUND_MODEL_LABEL,
      providerName: UNBOUND_PROVIDER_LABEL,
      groupKey: UNBOUND_PROVIDER_KEY,
      groupLabel: UNBOUND_PROVIDER_LABEL,
      pricing: {
        inputPrice: null,
        outputPrice: null,
        cacheReadPrice: null,
        cacheWritePrice: null,
      },
    };
  }

  const groupKey = provider
    ? (providerGroupKey(provider) || composite.groupId || modelProviderId)
    : (composite.groupId || modelProviderId);
  const groupLabel = providerDisplayName(provider)
    || providerDisplayName(providerIndex?.byGroupId?.get(groupKey))
    || groupKey;

  const metaModel = typeof meta?.model === 'string' && meta.model.trim()
    ? meta.model.trim()
    : '';
  const providerModel = providerModelKey(provider);

  // 规范 modelId：用于分组合并，优先会话显式 model / 复合 id，再回落 provider 配置。
  const modelId = metaModel
    || composite.model
    || providerModel
    || modelProviderId;

  // 展示名：优先精确模型条目的 label，避免把 modelId 与 label 混作分组 key。
  const exactModelProvider = providerIndex?.byComposite?.get(`${groupKey}::${modelId}`) || null;
  const labelProvider = (exactModelProvider && providerModelKey(exactModelProvider) === modelId)
    ? exactModelProvider
    : (provider && providerModel === modelId ? provider : null);
  const model = providerModelLabel(labelProvider)
    || providerModelLabel(exactModelProvider)
    || metaModel
    || composite.model
    || providerModelLabel(provider)
    || modelId;

  // 单价优先用精确模型条目，避免只绑 groupId 时误用其它模型价。
  const pricingProvider = exactModelProvider
    || (provider && providerModel === modelId ? provider : null)
    || provider;

  return {
    modelProviderId,
    provider: pricingProvider || provider,
    model,
    modelId,
    providerName: groupLabel,
    groupKey,
    groupLabel,
    pricing: {
      inputPrice: optionalPrice(pricingProvider?.inputPrice),
      outputPrice: optionalPrice(pricingProvider?.outputPrice),
      cacheReadPrice: optionalPrice(pricingProvider?.cacheReadPrice),
      cacheWritePrice: optionalPrice(pricingProvider?.cacheWritePrice),
    },
  };
}

function sortGroupRows(rows) {
  return [...rows].sort((a, b) => {
    const costA = a.estimatedCostUsd == null ? -1 : a.estimatedCostUsd;
    const costB = b.estimatedCostUsd == null ? -1 : b.estimatedCostUsd;
    if (costB !== costA) return costB - costA;
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    return String(a.label).localeCompare(String(b.label));
  });
}

/**
 * 请求级快照（usage/requests.jsonl 记录）按 Provider / 模型聚合。
 *
 * 与按会话 lifetimeUsage 聚合的本质区别：每条记录的 tokens 与成本都按
 * 「当次请求实际使用的模型 + 当时单价」落账（estimatedCostUsd 已在写入时算好），
 * 因此切换 Provider 后历史成本仍归因到各自模型，不会串账。
 *
 * @param {readonly object[]} requests usage-request-log 的 readAll() 记录
 * @param {{ providerIndex?: { byId?: Map, byGroupId?: Map, byComposite?: Map } | null }} [options]
 *   providerIndex 用于把历史裸 uuid 记录归一到渠道 groupId（新写入行已自带 groupId 字段，
 *   见 usage-request-log 的 resolveGroupId）。索引缺失或查不到时回退原 key，不破历史行为。
 * @returns {{ totals: object, byProvider: Map<string, object>, byModel: Map<string, object>,
 *            estimatedCostUsd: number, hasAnyPricing: boolean, requestCount: number }}
 */
export function aggregateRequestUsage(requests = [], { providerIndex = null } = {}) {
  const totals = emptyTokenBucket();
  /** @type {Map<string, any>} */
  const byProvider = new Map();
  /** @type {Map<string, any>} */
  const byModel = new Map();
  let estimatedCostUsd = 0;
  let hasAnyPricing = false;
  let requestCount = 0;

  const bucketFromRow = (row) => ({
    inputTokens: finiteNumber(row.inputTokens),
    outputTokens: finiteNumber(row.outputTokens),
    cacheReadTokens: finiteNumber(row.cacheReadTokens),
    cacheWriteTokens: finiteNumber(row.cacheWriteTokens),
    totalTokens: finiteNumber(row.totalTokens)
      || (finiteNumber(row.inputTokens) + finiteNumber(row.outputTokens)
        + finiteNumber(row.cacheReadTokens) + finiteNumber(row.cacheWriteTokens)),
  });

  const modelProviderId = (row) => (
    typeof row.modelProviderId === 'string' && row.modelProviderId.trim()
      ? row.modelProviderId.trim()
      : UNBOUND_PROVIDER_KEY
  );
  const providerKey = (row) => {
    // 归组优先级：写入层落的 groupId（新数据真值）> 复合 id 拆出的 groupId
    // > provider 索引把历史裸 uuid 归一到渠道 groupId > 原值回退（历史行渠道已删除等）。
    const writtenGroupId = typeof row.groupId === 'string' && row.groupId.trim()
      ? row.groupId.trim()
      : '';
    if (writtenGroupId && writtenGroupId !== UNBOUND_PROVIDER_KEY) return writtenGroupId;
    const composite = splitCompositeProviderId(modelProviderId(row));
    if (composite.groupId) return composite.groupId;
    const rawId = modelProviderId(row);
    if (rawId === UNBOUND_PROVIDER_KEY) return rawId;
    if (providerIndex && !composite.model) {
      const byId = providerIndex.byId;
      const byGroupId = providerIndex.byGroupId;
      const hit = (typeof byId?.get === 'function' ? byId.get(rawId) : null)
        || (typeof byGroupId?.get === 'function' ? byGroupId.get(rawId) : null);
      const resolvedGroup = hit ? providerGroupKey(hit) : '';
      if (resolvedGroup) return resolvedGroup;
    }
    return rawId;
  };
  const displayModel = (row) => {
    const recorded = typeof row.model === 'string' && row.model.trim()
      ? row.model.trim()
      : (row.providerName || modelProviderId(row));
    if (!providerIndex) return recorded;
    const rawId = modelProviderId(row);
    if (rawId === UNBOUND_PROVIDER_KEY) return recorded;
    // label 展示态：快照只落了模型 id，显示时借 provider 索引反查用户可见的 modelLabel。
    const byId = providerIndex.byId;
    const byComposite = providerIndex.byComposite;
    const hit = (typeof byId?.get === 'function' ? byId.get(rawId) : null)
      || (typeof byComposite?.get === 'function' ? byComposite.get(rawId) : null);
    const label = hit ? providerModelLabel(hit) : '';
    return label || recorded;
  };

  for (const row of requests) {
    if (!row || typeof row !== 'object') continue;
    const bucket = bucketFromRow(row);
    if (
      bucket.inputTokens === 0
      && bucket.outputTokens === 0
      && bucket.cacheReadTokens === 0
      && bucket.cacheWriteTokens === 0
    ) {
      continue;
    }
    requestCount += 1;
    Object.assign(totals, addTokenBuckets(totals, bucket));

    const cost = finiteNumber(row.estimatedCostUsd);
    const priced = cost > 0 || row.pricingSource != null;

    // Provider 维度。
    const pKey = providerKey(row);
    const providerRow = byProvider.get(pKey) || {
      key: pKey,
      label: row.providerName || pKey,
      providerId: pKey === UNBOUND_PROVIDER_KEY ? null : pKey,
      providerName: row.providerName || null,
      conversationCount: 0,
      requestCount: 0,
      ...emptyTokenBucket(),
      estimatedCostUsd: 0,
      hasPricing: false,
    };
    providerRow.conversationCount += 1;
    providerRow.requestCount += 1;
    Object.assign(providerRow, { ...providerRow, ...addTokenBuckets(providerRow, bucket) });
    if (priced) {
      providerRow.hasPricing = true;
      providerRow.estimatedCostUsd += cost;
    }
    byProvider.set(pKey, providerRow);

    // 模型维度：key = modelProviderId（含模型），label 用记录 model。
    const mKey = modelProviderId(row);
    const modelRow = byModel.get(mKey) || {
      key: mKey,
      label: displayModel(row),
      providerId: pKey === UNBOUND_PROVIDER_KEY ? null : pKey,
      providerName: row.providerName || null,
      model: displayModel(row),
      conversationCount: 0,
      requestCount: 0,
      ...emptyTokenBucket(),
      estimatedCostUsd: 0,
      hasPricing: false,
    };
    modelRow.conversationCount += 1;
    modelRow.requestCount += 1;
    Object.assign(modelRow, { ...modelRow, ...addTokenBuckets(modelRow, bucket) });
    if (displayModel(row) !== mKey) {
      modelRow.label = displayModel(row);
      modelRow.model = displayModel(row);
    }
    if (priced) {
      modelRow.hasPricing = true;
      modelRow.estimatedCostUsd += cost;
    }
    byModel.set(mKey, modelRow);

    if (priced) {
      hasAnyPricing = true;
      estimatedCostUsd += cost;
    }
  }

  return { totals, byProvider, byModel, estimatedCostUsd, hasAnyPricing, requestCount };
}

/**
 * @param {{ conversations?: readonly object[], providers?: readonly object[], requests?: readonly object[], generatedAt?: string }} input
 */
export function buildUsageStatsSnapshot({
  conversations = [],
  providers = [],
  requests = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  // 主路径：请求级快照聚合。成本按当次请求实际模型与当时单价归因，切模型不串账。
  // providerIndex 用于把历史裸 uuid 快照归一到渠道 groupId，保证「按 Provider」一行一渠道。
  if (Array.isArray(requests) && requests.length > 0) {
    const aggregated = aggregateRequestUsage(requests, {
      providerIndex: buildProviderIndex(providers),
    });
    const finalizeRow = (row) => ({
      ...row,
      estimatedCostUsd: row.hasPricing ? row.estimatedCostUsd : null,
    });
    return {
      generatedAt,
      totals: {
        ...aggregated.totals,
        conversationCount: aggregated.requestCount,
        pricedConversationCount: aggregated.hasAnyPricing ? aggregated.requestCount : 0,
        estimatedCostUsd: aggregated.hasAnyPricing ? aggregated.estimatedCostUsd : null,
      },
      byProvider: sortGroupRows([...aggregated.byProvider.values()].map(finalizeRow)),
      byModel: sortGroupRows([...aggregated.byModel.values()].map(finalizeRow)),
      notes: {
        unpricedConversationCount: 0,
        missingProviderCount: 0,
        pricingUnit: 'USD_per_1M_tokens',
        scope: 'request_snapshot',
        requestCount: aggregated.requestCount,
      },
    };
  }

  // 回退路径：无请求日志时保留原「会话 lifetimeUsage × 当前单价」估算。
  const providerIndex = buildProviderIndex(providers);
  const totals = emptyTokenBucket();
  let conversationCount = 0;
  let pricedConversationCount = 0;
  let unpricedConversationCount = 0;
  let missingProviderCount = 0;
  let estimatedCostUsd = 0;
  let hasAnyPricing = false;

  /** @type {Map<string, any>} */
  const byProvider = new Map();
  /** @type {Map<string, any>} */
  const byModel = new Map();

  for (const meta of conversations) {
    if (!meta || typeof meta !== 'object') continue;
    const usage = readLifetimeUsage(meta);
    if (
      usage.inputTokens === 0
      && usage.outputTokens === 0
      && usage.cacheReadTokens === 0
      && usage.cacheWriteTokens === 0
    ) {
      // 仍计入会话数，便于展示「有多少会话参与了账本」。
    }
    conversationCount += 1;
    Object.assign(totals, addTokenBuckets(totals, usage));

    const resolved = resolveConversationPricing(meta, providerIndex);
    if (!resolved.provider && resolved.modelProviderId) missingProviderCount += 1;
    if (!resolved.modelProviderId) missingProviderCount += 1;

    const cost = estimateUsageCostUsd(usage, resolved.pricing);
    if (cost.hasPricing) {
      pricedConversationCount += 1;
      hasAnyPricing = true;
      estimatedCostUsd += cost.estimatedCostUsd || 0;
    } else {
      unpricedConversationCount += 1;
    }

    const providerRow = byProvider.get(resolved.groupKey) || {
      key: resolved.groupKey,
      label: resolved.groupLabel,
      providerId: resolved.groupKey === UNBOUND_PROVIDER_KEY ? null : resolved.groupKey,
      providerName: resolved.providerName,
      conversationCount: 0,
      ...emptyTokenBucket(),
      estimatedCostUsd: 0,
      hasPricing: false,
    };
    providerRow.conversationCount += 1;
    Object.assign(providerRow, {
      ...providerRow,
      ...addTokenBuckets(providerRow, usage),
    });
    if (cost.hasPricing) {
      providerRow.hasPricing = true;
      providerRow.estimatedCostUsd += cost.estimatedCostUsd || 0;
    }
    if (!providerRow.label || providerRow.label === UNBOUND_PROVIDER_LABEL) {
      providerRow.label = resolved.groupLabel;
    }
    byProvider.set(resolved.groupKey, providerRow);

    const modelKey = stableModelGroupKey(resolved.groupKey, resolved.modelId);
    const modelRow = byModel.get(modelKey) || {
      key: modelKey,
      label: resolved.model,
      providerId: resolved.groupKey === UNBOUND_PROVIDER_KEY ? null : resolved.groupKey,
      providerName: resolved.providerName,
      model: resolved.model,
      conversationCount: 0,
      ...emptyTokenBucket(),
      estimatedCostUsd: 0,
      hasPricing: false,
    };
    modelRow.conversationCount += 1;
    Object.assign(modelRow, {
      ...modelRow,
      ...addTokenBuckets(modelRow, usage),
    });
    // 展示名：若后续会话解析到更友好的 label，覆盖回落值。
    if (resolved.model && resolved.model !== modelKey && resolved.model !== resolved.modelId) {
      modelRow.label = resolved.model;
      modelRow.model = resolved.model;
    }
    if (cost.hasPricing) {
      modelRow.hasPricing = true;
      modelRow.estimatedCostUsd += cost.estimatedCostUsd || 0;
    }
    byModel.set(modelKey, modelRow);
  }

  const finalizeRow = (row) => ({
    ...row,
    estimatedCostUsd: row.hasPricing ? row.estimatedCostUsd : null,
  });

  return {
    generatedAt,
    totals: {
      ...totals,
      conversationCount,
      pricedConversationCount,
      estimatedCostUsd: hasAnyPricing ? estimatedCostUsd : null,
    },
    byProvider: sortGroupRows([...byProvider.values()].map(finalizeRow)),
    byModel: sortGroupRows([...byModel.values()].map(finalizeRow)),
    notes: {
      unpricedConversationCount,
      missingProviderCount,
      pricingUnit: 'USD_per_1M_tokens',
      scope: 'conversation_lifetime_usage',
    },
  };
}

/**
 * 从 store 读取并汇总。conversationStore.listConversations / llmConfigStore.listProviders
 * 都是同步接口。请求级快照（usage/requests.jsonl）存在时作为主数据源，成本按当次
 * 请求实际模型归因；无快照时回退到「会话 lifetimeUsage × 当前单价」估算。
 */
export function collectUsageStats({ conversationStore, llmConfigStore, usageRequestLog = null } = {}) {
  const conversations = conversationStore?.listConversations
    ? conversationStore.listConversations({ includeMessageCount: false })
    : [];
  const providers = llmConfigStore?.listProviders
    ? llmConfigStore.listProviders()
    : [];
  let requests = null;
  try {
    const log = usageRequestLog || createUsageRequestLog();
    requests = log.readAll({ limit: 200_000 });
  } catch (error) {
    console.warn('[usage-stats] failed to read request log, falling back to lifetime estimate:', error?.message || error);
    requests = null;
  }
  return buildUsageStatsSnapshot({ conversations, providers, requests });
}
