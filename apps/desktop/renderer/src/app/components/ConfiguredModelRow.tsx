import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView, LlmProviderTestResult } from '@peer-agent/protocol';
import { modelMetadataCompletion } from './llmModelConfiguration';

function compactTokens(value: number | undefined): string | null {
  if (!value) return null;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

export function ConfiguredModelRow({
  i18n,
  model,
  result,
  testing,
  onSetDefault,
  onTest,
  onEdit,
  onDelete,
}: {
  readonly i18n: I18nRuntime;
  readonly model: LlmProviderConfigView;
  readonly result?: LlmProviderTestResult;
  readonly testing: boolean;
  readonly onSetDefault: () => void;
  readonly onTest: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const zh = i18n.locale === 'zh-CN';
  const completion = modelMetadataCompletion(model);
  const context = compactTokens(model.contextWindow);
  const output = compactTokens(model.maxOutputTokens);
  const summary = [
    context ? `${context} ctx` : null,
    output ? `${output} out` : null,
    model.inputPrice != null && model.outputPrice != null ? `$${model.inputPrice}/${model.outputPrice}` : null,
  ].filter(Boolean).join(' · ');
  const oauthNotConnected = model.authMethod.startsWith('oauth_') && model.oauthStatus?.status !== 'connected';

  const metadataSource = (() => {
    switch (model.metadataSource) {
      case 'remote': return zh ? '远程目录' : 'Remote catalog';
      case 'models.dev': return 'models.dev';
      case 'builtin': return zh ? '内置目录' : 'Built-in catalog';
      case 'local': return zh ? '本地目录' : 'Local catalog';
      case 'manual': return zh ? '手动配置' : 'Manual';
      default: return zh ? '未知来源' : 'Unknown source';
    }
  })();
  const capabilities = [
    { key: 'vision', label: zh ? '视觉' : 'Vision', value: model.supportsVision },
    { key: 'reasoning', label: zh ? '推理' : 'Reasoning', value: model.supportsReasoning },
    { key: 'prompt-cache', label: zh ? '提示缓存' : 'Prompt cache', value: model.supportsPromptCaching },
  ];

  return (
    <details className={`llm-configured-model-row ${model.isDefault ? 'is-default' : ''}`}>
      <summary className="llm-configured-model-summary">
        <div className="llm-configured-model-main">
          <div className="llm-configured-model-title">
            <strong>{model.modelLabel || model.model}</strong>
            {model.isDefault ? <span className="llm-badge-default">{zh ? '默认' : 'Default'}</span> : null}
          </div>
          <code title={model.model}>{model.model}</code>
        </div>
        <div className="llm-configured-model-status">
          <span className={`llm-metadata-state is-${completion}`}>
            {completion === 'complete' ? (zh ? '已完善' : 'Complete') : completion === 'partial' ? (zh ? '部分待完善' : 'Partial') : (zh ? '元数据待完善' : 'Needs metadata')}
          </span>
          <svg className="llm-configured-model-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </div>
      </summary>
      <div className="llm-configured-model-details">
        <div className="llm-configured-model-metadata">
          <small>{summary || (zh ? '上下文、最大输出和价格尚未配置' : 'Context, output limit and pricing are not configured')}</small>
          <div className="llm-configured-model-capabilities">
            {capabilities.map((capability) => {
              const state = capability.value === true ? 'yes' : capability.value === false ? 'no' : 'unknown';
              const value = capability.value === true
                ? (zh ? '支持' : 'Supported')
                : capability.value === false
                  ? (zh ? '不支持' : 'Unsupported')
                  : (zh ? '未知' : 'Unknown');
              return <span key={capability.key} className={`llm-capability-state is-${state}`}>{capability.label}: {value}</span>;
            })}
          </div>
          <small>{zh ? '元数据来源' : 'Metadata source'}: {metadataSource}{model.metadataSyncedAt ? ` · ${model.metadataSyncedAt}` : ''}</small>
          {result ? <small className={`llm-test-result ${result.success ? 'success' : 'fail'}`}>{result.success ? `✓ ${result.model} (${result.latencyMs}ms)` : `✗ ${result.error || 'connection_failed'}`}</small> : null}
        </div>
        <div className="llm-configured-model-actions">
          {!model.isDefault ? <button type="button" onClick={onSetDefault} disabled={oauthNotConnected}>{zh ? '设为默认' : 'Set default'}</button> : null}
          <button type="button" onClick={onTest} disabled={testing}>{testing ? '…' : (zh ? '测试' : 'Test')}</button>
          <button type="button" onClick={onEdit}>{zh ? '设置' : 'Settings'}</button>
          <button type="button" className="danger" onClick={onDelete}>{zh ? '删除' : 'Delete'}</button>
        </div>
      </div>
    </details>
  );
}
