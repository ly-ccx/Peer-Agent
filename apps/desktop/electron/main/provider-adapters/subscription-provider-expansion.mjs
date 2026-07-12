// 订阅（ChatGPT OAuth）「单凭证多模型」目录展开。
//
// 背景：ChatGPT 订阅走 OAuth（oauth_chatgpt），一条 provider 记录只带一个当前 model，
// 但订阅平面（codex）可用的是固定的 gpt-5.x 家族（见 openai-model-catalog 的 SUBSCRIPTION_CATALOG）。
// 聊天底部的模型菜单完全由 provider 数组按 groupId 分组驱动，因此把「一条订阅记录」展开成
// 「同一 groupId 下的多条虚拟记录」（各带不同 model、复合 id、共享同一订阅凭证），菜单就会
// 自动列出全部订阅模型，且选中后路由拿到的就是带正确 model 的完整记录，会话据虚拟 id 各记各的。
//
// 关键约束（与 Qoder 展开的最大差异）：
//   订阅凭证解析走 getCredential(provider.id) —— 按真实记录 id 精确查 OAuth token。虚拟记录的
//   复合 id 在存储里不存在，故每条虚拟记录额外带 credentialId=原始记录 id；
//   provider-credential-resolver / setOAuthTokens 对带 credentialId 的记录用它回退取/写 token。
//
// 复合 id 沿用 Qoder 的 `${groupId}::${modelId}` 口径（QODER_MODEL_ID_SEPARATOR），
// 与渲染端「打平后 provider×model」的 id 口径一致，凭证回退键则由 credentialId 单独承载。
//
// 本模块是纯函数：catalog 由外部注入，不碰文件系统，便于单测。

import { QODER_MODEL_ID_SEPARATOR, makeQoderModelProviderId } from './qoder-provider-expansion.mjs';

/** 判定一条 provider 记录是否为 ChatGPT 订阅记录（oauth_chatgpt）。 */
export function isSubscriptionProvider(provider) {
  return provider?.authMethod === 'oauth_chatgpt';
}

/**
 * 选出「组内代表模型」的 modelId，用于决定哪条虚拟记录承接原记录的 isDefault 与排序首位：
 *   1. 若原记录已配置的 model 在 catalog 里 → 用它（保持既有默认不跳变）；
 *   2. 否则用 catalog 里标了 isDefault 的；
 *   3. 再否则用第一条。
 */
function pickPrimaryModelId(provider, models) {
  const configured = String(provider?.model || '').trim();
  if (configured && models.some((m) => m.id === configured)) return configured;
  const flagged = models.find((m) => m?.isDefault);
  if (flagged) return flagged.id;
  return models[0].id;
}

/**
 * 把一条订阅记录 + 其订阅模型目录，展开成多条虚拟 provider 记录。
 * 返回的每条记录 = 原记录浅拷贝后替换 id / groupId / model / modelLabel / 定价与能力字段，
 * 并写入 credentialId=原记录 id（供凭证解析回退）。其余（authMethod / oauthStatus /
 * apiKeyConfigured / enabled / baseUrl …）原样保留，故凭证与路由可直接复用。
 */
export function expandOneSubscriptionProvider(provider, catalog) {
  const models = (Array.isArray(catalog) ? catalog : []).filter((m) => m && m.id);
  if (!models.length) return [provider];
  const groupId = provider.groupId || provider.id;
  const credentialId = provider.id;
  const primaryModelId = pickPrimaryModelId(provider, models);
  // 代表模型排首位，其余按 catalog 顺序，便于菜单默认项靠前、也让 orderProviderCandidates 的
  // runnable[0] 兜底命中代表模型。
  const ordered = [
    ...models.filter((m) => m.id === primaryModelId),
    ...models.filter((m) => m.id !== primaryModelId),
  ];
  return ordered.map((model) => ({
    ...provider,
    id: makeQoderModelProviderId(groupId, model.id),
    groupId,
    // 凭证回退键：虚拟复合 id 在存储里不存在，凭证解析/刷新需用它回到原始订阅记录取 OAuth token。
    credentialId,
    model: model.id,
    modelLabel: model.label || model.id,
    contextWindow: model.contextWindow ?? provider.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    inputPrice: model.inputPrice ?? provider.inputPrice,
    outputPrice: model.outputPrice ?? provider.outputPrice,
    cacheReadPrice: model.cacheReadPrice ?? provider.cacheReadPrice,
    cacheWritePrice: model.cacheWritePrice ?? provider.cacheWritePrice,
    supportsVision: model.supportsVision ?? provider.supportsVision ?? false,
    supportsReasoning: model.supportsReasoning ?? provider.supportsReasoning ?? false,
    reasoningEffortLevels: model.reasoningEffortLevels ?? provider.reasoningEffortLevels,
    supportsPromptCaching: model.supportsPromptCaching ?? provider.supportsPromptCaching ?? false,
    // isDefault 只由「原记录本就是默认」AND「本条是代表模型」共同决定，避免凭空制造全局默认。
    isDefault: Boolean(provider.isDefault) && model.id === primaryModelId,
  }));
}

/**
 * 对 provider 列表做订阅展开：非订阅记录原样透传；每条订阅记录用 resolveCatalog(provider)
 * 取回订阅目录后展开成多条。resolveCatalog 抛错或返回空目录时，保留原单条记录（优雅降级）。
 *
 * @param {readonly any[]} providers 原始 provider 视图列表。
 * @param {(provider:any)=>(readonly any[]|null|undefined)} resolveCatalog 按 provider 取订阅模型目录。
 */
export function expandSubscriptionProviders(providers, resolveCatalog) {
  const out = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!isSubscriptionProvider(provider)) {
      out.push(provider);
      continue;
    }
    let catalog = null;
    try {
      catalog = resolveCatalog(provider);
    } catch {
      catalog = null;
    }
    const expanded = expandOneSubscriptionProvider(provider, catalog);
    for (const record of expanded) out.push(record);
  }
  return out;
}

export { QODER_MODEL_ID_SEPARATOR };
