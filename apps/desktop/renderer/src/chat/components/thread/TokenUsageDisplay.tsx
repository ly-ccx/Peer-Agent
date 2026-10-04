import {
  buildModelMenuGroups,
  resolveLlmModelOptionValues,
  type ContextAccountingSnapshot,
  type ContextUsageBreakdown,
  type LlmProviderConfigView,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, type DropdownOption } from '../../../app/components/Dropdown';
import { CascadingMenu, type CascadingMenuGroup } from '../../../app/components/CascadingMenu';
import { accountUsageViewIdentity } from '../../../app/components/accountUsageIdentity';
import { ContextAccountUsage } from './ContextAccountUsage';
import { supportsSubscriptionQuotaMethod } from '../../../app/components/llmSubscriptionQuota';
import {
  contextWindowDefinition,
  selectedModelContextWindow,
} from '../../../app/components/llmModelConfiguration';
import { type EffortLevel } from '../../state/preferences';
import { formatTokenCount } from '../../state/format';
import { getProviderDisplayName } from '../../state/providerDisplay';
import { ReasoningEffortSlider } from './ReasoningEffortSlider';
import type { TokenUsageState } from '../../state/types';
import { ContextUsagePanel } from './ContextUsagePanel';
import { contextDisplayScopeKey, resolveStickyContextDisplay } from './stickyContextDisplay';

/** 上下文档位标签：极简，如 500k / 1M / 272k。 */
function formatContextWindowLabel(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return '—';
  }
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = Number.isInteger(millions) ? `${millions}` : millions.toFixed(1).replace(/\.0$/, '');
    return `${text}M`;
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    const text = Number.isInteger(thousands) ? `${thousands}` : thousands.toFixed(1).replace(/\.0$/, '');
    return `${text}k`;
  }
  return `${Math.round(tokens)}`;
}

