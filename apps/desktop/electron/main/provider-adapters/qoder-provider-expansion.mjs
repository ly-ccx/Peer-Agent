// Qoder「单凭证多模型」目录展开。
//
// 背景：Qoder 走本机 CLI 登录（qoder_local_auth），一条 provider 记录只带一个 model，
// 但本机 catalog 里其实有一整排可用模型（Auto / Ultimate / Performance / …）。聊天底部
// 的模型菜单完全由 provider 数组按 groupId 分组驱动，因此只要把「一条 Qoder 记录」展开成
// 「同一 groupId 下的多条虚拟记录」（各带不同 model 名、复合 id、共享同一凭证），菜单就会
// 自动列出全部模型，且选中后路由拿到的就是带正确 model 的完整记录。
//
// 关键约束（见 llm-config-store / provider-credential-resolver / provider-recovery-broker）：
//   1. Qoder 凭证解析只读本机 token，与 provider.id 无关 —— 虚拟复合 id 对鉴权零风险。
//   2. providerCanRun = enabled !== false && apiKeyConfigured —— 虚拟记录沿用原记录这两个字段即可。
//   3. 复合 id 约定为 `${groupId}::${modelId}`，与渲染端「打平后 provider×model」的 id 口径一致。
//   4. 本模块是纯函数：catalog 由外部注入，不碰文件系统，便于单测。

/** 复合 id 分隔符：`${groupId}::${modelId}`。 */
export const QODER_MODEL_ID_SEPARATOR = '::';

/** 判定一条 provider 记录是否为 Qoder 本机 CLI 记录（含历史 local_cli 值）。 */
export function isQoderLocalProvider(provider) {
  const method = provider?.authMethod;
  return method === 'qoder_local_auth' || method === 'local_cli';
}

/** 用 groupId + modelId 组出虚拟记录的复合 id。 */
export function makeQoderModelProviderId(groupId, modelId) {
  return `${groupId}${QODER_MODEL_ID_SEPARATOR}${modelId}`;
}

/**
 * 从复合 id 解析出 { groupId, modelId }。
 * 非复合 id（不含分隔符，或分隔符在首位）返回 null。
 * 用第一个分隔符切分：groupId 不含 `::`，modelId 允许包含（保守起见）。
 */
export function parseQoderModelProviderId(id) {
  const text = String(id ?? '');
  const idx = text.indexOf(QODER_MODEL_ID_SEPARATOR);
  if (idx <= 0) return null;
  const modelId = text.slice(idx + QODER_MODEL_ID_SEPARATOR.length);
  if (!modelId) return null;
  return { groupId: text.slice(0, idx), modelId };
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
 * 把一条 Qoder 记录 + 其本机模型目录，展开成多条虚拟 provider 记录。
 * 返回的每条记录 = 原记录浅拷贝后仅替换 id / groupId / model / modelLabel 与若干能力字段，
 * 其余（authMethod / channelId / baseUrl / enabled / apiKeyConfigured …）原样保留，故凭证与路由可直接复用。
 */
export function expandOneQoderProvider(provider, catalog) {
  const models = (Array.isArray(catalog) ? catalog : []).filter((m) => m && m.id);
  if (!models.length) return [provider];
  const groupId = provider.groupId || provider.id;
  const primaryModelId = pickPrimaryModelId(provider, models);
  // 代表模型排首位，其余按 catalog 顺序，便于菜单里默认项靠前、也让 orderProviderCandidates 的
  // runnable[0] 兜底命中代表模型。
  const ordered = [
    ...models.filter((m) => m.id === primaryModelId),
    ...models.filter((m) => m.id !== primaryModelId),
  ];
  return ordered.map((model) => ({
    ...provider,
    id: makeQoderModelProviderId(groupId, model.id),
    groupId,
    model: model.id,
    modelLabel: model.label || model.id,
    contextWindow: model.contextWindow ?? provider.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    supportsVision: model.supportsVision ?? provider.supportsVision ?? false,
    supportsReasoning: model.supportsReasoning ?? provider.supportsReasoning ?? false,
    // isDefault 只由「原记录本就是默认」AND「本条是代表模型」共同决定，避免凭空制造全局默认。
    isDefault: Boolean(provider.isDefault) && model.id === primaryModelId,
  }));
}

/**
 * 对 provider 列表做 Qoder 展开：非 Qoder 记录原样透传；每条 Qoder 记录用 resolveCatalog(provider)
 * 取回本机目录后展开成多条。resolveCatalog 抛错或返回空目录时，保留原单条记录（优雅降级）。
 *
 * @param {readonly any[]} providers 原始 provider 视图列表（listProviders() 的输出）。
 * @param {(provider:any)=>(readonly any[]|null|undefined)} resolveCatalog 按 provider 取本机模型目录。
 */
export function expandQoderProviders(providers, resolveCatalog) {
  const out = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!isQoderLocalProvider(provider)) {
      out.push(provider);
      continue;
    }
    let catalog = null;
    try {
      catalog = typeof resolveCatalog === 'function' ? resolveCatalog(provider) : null;
    } catch {
      catalog = null;
    }
    for (const expanded of expandOneQoderProvider(provider, catalog)) out.push(expanded);
  }
  return out;
}
