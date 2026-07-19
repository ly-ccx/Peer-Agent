/**
 * 跨会话用量汇总（精简版使用统计）。
 *
 * 数据源：
 * - conversation index meta.lifetimeUsage（ADR 23）
 * - conversation meta.modelProviderId / model
 * - llm-config listProviders() 上的单价字段（USD / 1M tokens）
 *
 * 不包含：逐条请求日志、时间序列趋势。成本仅为按当前配置单价估算。
 */

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
function buildProviderIndex(providers = []) {
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

  // 会话 meta.model 优先；若 composite 指定了 model 且与命中记录不一致，用 composite.model。
  const providerModel = providerModelKey(provider);
  const model = (typeof meta?.model === 'string' && meta.model.trim())
    || (composite.model && providerModel && composite.model !== providerModel
      ? composite.model
      : '')
    || providerModelLabel(provider)
    || composite.model
    || modelProviderId;

  return {
    modelProviderId,
    provider,
    model,
    providerName: groupLabel,
    groupKey,
    groupLabel,
    pricing: {
      inputPrice: optionalPrice(provider?.inputPrice),
      outputPrice: optionalPrice(provider?.outputPrice),
      cacheReadPrice: optionalPrice(provider?.cacheReadPrice),
      cacheWritePrice: optionalPrice(provider?.cacheWritePrice),
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
 * @param {{ conversations?: readonly object[], providers?: readonly object[], generatedAt?: string }} input
 */
export function buildUsageStatsSnapshot({
  conversations = [],
  providers = [],
  generatedAt = new Date().toISOString(),
} = {}) {
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

    const modelKey = resolved.modelProviderId
      || `${resolved.groupKey}::${resolved.model}`;
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
 * 都是同步接口。
 */
export function collectUsageStats({ conversationStore, llmConfigStore } = {}) {
  const conversations = conversationStore?.listConversations
    ? conversationStore.listConversations({ includeMessageCount: false })
    : [];
  const providers = llmConfigStore?.listProviders
    ? llmConfigStore.listProviders()
    : [];
  return buildUsageStatsSnapshot({ conversations, providers });
}
