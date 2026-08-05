import {
  resolveLlmModelOptionValues,
  type ContextAccountingSnapshot,
  type LlmProviderConfigView,
  type LlmSubscriptionQuota,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown, type DropdownOption } from '../../../app/components/Dropdown';
import { CascadingMenu, type CascadingMenuGroup } from '../../../app/components/CascadingMenu';
import {
  formatQuotaTooltipLine,
  isOAuthMethod,
  supportsSubscriptionQuotaMethod,
} from '../../../app/components/llmSubscriptionQuota';
import {
  contextWindowDefinition,
  selectedModelContextWindow,
} from '../../../app/components/llmModelConfiguration';
import { Tooltip } from '../../../app/components/Tooltip';
import { clientApi } from '../../../clientApi';
import { effortLabel, isEffortLevel, type EffortLevel } from '../../state/preferences';
import { formatTokenCount } from '../../state/format';
import { getProviderDisplayName } from '../../state/providerDisplay';
import { effortIndexForLevel, effortIndexFromValue, effortLevelForDisplay, snapEffortValue } from './effortSlider';
import type { TokenUsageState } from '../../state/types';
import { resolveStickyContextDisplay } from './stickyContextDisplay';

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

function ReasoningEffortSlider({
  effort,
  effortLevels,
  isZh,
  disabled,
  onChange,
}: {
  readonly effort: EffortLevel;
  readonly effortLevels: readonly EffortLevel[];
  readonly isZh: boolean;
  readonly disabled: boolean;
  readonly onChange: (level: EffortLevel) => void;
}) {
  const selectedIndex = effortIndexForLevel(effort, effortLevels);
  const selectedValue = effortLevels.length > 1 ? (selectedIndex / (effortLevels.length - 1)) * 100 : 0;
  const [open, setOpen] = useState(false);
  const [dragValue, setDragValue] = useState(selectedValue);
  const [dirty, setDirty] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    setDragValue(selectedValue);
    setDirty(false);
  }, [selectedValue]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const gap = 6;
      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Prefer above the trigger; flip below when there is not enough room.
      let top = rect.top - panelHeight - gap;
      if (top < margin) {
        const below = rect.bottom + gap;
        if (below + panelHeight <= viewportHeight - margin) {
          top = below;
        } else {
          top = Math.max(margin, Math.min(top, viewportHeight - panelHeight - margin));
        }
      }

      // Prefer left-aligned with the trigger; clamp horizontally to the viewport.
      const left = Math.max(
        margin,
        Math.min(rect.left, viewportWidth - panelWidth - margin),
      );

      setCoords({ left, top });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const commit = (value: number) => {
    if (!dirty) return;
    const snapped = snapEffortValue(value, effortLevels.length);
    const next = effortLevels[effortIndexFromValue(snapped, effortLevels.length)];
    setDragValue(snapped);
    setDirty(false);
    if (next && isEffortLevel(next)) onChange(next);
  };

  const effectiveValue = dirty ? dragValue : selectedValue;
  const displayedLevel = effortLevelForDisplay(effort, effortLevels, effectiveValue, dirty);
  const label = effortLabel(effort, isZh);
  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="reasoning-effort-panel"
          style={coords ? { left: coords.left, top: coords.top, visibility: 'visible' } : undefined}
        >
          <div className="reasoning-effort-panel-heading">
            <span>{isZh ? '思考强度' : 'Reasoning effort'}</span>
            <strong>{effortLabel(displayedLevel, isZh)}</strong>
          </div>
          <input
            className="reasoning-effort-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value={effectiveValue}
            aria-label={isZh ? '思考强度' : 'Reasoning effort'}
            aria-valuetext={effortLabel(displayedLevel, isZh)}
            style={{ '--effort-progress': `${effectiveValue}%` } as CSSProperties}
            onInput={(event) => {
              setDirty(true);
              setDragValue(Number(event.currentTarget.value));
            }}
            onChange={(event) => {
              setDirty(true);
              setDragValue(Number(event.currentTarget.value));
            }}
            onPointerUp={(event) => commit(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                commit(Number(event.currentTarget.value));
              }
            }}
            onBlur={(event) => commit(Number(event.currentTarget.value))}
          />
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className="reasoning-effort-control">
      <button
        ref={triggerRef}
        type="button"
        className={`reasoning-effort-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        title={isZh ? '思考强度' : 'Reasoning effort'}
        aria-label={`${isZh ? '思考强度' : 'Reasoning effort'}：${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {panel}
    </div>
  );
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

  // 订阅额度：与设置页一致，按 group head 拉取。
  // 支持 OAuth 订阅（ChatGPT/Gemini/Grok）与 Qoder CLI 本机登录。
  // 每 5 分钟自动刷新剩余额度（force=true），模型切换时立即重拉。
  const [subscriptionQuota, setSubscriptionQuota] = useState<LlmSubscriptionQuota | null>(null);
  const quotaProviderId = (() => {
    if (!defaultProvider || !supportsSubscriptionQuotaMethod(defaultProvider.authMethod)) return null;
    const groupId = defaultProvider.groupId || defaultProvider.id;
    const head = providers.find((p) => p.id === groupId) ?? defaultProvider;
    if (!supportsSubscriptionQuotaMethod(head.authMethod)) return null;
    // OAuth 需要已连接；Qoder 本地登录不依赖 oauthStatus。
    if (isOAuthMethod(head.authMethod) && head.oauthStatus?.status !== 'connected') return null;
    return head.id;
  })();

  useEffect(() => {
    if (!quotaProviderId) {
      setSubscriptionQuota(null);
      return;
    }
    let cancelled = false;
    const load = async (force: boolean) => {
      try {
        const result = await clientApi.llmGetSubscriptionQuota({ id: quotaProviderId, force });
        if (!cancelled) setSubscriptionQuota(result);
      } catch {
        if (!cancelled) setSubscriptionQuota(null);
      }
    };
    void load(false);
    // 每 5 分钟自动刷新剩余额度（与 llmSubscriptionQuota.SUBSCRIPTION_QUOTA_REFRESH_MS 一致）
    const timer = window.setInterval(() => {
      void load(true);
    }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [quotaProviderId]);

  // Live occupancy still comes only from shared contextAccounting.
  // When a turn temporarily drops it to unknown, stick to lastKnown for display.
  // Scope by conversation + model so sticky values never leak across sessions.
  const stickyScopeKey = [
    contextAccounting?.conversationId ?? (emptyContext ? 'empty' : 'unknown'),
    contextAccounting?.modelKey ?? selectedModelProviderId ?? defaultProvider?.id ?? 'default',
  ].join('|');
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
  const [lastKnownContext, setLastKnownContext] = useState<{
    scopeKey: string;
    percent: number | null;
    tokens: number | null;
  }>({ scopeKey: stickyScopeKey, percent: null, tokens: null });
  useEffect(() => {
    setLastKnownContext((prev) => {
      if (prev.scopeKey !== stickyScopeKey) {
        return {
          scopeKey: stickyScopeKey,
          percent: liveCtxPercent,
          tokens: liveContextTokens,
        };
      }
      if (liveCtxPercent == null && liveContextTokens == null) {
        return prev;
      }
      return {
        scopeKey: stickyScopeKey,
        percent: liveCtxPercent ?? prev.percent,
        tokens: liveContextTokens ?? prev.tokens,
      };
    });
  }, [stickyScopeKey, liveCtxPercent, liveContextTokens]);

  // 级联菜单分组：一级 provider（按 groupId 折叠同一凭证下的多模型），二级为该 provider 下的模型。
  // 每个 provider 恒有二级子菜单（哪怕只有一个模型），一级只负责展开、不直接选中。
  // 未配置 API Key 的模型也一并列出，但置灰（disabled）不可选；整组模型都未配置时整组置灰。
  // 注意：必须在 hasInfo early return 之前调用 hooks，否则 hasInfo 从 false→true 会触发 React #310。
  const modelGroups: readonly CascadingMenuGroup[] = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, { label: string; items: { id: string; label: string; disabled: boolean }[] }>();
    for (const prov of providers) {
      const key = prov.groupId || prov.id;
      let bucket = byGroup.get(key);
      if (!bucket) {
        bucket = { label: getProviderDisplayName(prov, isZh), items: [] };
        byGroup.set(key, bucket);
        order.push(key);
      }
      bucket.items.push({ id: prov.id, label: prov.modelLabel || prov.model, disabled: !prov.apiKeyConfigured });
    }
    return order.map((key) => {
      const bucket = byGroup.get(key)!;
      return { id: key, label: bucket.label, items: bucket.items, disabled: bucket.items.every((it) => it.disabled) };
    });
  }, [providers, isZh]);
  const handleModelMenuChange = useCallback((next: string) => {
    onModelChange?.(next);
  }, [onModelChange]);

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
      : { percent: null as number | null, tokens: null as number | null };
  const stickyDisplay = resolveStickyContextDisplay({
    livePercent: liveCtxPercent,
    liveTokens: liveContextTokens,
    lastKnownPercent: stickyLastKnown.percent,
    lastKnownTokens: stickyLastKnown.tokens,
  });
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
  const contextCounterDegraded = contextAccounting?.counterStatus === 'degraded';
  // 圆环 hover：展示用户可理解的上下文计量、漂移告警与附加诊断。
  // pendingUncountedChanges 是 Runtime 内部状态，不向用户暴露实现细节。
  const quotaTooltipLine = formatQuotaTooltipLine(subscriptionQuota ?? undefined, isZh);
  const ctxTooltipLines: readonly string[] = hasCtxRing
    ? [
        currentContextTokens != null && ctxPercent != null
          ? `${isZh ? '上下文' : 'Context'} ${formatTokenCount(currentContextTokens)} / ${formatTokenCount(ctxWindow)} (${Math.round(ctxPercent)}%)`
          : `${isZh ? '上下文待计量' : 'Context pending measurement'} / ${formatTokenCount(ctxWindow)}`,
        ...(contextCounterDegraded
          ? [
              isZh
                ? '精确计数与 provider usage 漂移，已降级采用 provider usage'
                : 'Exact count drifted from provider usage; using provider usage',
            ]
          : []),
        ...(showCacheHit
          ? [
              isZh
                ? `缓存命中 ${cacheHitPercent}%（读取 ${formatTokenCount(cacheRead)}${cacheWrite > 0 ? ` / 写入 ${formatTokenCount(cacheWrite)}` : ''}）`
                : `Cache hit ${cacheHitPercent}% (read ${formatTokenCount(cacheRead)}${cacheWrite > 0 ? ` / write ${formatTokenCount(cacheWrite)}` : ''})`,
            ]
          : []),
        ...(quotaTooltipLine ? [quotaTooltipLine] : []),
      ]
    : [];
  const ctxTooltip = ctxTooltipLines.join('\n');
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
            isZh={isZh}
            disabled={Boolean(isStreaming)}
            onChange={onEffortChange}
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
          <Tooltip lines={ctxTooltipLines} placement="top">
            <span className="ctx-usage" aria-label={ctxTooltip} tabIndex={0}>
              <span
                className="ctx-ring"
                style={{ '--ctx-pct': ctxPercent ?? 0 } as CSSProperties}
                aria-hidden
              />
              <span className="ctx-pct">
                {ctxPercent == null ? '?' : `${Math.round(ctxPercent)}%`}
                {contextCounterDegraded ? '!' : ''}
              </span>
            </span>
          </Tooltip>
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
