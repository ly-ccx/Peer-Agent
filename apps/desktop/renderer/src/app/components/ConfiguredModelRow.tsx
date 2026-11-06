import { MotionDetails } from './MotionDetails';
import { PeerIcon } from '../../ui/icons';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView, LlmProviderTestResult } from '@peer-agent/protocol';
import { LlmBrandIcon } from './LlmBrandIcon';
import { useConfirm } from './ConfirmProvider';
import { OverflowMenu } from './OverflowMenu';
import { usageTime } from './accountUsagePresentation';
import { modelConnectionBadge } from './llmConnectionStatus';
import { modelMetadataCompletion, selectedModelContextWindow } from './llmModelConfiguration';

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
  duplicating = false,
  onSetDefault,
  onTest,
  onDuplicate,
  onEdit,
  onDelete,
}: {
  readonly i18n: I18nRuntime;
  readonly model: LlmProviderConfigView;
  readonly result?: LlmProviderTestResult;
  readonly testing: boolean;
  readonly duplicating?: boolean;
  readonly onSetDefault: () => void;
  readonly onTest: () => void;
  readonly onDuplicate: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const zh = i18n.locale === 'zh-CN';
  const confirm = useConfirm();
  const handleDelete = async () => {
    const label = model.modelLabel || model.model;
    const ok = await confirm({
      title: zh ? '删除模型' : 'Delete model',
      message: zh
        ? `确认删除模型「${label}」的配置？此操作不可撤销。`
        : `Delete the configuration for model “${label}”? This cannot be undone.`,
      confirmText: zh ? '删除模型' : 'Delete model',
      cancelText: zh ? '取消' : 'Cancel',
      tone: 'danger',
    });
    if (ok) onDelete();
  };
  const completion = modelMetadataCompletion(model);
  const connectionBadge = modelConnectionBadge(model.connectionState, zh);
  const context = compactTokens(selectedModelContextWindow(model));
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
    { key: 'prompt-cache', label: zh ? '提示缓存' : 'Prompt cache', value: model.supportsPromptCaching !== false },
  ];

  return (
    <MotionDetails className={`llm-configured-model-row ${model.isDefault ? 'is-default' : ''}`}>
      <summary className="llm-configured-model-summary">
        <LlmBrandIcon
          className="llm-brand-icon-model"
          channelId={model.channelId}
          providerName={model.name}
          serviceTemplateId={model.serviceTemplateId}
          modelId={model.model}
        />
        <div className="llm-configured-model-main">
          <div className="llm-configured-model-title">
            <strong>{model.modelLabel || model.model}</strong>
            {model.isDefault ? <span className="llm-badge-default">{zh ? '默认' : 'Default'}</span> : null}
          </div>
          <code title={model.model}>{model.model}</code>
        </div>
        <div className="llm-configured-model-status">
          {connectionBadge ? (
            <span className={`llm-model-connection-badge tone-${connectionBadge.tone}`}>
              {connectionBadge.text}
            </span>
          ) : null}
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
          <small className="llm-configured-model-provenance">
            <span>{zh ? '来源' : 'Source'}: {metadataSource}</span>
            {model.metadataSyncedAt ? (
              <time dateTime={model.metadataSyncedAt} title={model.metadataSyncedAt}>
                {zh ? '同步于' : 'Synced'} {usageTime(model.metadataSyncedAt, zh)}
              </time>
            ) : null}
          </small>
          {result ? (
            <div className={`llm-test-result ${result.success ? 'success' : 'fail'}`}>
              <small>
                <PeerIcon name={result.success ? "check" : "close"} size={14} className="inline-icon" />
                {result.success
                  ? `${result.model || model.model}${result.latencyMs != null ? ` (${result.latencyMs}ms)` : ''}`
                  : `${result.connectionStateReason || result.error || 'connection_failed'}`}
              </small>
              {result.stages && result.stages.length > 0 ? (
                <ul className="llm-test-stages">
                  {result.stages.map((stage) => (
                    <li key={stage.id} className={`stage-${stage.status}`}>
                      <PeerIcon name={stage.status === 'passed' ? 'check' : stage.status === 'failed' ? 'close' : 'minus'} size={12} className="inline-icon" />{stage.title}
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.errorCategory ? (
                <small className="llm-test-error-category">{result.errorCategory}</small>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="llm-configured-model-actions">
          {!model.isDefault ? <button type="button" onClick={onSetDefault} disabled={oauthNotConnected}>{zh ? '设为默认' : 'Set default'}</button> : null}
          <button type="button" onClick={onTest} disabled={testing || duplicating}>{testing ? <PeerIcon name="ellipsis" size={14} className="inline-icon" /> : null}{testing ? (zh ? '测试中' : 'Testing') : (zh ? '测试' : 'Test')}</button>
          <button type="button" onClick={onEdit} disabled={duplicating}>{zh ? '设置' : 'Settings'}</button>
          <OverflowMenu
            zh={zh}
            label={zh ? `${model.modelLabel || model.model} 的更多操作` : `More actions for ${model.modelLabel || model.model}`}
            items={[
              { key: 'duplicate', label: duplicating ? (zh ? '复制中' : 'Duplicating') : (zh ? '复制' : 'Duplicate'), disabled: testing || duplicating, onSelect: onDuplicate },
              { key: 'delete', label: zh ? '删除' : 'Delete', danger: true, disabled: duplicating, onSelect: () => { void handleDelete(); } },
            ]}
          />
        </div>
      </div>
    </MotionDetails>
  );
}