export function TokenUsageDisplay({
  providers,
  tokenUsage,
  activeUsage,
  contextAccounting,
  emptyContext = false,
  contextWindow,
  isStreaming,
  isZh,
  effort,
  effortLevels,
  onEffortChange,
  fastMode = false,
  onFastModeChange,
  modelOptions = [],
  modelLoading = false,
  canSwitchModel = false,
  onModelChange,
  selectedModelProviderId = null,
  showContextUsage = true,
  showModelControls = true,
  onContextWindowChange,
}: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage?: TokenUsageState | null;
  /** ADR 56: the sole context-capacity state. */
  readonly contextAccounting?: ContextAccountingSnapshot | null;
  /** A brand-new draft has no conversation history and therefore starts at 0%. */
  readonly emptyContext?: boolean;
  /** 权威上下文窗口（与压缩触发同窗口）。传入时优先于 provider 配置窗口，消除百分比偏差。 */
  readonly contextWindow?: number;
  readonly isStreaming?: boolean;
  readonly isZh: boolean;
  readonly effort: EffortLevel;
  readonly effortLevels: readonly EffortLevel[];
  readonly onEffortChange: (level: EffortLevel) => void;
  readonly fastMode?: boolean;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly modelOptions?: readonly DropdownOption[];
  readonly modelLoading?: boolean;
  readonly canSwitchModel?: boolean;
  /** onModelChange 回传选中项的已配置模型记录 id，会话据此绑定模型。 */
  readonly onModelChange?: (providerId: string) => void;
  /** 会话级绑定的模型记录 id；决定下拉选中项与展示的模型/价格/上下文窗口。null=用全局默认。 */
  readonly selectedModelProviderId?: string | null;
  /** 首页框内只保留模型/思考；框下右侧单独放上下文统计。 */
  readonly showContextUsage?: boolean;
  readonly showModelControls?: boolean;
  /** 多档上下文切换：写入 modelOptionValues，并刷新 provider 列表。 */
  readonly onContextWindowChange?: (providerId: string, optionId: string, value: string) => void | Promise<void>;
}) {
  // 当前展示的 provider：优先会话绑定的 modelProviderId（随会话切换模型），其次全局默认，
  // 最后取首个已配置 Key 的 provider。这样价格/上下文窗口/模型名都跟随会话选中的模型走。
  const selectedProvider = selectedModelProviderId
    ? providers.find((p) => p.id === selectedModelProviderId && p.apiKeyConfigured)
    : null;
  const defaultProvider = selectedProvider
    || providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured);

  // All authentication types use the existing account service, only while the panel is open.
  const accountProvider = defaultProvider
    ? providers.find((p) => p.id === (defaultProvider.groupId || defaultProvider.id)) ?? defaultProvider
    : undefined;

  // Live occupancy still comes only from shared contextAccounting.
  // When a turn temporarily drops it to unknown, stick to lastKnown for display.
  // A new compaction epoch invalidates the old percent, tokens and breakdown.
  // The render-time scope guard below applies this before the cache effect runs.
  const stickyScopeKey = contextDisplayScopeKey(
    contextAccounting?.conversationId ?? (emptyContext ? 'empty' : 'unknown'),
    contextAccounting?.modelKey ?? selectedModelProviderId ?? defaultProvider?.id ?? 'default',
    contextAccounting?.compactionEpoch,
  );
  const liveContextTokens =
    typeof contextAccounting?.authoritativeInputTokens === 'number'
      && Number.isFinite(contextAccounting.authoritativeInputTokens)
      ? Math.max(0, contextAccounting.authoritativeInputTokens)
      : emptyContext && contextAccounting == null
        ? 0
        : null;
  const liveCtxPercent =
    typeof contextAccounting?.percent === 'number'
    && Number.isFinite(contextAccounting.percent)
      ? Math.min(Math.max(contextAccounting.percent, 0), 100)
      : emptyContext && contextAccounting == null
        ? 0
        : null;
  const liveBreakdown = contextAccounting?.usageBreakdown ?? null;
  const [lastKnownContext, setLastKnownContext] = useState<{
    scopeKey: string;
    percent: number | null;
    tokens: number | null;
    breakdown: ContextUsageBreakdown | null;
  }>({ scopeKey: stickyScopeKey, percent: null, tokens: null, breakdown: null });
  useEffect(() => {
    setLastKnownContext((prev) => {
      if (prev.scopeKey !== stickyScopeKey) {
        return {
          scopeKey: stickyScopeKey,
          percent: liveCtxPercent,
          tokens: liveContextTokens,
          breakdown: liveBreakdown,
        };
      }
      if (liveCtxPercent == null && liveContextTokens == null && liveBreakdown == null) {
        return prev;
      }
      return {
        scopeKey: stickyScopeKey,
        percent: liveCtxPercent ?? prev.percent,
        tokens: liveContextTokens ?? prev.tokens,
        breakdown: liveBreakdown ?? prev.breakdown,
      };
    });
  }, [stickyScopeKey, liveCtxPercent, liveContextTokens, liveBreakdown]);

  // 级联菜单分组：一级 provider（按 groupId 折叠同一凭证下的多模型），二级为该 provider 下的模型。
  // 每个 provider 恒有二级子菜单（哪怕只有一个模型），一级只负责展开、不直接选中。
  // 未配置 API Key 的模型也一并列出，但置灰（disabled）不可选；整组模型都未配置时整组置灰。
  // 注意：必须在 hasInfo early return 之前调用 hooks，否则 hasInfo 从 false→true 会触发 React #310。
  const modelGroups: readonly CascadingMenuGroup[] = useMemo(() => buildModelMenuGroups(
    providers.map((prov) => ({
      id: prov.id, groupId: prov.groupId, groupLabel: getProviderDisplayName(prov, isZh),
      model: prov.model, modelLabel: prov.modelLabel, available: Boolean(prov.apiKeyConfigured),
    })),
  ), [providers, isZh]);
  const handleModelMenuChange = useCallback((next: string) => {
    onModelChange?.(next);
  }, [onModelChange]);
  // 这三份 useMemo 必须留在 hasInfo early return 之前。草稿态（无 provider /
  // 无 usage）hasInfo=false；打开会话后 contextAccounting 一到 hasInfo=true，
  // 若此时才第一次调用 hook，会触发 React #310。
  const contextOptionDefinition = useMemo(
    () => (defaultProvider ? contextWindowDefinition(defaultProvider) : undefined),
    [defaultProvider],
  );
  const selectedContextWindow = useMemo(
    () => (defaultProvider ? selectedModelContextWindow(defaultProvider) : undefined),
    [defaultProvider],
  );
  const contextOptionValues = useMemo(
    () => (defaultProvider
      ? resolveLlmModelOptionValues(defaultProvider.modelOptions, defaultProvider.modelOptionValues)
      : {}),
    [defaultProvider],
  );

  const hasInfo = tokenUsage || activeUsage || contextAccounting || defaultProvider?.contextWindow || defaultProvider?.inputPrice != null;
  if (!hasInfo) return null;

  const input = (tokenUsage?.input ?? 0) + (activeUsage?.input ?? 0);
  const output = (tokenUsage?.output ?? 0) + (activeUsage?.output ?? 0);
  const cacheWrite = (tokenUsage?.cacheWrite ?? 0) + (activeUsage?.cacheWrite ?? 0);
  const cacheRead = (tokenUsage?.cacheRead ?? 0) + (activeUsage?.cacheRead ?? 0);
  // 累计 usage 仅用于费用估算；上下文圆环只接受共享计量快照。
  // 缺失时：若本会话从未有过计量结果则显示「?」；
  // 若仅是发送/流式过程中的短暂未知，则保留 lastKnown 百分比，避免闪成「?」。
  const stickyLastKnown =
    lastKnownContext.scopeKey === stickyScopeKey
      ? lastKnownContext
      : { percent: null as number | null, tokens: null as number | null, breakdown: null };
  const stickyDisplay = resolveStickyContextDisplay({
    livePercent: liveCtxPercent,
    liveTokens: liveContextTokens,
    lastKnownPercent: stickyLastKnown.percent,
    lastKnownTokens: stickyLastKnown.tokens,
  });
  const stickyBreakdown = liveBreakdown ?? stickyLastKnown.breakdown;
  const currentContextTokens = stickyDisplay.tokens;
  const cacheDenominator = input + cacheRead;
  const cacheHitPercent = cacheDenominator > 0 ? Math.round((cacheRead / cacheDenominator) * 100) : null;
  // 仅当前选中模型支持 Prompt 缓存时才展示缓存命中率，避免切到无缓存模型后仍显示旧模型遗留的累计缓存数据。
  const showCacheHit = defaultProvider?.supportsPromptCaching === true && cacheRead > 0;

  const isSubscriptionProvider = supportsSubscriptionQuotaMethod(defaultProvider?.authMethod);
  let costStr: string | null = null;
  if (!isSubscriptionProvider && defaultProvider?.inputPrice != null && defaultProvider?.outputPrice != null) {
    const p = defaultProvider;
    const inputCost = (input / 1_000_000) * (p.inputPrice ?? 0);
    const outputCost = (output / 1_000_000) * (p.outputPrice ?? 0);
    const cwCost = cacheWrite && p.cacheWritePrice != null ? (cacheWrite / 1_000_000) * p.cacheWritePrice : 0;
    const crCost = cacheRead && p.cacheReadPrice != null ? (cacheRead / 1_000_000) * p.cacheReadPrice : 0;
    const cost = inputCost + outputCost + cwCost + crCost;
    costStr = cost === 0 ? '$0.00' : cost < 0.001 ? '<$0.001' : cost < 0.01 ? '$' + cost.toFixed(4) : '$' + cost.toFixed(2);
  }

  // 口径统一：分母优先用调用方传入的权威上下文窗口（与压缩触发同窗口），
  // 仅在未提供（>0 校验）时回退到 provider 配置窗口，避免两套窗口导致百分比与触发线不符。
  const ctxWindow = contextAccounting?.contextWindow
    ?? ((typeof contextWindow === 'number' && contextWindow > 0)
      ? contextWindow
      : defaultProvider?.contextWindow);
  // 圆环百分比：优先 live contextAccounting.percent，暂缺时回退 lastKnown。
  // 从未有过计量结果时仍显示「?」；禁止用草稿字符或本地估算伪装成有效百分比。
  const ctxPercent = stickyDisplay.percent;
  const hasCtxRing = ctxWindow != null;
  // 圆环 hover：只展示用户可理解的上下文计量与附加诊断。
  // pendingUncountedChanges 与 counterStatus 都是 Runtime 内部计量状态，不向用户暴露；
  // 后者原先会在面板底部显示一句内部降级说明，已移除。
  // 数字与占用率不受影响：仍取自同一份共享快照。
  const ctxTooltipLines: readonly string[] = hasCtxRing
    ? [
        currentContextTokens != null && ctxPercent != null
          ? `${isZh ? '上下文' : 'Context'} ${formatTokenCount(currentContextTokens)} / ${formatTokenCount(ctxWindow)} (${Math.round(ctxPercent)}%)`
          : `${isZh ? '上下文待计量' : 'Context pending measurement'} / ${formatTokenCount(ctxWindow)}`,
        ...(showCacheHit
          ? [
              isZh
                ? `缓存命中 ${cacheHitPercent}%（读取 ${formatTokenCount(cacheRead)}${cacheWrite > 0 ? ` / 写入 ${formatTokenCount(cacheWrite)}` : ''}）`
                : `Cache hit ${cacheHitPercent}% (read ${formatTokenCount(cacheRead)}${cacheWrite > 0 ? ` / write ${formatTokenCount(cacheWrite)}` : ''})`,
            ]
          : []),
      ]
    : [];
  const ctxTooltip = ctxTooltipLines.join('\n');
  const selectedContextOptionValue = contextOptionDefinition
    ? String(contextOptionValues[contextOptionDefinition.id] ?? contextOptionDefinition.defaultValue)
    : '';
  const contextWindowChoices = contextOptionDefinition?.choices.filter((choice) => (
    typeof choice.contextWindow === 'number' && choice.contextWindow > 0
  )) ?? [];
  const canSwitchContextWindow = Boolean(
    showModelControls
    && defaultProvider
    && onContextWindowChange
    && contextOptionDefinition
    && contextWindowChoices.length > 1,
  );
  const contextWindowOptions: DropdownOption[] = contextWindowChoices.map((choice) => ({
    value: String(choice.value),
    // 始终用极简档位文案（500k / 1M），不用 definition 里可能偏长的 label。
    label: formatContextWindowLabel(choice.contextWindow),
  }));
  const fixedContextWindowLabel = formatContextWindowLabel(
    selectedContextWindow ?? contextWindow ?? defaultProvider?.contextWindow,
  );

  const shouldShowModelDropdown = Boolean(defaultProvider?.model && canSwitchModel && onModelChange && modelOptions.length > 0);
  const modelDisplayName = defaultProvider?.modelLabel || defaultProvider?.model;
  const modelTitle = defaultProvider?.modelLabel && defaultProvider.modelLabel !== defaultProvider.model
    ? `${isZh ? '当前会话使用的模型' : 'Model used for this conversation'}: ${defaultProvider.model}`
    : (isZh ? '当前会话使用的模型' : 'Model used for this conversation');

  return (
    <div className="token-usage-wrap">
      <span className="token-usage">
        {showModelControls && defaultProvider?.model ? (
          shouldShowModelDropdown ? (
            <CascadingMenu
              className="composer-cascading-menu composer-model-dropdown"
              value={defaultProvider.id}
              groups={modelGroups}
              onChange={handleModelMenuChange}
              ariaLabel={isZh ? '切换模型' : 'Switch model'}
              title={modelLoading ? (isZh ? '正在加载模型列表' : 'Loading models') : modelTitle}
              menuPlacement="up"
              disabled={isStreaming || modelLoading}
            />
          ) : (
            <span className="token-usage-model" title={modelTitle}>{modelDisplayName}</span>
          )
        ) : null}
        {showModelControls && effortLevels.length > 0 ? (
          <ReasoningEffortSlider
            effort={effort}
            effortLevels={effortLevels}
            fastAvailable={(defaultProvider?.authMethod === 'oauth_chatgpt' || defaultProvider?.authMethod === 'oauth_grok') && Boolean(onFastModeChange)}
            fastMode={fastMode}
            isZh={isZh}
            disabled={Boolean(isStreaming)}
            onEffortChange={onEffortChange}
            onFastModeChange={onFastModeChange ?? (() => undefined)}
          />
        ) : null}
        {showModelControls && canSwitchContextWindow && contextOptionDefinition && defaultProvider ? (
          <Dropdown
            className="composer-dropdown composer-context-window-dropdown"
            value={selectedContextOptionValue}
            options={contextWindowOptions}
            onChange={(value) => {
              void onContextWindowChange?.(defaultProvider.id, contextOptionDefinition.id, value);
            }}
            ariaLabel={isZh ? '上下文窗口' : 'Context window'}
            title={isZh ? '切换上下文窗口' : 'Switch context window'}
            menuPlacement="up"
            disabled={Boolean(isStreaming)}
          />
        ) : showModelControls && (selectedContextWindow ?? contextWindow ?? defaultProvider?.contextWindow) ? (
          <span
            className="token-usage-context-window"
            title={isZh ? '当前上下文窗口' : 'Current context window'}
          >
            {fixedContextWindowLabel}
          </span>
        ) : null}
        {showContextUsage && hasCtxRing ? (
          <ContextUsagePanel
            percent={ctxPercent}
            usedTokens={currentContextTokens}
            contextWindow={ctxWindow}
            breakdown={stickyBreakdown}
            isZh={isZh}
            summaryLabel={ctxTooltip}
            footerLines={ctxTooltipLines.slice(1)}
            accountUsage={accountProvider ? <ContextAccountUsage key={accountUsageViewIdentity(accountProvider)} provider={accountProvider} isZh={isZh} /> : null}
          />
        ) : showContextUsage && currentContextTokens != null && currentContextTokens > 0 ? (
          <>{formatTokenCount(currentContextTokens)} tokens</>
        ) : null}
        {showContextUsage && costStr ? (
          <span
            className="token-usage-cost"
            title={
              isZh
                ? '按 API 单价估算的等价用量价值。'
                : 'Estimated equivalent API value.'
            }
          >
            {costStr}
          </span>
        ) : null}
      </span>
    </div>
  );
}
