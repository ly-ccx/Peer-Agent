import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { Dropdown, type DropdownOption } from '../../../app/components/Dropdown';
import { isEffortLevel, type EffortLevel } from '../../state/preferences';
import { formatTokenCount } from '../../state/format';
import type { TokenUsageState } from '../../state/types';

function effortLabel(level: EffortLevel, isZh: boolean): string {
  if (level === 'off') return isZh ? '关闭思考' : 'Reasoning off';
  if (level === 'low') return isZh ? '简洁思考' : 'Low reasoning';
  if (level === 'high') return isZh ? '深度思考' : 'High reasoning';
  if (level === 'xhigh') return isZh ? '超深度思考' : 'Extra-high reasoning';
  return isZh ? '标准思考' : 'Default reasoning';
}

export function TokenUsageDisplay({ providers, tokenUsage, activeUsage, contextTokens, isStreaming, isZh, effort, effortLevels, onEffortChange }: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage?: TokenUsageState | null;
  readonly contextTokens?: number;
  readonly isStreaming?: boolean;
  readonly isZh: boolean;
  readonly effort: EffortLevel;
  readonly effortLevels: readonly EffortLevel[];
  readonly onEffortChange: (level: EffortLevel) => void;
}) {
  const defaultProvider = providers.find((p) => p.isDefault && p.apiKeyConfigured) || providers.find((p) => p.apiKeyConfigured);
  const hasInfo = tokenUsage || activeUsage || contextTokens || defaultProvider?.contextWindow || defaultProvider?.inputPrice != null;
  if (!hasInfo) return null;

  const input = (tokenUsage?.input ?? 0) + (activeUsage?.input ?? 0);
  const output = (tokenUsage?.output ?? 0) + (activeUsage?.output ?? 0);
  const cacheWrite = (tokenUsage?.cacheWrite ?? 0) + (activeUsage?.cacheWrite ?? 0);
  const cacheRead = (tokenUsage?.cacheRead ?? 0) + (activeUsage?.cacheRead ?? 0);
  const billedTokens = input + output;
  const currentContextTokens = contextTokens ?? billedTokens;

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

  const ctxWindow = defaultProvider?.contextWindow;
  const ctxPercent = ctxWindow ? Math.min((currentContextTokens / ctxWindow) * 100, 100) : null;
  const effortOptions: readonly DropdownOption[] = effortLevels.map((level) => ({ value: level, label: effortLabel(level, isZh) }));

  return (
    <div className="token-usage-wrap">
      <span className="token-usage">
        {defaultProvider?.model ? (
          <span className="token-usage-model" title={isZh ? '当前会话使用的模型' : 'Model used for this conversation'}>{defaultProvider.model}</span>
        ) : null}
        {effortOptions.length > 0 ? (
          <Dropdown
            className="composer-dropdown composer-effort-dropdown"
            value={effort}
            options={effortOptions}
            onChange={(next) => {
              if (isEffortLevel(next)) onEffortChange(next);
            }}
            ariaLabel={isZh ? '思考深度' : 'Reasoning effort'}
            title={isZh ? '思考深度' : 'Reasoning effort'}
            menuPlacement="up"
          />
        ) : null}
        {ctxWindow ? (
          <>{isZh ? '上下文' : 'Ctx'} {formatTokenCount(currentContextTokens)}<span className="token-usage-detail"> / {formatTokenCount(ctxWindow)}</span></>
        ) : currentContextTokens > 0 ? (
          <>{formatTokenCount(currentContextTokens)} tokens</>
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
