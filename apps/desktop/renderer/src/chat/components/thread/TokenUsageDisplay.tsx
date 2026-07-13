import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { DropdownOption } from '../../../app/components/Dropdown';
import { CascadingMenu, type CascadingMenuGroup } from '../../../app/components/CascadingMenu';
import { isEffortLevel, type EffortLevel } from '../../state/preferences';
import { formatTokenCount } from '../../state/format';
import { getProviderDisplayName } from '../../state/providerDisplay';
import { effortIndexForLevel, effortIndexFromValue, effortLevelForDisplay, snapEffortValue } from './effortSlider';
import type { TokenUsageState } from '../../state/types';

function effortLabel(level: EffortLevel, isZh: boolean): string {
  if (level === 'off') return isZh ? '关闭思考' : 'Reasoning off';
  if (level === 'low') return isZh ? '简洁思考' : 'Low reasoning';
  if (level === 'high') return isZh ? '深度思考' : 'High reasoning';
  if (level === 'xhigh') return isZh ? '超深度思考' : 'Extra-high reasoning';
  if (level === 'max') return isZh ? '最大思考' : 'Max reasoning';
  return isZh ? '标准思考' : 'Default reasoning';
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
      setCoords({ left: rect.left, top: rect.top - panel.offsetHeight - 6 });
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
  contextTokens,
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
}: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage?: TokenUsageState | null;
  readonly contextTokens?: number;
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
  /** onModelChange 回传选中项的 provider 复合 id（groupId::modelId），会话据此绑定模型。 */
  readonly onModelChange?: (providerId: string) => void;
  /** 会话级绑定的 provider 复合 id；决定下拉选中项与展示的模型/价格/上下文窗口。null=用全局默认。 */
  readonly selectedModelProviderId?: string | null;
}) {
  // 当前展示的 provider：优先会话绑定的 modelProviderId（随会话切换模型），其次全局默认，
  // 最后取首个已配置 Key 的 provider。这样价格/上下文窗口/模型名都跟随会话选中的模型走。
  const selectedProvider = selectedModelProviderId
    ? providers.find((p) => p.id === selectedModelProviderId && p.apiKeyConfigured)
    : null;
  const defaultProvider = selectedProvider
    || providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured);
  const hasInfo = tokenUsage || activeUsage || contextTokens || defaultProvider?.contextWindow || defaultProvider?.inputPrice != null;
  if (!hasInfo) return null;

  const input = (tokenUsage?.input ?? 0) + (activeUsage?.input ?? 0);
  const output = (tokenUsage?.output ?? 0) + (activeUsage?.output ?? 0);
  const cacheWrite = (tokenUsage?.cacheWrite ?? 0) + (activeUsage?.cacheWrite ?? 0);
  const cacheRead = (tokenUsage?.cacheRead ?? 0) + (activeUsage?.cacheRead ?? 0);
  const billedTokens = input + output;
  const currentContextTokens = contextTokens ?? billedTokens;
  const cacheDenominator = input + cacheRead;
  const cacheHitPercent = cacheDenominator > 0 ? Math.round((cacheRead / cacheDenominator) * 100) : null;
  // 仅当前选中模型支持 Prompt 缓存时才展示缓存命中率，避免切到无缓存模型后仍显示旧模型遗留的累计缓存数据。
  const showCacheHit = defaultProvider?.supportsPromptCaching === true && cacheRead > 0;

  const isSubscriptionProvider = defaultProvider?.authMethod === 'oauth_chatgpt';
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
  const ctxWindow = (typeof contextWindow === 'number' && contextWindow > 0) ? contextWindow : defaultProvider?.contextWindow;
  const ctxPercent = ctxWindow ? Math.min((currentContextTokens / ctxWindow) * 100, 100) : null;
  const shouldShowModelDropdown = Boolean(defaultProvider?.model && canSwitchModel && onModelChange && modelOptions.length > 0);
  // 级联菜单分组：一级 provider（按 groupId 折叠同一凭证下的多模型），二级为该 provider 下的模型。
  // 每个 provider 恒有二级子菜单（哪怕只有一个模型），一级只负责展开、不直接选中。
  // 未配置 API Key 的模型也一并列出，但置灰（disabled）不可选；整组模型都未配置时整组置灰。
  const modelGroups: readonly CascadingMenuGroup[] = (() => {
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
  })();

  const modelDisplayName = defaultProvider?.modelLabel || defaultProvider?.model;
  const modelTitle = defaultProvider?.modelLabel && defaultProvider.modelLabel !== defaultProvider.model
    ? `${isZh ? '当前会话使用的模型' : 'Model used for this conversation'}: ${defaultProvider.model}`
    : (isZh ? '当前会话使用的模型' : 'Model used for this conversation');

  return (
    <div className="token-usage-wrap">
      <span className="token-usage">
        {defaultProvider?.model ? (
          shouldShowModelDropdown ? (
            <CascadingMenu
              className="composer-cascading-menu composer-model-dropdown"
              value={defaultProvider.id}
              groups={modelGroups}
              onChange={(next) => onModelChange?.(next)}
              ariaLabel={isZh ? '切换模型' : 'Switch model'}
              title={modelLoading ? (isZh ? '正在加载模型列表' : 'Loading models') : modelTitle}
              menuPlacement="up"
              disabled={isStreaming || modelLoading}
            />
          ) : (
            <span className="token-usage-model" title={modelTitle}>{modelDisplayName}</span>
          )
        ) : null}
        {effortLevels.length > 0 ? (
          <ReasoningEffortSlider
            effort={effort}
            effortLevels={effortLevels}
            isZh={isZh}
            disabled={Boolean(isStreaming)}
            onChange={onEffortChange}
          />
        ) : null}
        {ctxWindow ? (
          <>{isZh ? '上下文' : 'Ctx'} {formatTokenCount(currentContextTokens)}<span className="token-usage-detail"> / {formatTokenCount(ctxWindow)}</span></>
        ) : currentContextTokens > 0 ? (
          <>{formatTokenCount(currentContextTokens)} tokens</>
        ) : null}
        {showCacheHit ? (
          <span
            className="token-usage-detail"
            title={
              isZh
                ? `缓存读取 ${formatTokenCount(cacheRead)} tokens${cacheWrite > 0 ? `，缓存写入 ${formatTokenCount(cacheWrite)} tokens` : ''}`
                : `Cache read ${formatTokenCount(cacheRead)} tokens${cacheWrite > 0 ? `, cache write ${formatTokenCount(cacheWrite)} tokens` : ''}`
            }
          >
            {isZh ? '缓存命中' : 'cache hit'} {cacheHitPercent}%
          </span>
        ) : null}
        {costStr ? (
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
        {isStreaming && !activeUsage ? <span className="token-usage-detail">{isZh ? '计费待返回' : 'usage pending'}</span> : null}
      </span>
      {ctxPercent != null ? (
        <div className="ctx-bar">
          <div className="ctx-bar-fill" style={{ width: `${ctxPercent}%` }} />
        </div>
      ) : null}
    </div>
  );
}
