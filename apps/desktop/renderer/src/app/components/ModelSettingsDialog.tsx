import type { I18nRuntime } from '@peer-agent/i18n';
import {
  resolveLlmModelOptionValues,
  type LlmModelOptionValues,
  type LlmProviderConfigView,
  type LlmReasoningParamStyle,
} from '@peer-agent/protocol';
import { useState } from 'react';
import { Dropdown } from './Dropdown';
import { Overlay } from './Overlay';
import {
  formatReasoningEffortMap,
  modelMetadataCompletion,
  parseReasoningEffortMap,
  updateModelOptionSelection,
} from './llmModelConfiguration';

interface ModelSettingsForm {
  nickname: string;
  modelId: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPrice: string;
  outputPrice: string;
  cacheWritePrice: string;
  cacheReadPrice: string;
  supportsVision: 'unknown' | 'yes' | 'no';
  supportsReasoning: 'unknown' | 'yes' | 'no';
  supportsPromptCaching: 'unknown' | 'yes' | 'no';
  reasoningParamStyle: LlmReasoningParamStyle | '';
  reasoningEffortMapText: string;
  modelOptionValues: LlmModelOptionValues;
}

const asOptionalNumber = (value: string): number | null => value.trim() ? Number(value) : null;
const capabilityValue = (value: 'unknown' | 'yes' | 'no'): boolean | null => value === 'unknown' ? null : value === 'yes';
const capabilityState = (value: boolean | undefined): 'unknown' | 'yes' | 'no' => value === undefined ? 'unknown' : value ? 'yes' : 'no';

function sourceLabel(source: LlmProviderConfigView['metadataSource'], zh: boolean): string {
  if (source === 'remote') return zh ? '远程目录' : 'Remote catalog';
  if (source === 'models.dev') return 'models.dev';
  if (source === 'builtin') return zh ? '内置目录' : 'Built-in catalog';
  if (source === 'local') return zh ? '本机目录' : 'Local catalog';
  if (source === 'manual') return zh ? '手动维护' : 'Manual';
  return zh ? '历史配置' : 'Legacy config';
}

export function ModelSettingsDialog({
  i18n,
  model,
  onSave,
  onClose,
}: {
  readonly i18n: I18nRuntime;
  readonly model: LlmProviderConfigView;
  readonly onSave: (patch: Record<string, unknown>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const zh = i18n.locale === 'zh-CN';
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<ModelSettingsForm>({
    nickname: model.modelLabel ?? '',
    modelId: model.model ?? '',
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
    inputPrice: model.inputPrice != null ? String(model.inputPrice) : '',
    outputPrice: model.outputPrice != null ? String(model.outputPrice) : '',
    cacheWritePrice: model.cacheWritePrice != null ? String(model.cacheWritePrice) : '',
    cacheReadPrice: model.cacheReadPrice != null ? String(model.cacheReadPrice) : '',
    supportsVision: capabilityState(model.supportsVision),
    supportsReasoning: capabilityState(model.supportsReasoning),
    supportsPromptCaching: capabilityState(model.supportsPromptCaching),
    reasoningParamStyle: model.reasoningParamStyle ?? '',
    reasoningEffortMapText: formatReasoningEffortMap(model.reasoningEffortMap),
    modelOptionValues: resolveLlmModelOptionValues(model.modelOptions, model.modelOptionValues),
  });
  const completion = modelMetadataCompletion(model);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const modelId = form.modelId.trim();
      if (!modelId) {
        setSaveError(zh ? 'Model ID 不能为空' : 'Model ID is required');
        return;
      }
      const reasoningEffortMap = form.supportsReasoning === 'yes'
        ? parseReasoningEffortMap(form.reasoningEffortMapText)
        : undefined;
      await onSave({
        model: modelId,
        modelLabel: form.nickname.trim() || null,
        contextWindow: asOptionalNumber(form.contextWindow),
        maxOutputTokens: asOptionalNumber(form.maxOutputTokens),
        inputPrice: asOptionalNumber(form.inputPrice),
        outputPrice: asOptionalNumber(form.outputPrice),
        cacheWritePrice: asOptionalNumber(form.cacheWritePrice),
        cacheReadPrice: asOptionalNumber(form.cacheReadPrice),
        supportsVision: capabilityValue(form.supportsVision),
        supportsReasoning: capabilityValue(form.supportsReasoning),
        supportsPromptCaching: capabilityValue(form.supportsPromptCaching),
        reasoningParamStyle: form.supportsReasoning === 'yes'
          ? (form.reasoningParamStyle || null)
          : null,
        reasoningEffortMap: reasoningEffortMap ?? null,
        modelOptionValues: form.modelOptionValues,
        metadataSource: 'manual',
        metadataSyncedAt: new Date().toISOString(),
      });
      onClose();
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : 'model_settings_save_failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay onClose={onClose} closeOnBackdrop={!saving} ariaLabel={zh ? '模型设置' : 'Model settings'} panelClassName="llm-model-settings-dialog">
      {({ requestClose }) => (
        <>
          <header className="llm-dialog-header">
            <div>
              <h3>{zh ? '模型设置' : 'Model settings'}</h3>
              <p><code>{model.model}</code></p>
            </div>
            <button type="button" className="llm-dialog-close" onClick={requestClose} aria-label={zh ? '关闭' : 'Close'}>✕</button>
          </header>

          <div className="llm-model-settings-body">
            <section className="llm-settings-section">
              <div className="llm-settings-section-heading">
                <h4>{zh ? '基础' : 'Basics'}</h4>
                <span className={`llm-metadata-state is-${completion}`}>{completion === 'complete' ? (zh ? '元数据完整' : 'Complete') : completion === 'partial' ? (zh ? '部分待完善' : 'Partial') : (zh ? '元数据待完善' : 'Needs metadata')}</span>
              </div>
              <label><span>{zh ? '昵称' : 'Nickname'}</span><input value={form.nickname} placeholder={zh ? '可选' : 'Optional'} onChange={(event) => setForm((current) => ({ ...current, nickname: event.target.value }))} /></label>
              <label>
                <span>Model ID</span>
                <input
                  value={form.modelId}
                  placeholder={zh ? 'API 模型名（同渠道唯一）' : 'API model id (unique in channel)'}
                  onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))}
                  spellCheck={false}
                />
              </label>
              <div className="llm-settings-grid">
                <label><span>{zh ? '上下文长度' : 'Context window'}</span><input type="number" min="0" value={form.contextWindow} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, contextWindow: event.target.value }))} /></label>
                <label><span>{zh ? '最大输出' : 'Max output'}</span><input type="number" min="0" value={form.maxOutputTokens} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, maxOutputTokens: event.target.value }))} /></label>
              </div>
            </section>

            <section className="llm-settings-section">
              <h4>{zh ? '能力' : 'Capabilities'}</h4>
              <div className="llm-settings-capabilities">
                {([
                  ['supportsVision', zh ? '图像输入' : 'Image input'],
                  ['supportsPromptCaching', 'Prompt Cache'],
                  ['supportsReasoning', zh ? '推理模型' : 'Reasoning model'],
                ] as const).map(([field, label]) => (
                  <label key={field}>
                    <span>{label}</span>
                    <Dropdown
                      value={form[field]}
                      options={[
                        { value: 'unknown', label: zh ? '未知' : 'Unknown' },
                        { value: 'yes', label: zh ? '支持' : 'Supported' },
                        { value: 'no', label: zh ? '不支持' : 'Not supported' },
                      ]}
                      onChange={(value) => setForm((current) => ({ ...current, [field]: value as 'unknown' | 'yes' | 'no' }))}
                    />
                  </label>
                ))}
              </div>
              {form.supportsReasoning === 'yes' ? (
                <>
                  <label>
                    <span>{zh ? '推理参数风格' : 'Reasoning parameter style'}</span>
                    <Dropdown
                      value={form.reasoningParamStyle || 'openai-effort'}
                      options={[
                        { value: 'openai-effort', label: 'reasoning_effort' },
                        { value: 'anthropic-enabled-budget', label: 'thinking.budget_tokens' },
                        { value: 'anthropic-adaptive-effort', label: 'adaptive thinking' },
                        { value: 'qwen-enable', label: 'enable_thinking' },
                        { value: 'none', label: zh ? '不发送额外参数' : 'No extra parameter' },
                      ]}
                      onChange={(value) => setForm((current) => ({ ...current, reasoningParamStyle: value as LlmReasoningParamStyle }))}
                    />
                  </label>
                  <label>
                    <span>{zh ? '推理强度映射' : 'Reasoning effort map'}</span>
                    <textarea
                      rows={5}
                      value={form.reasoningEffortMapText}
                      placeholder={'{"low": 1024, "medium": 4096, "high": 8192}'}
                      onChange={(event) => setForm((current) => ({ ...current, reasoningEffortMapText: event.target.value }))}
                    />
                    <small>{zh ? '支持 JSON，或每行 key=value。留空表示未知。' : 'Use JSON or one key=value per line. Leave blank for unknown.'}</small>
                  </label>
                </>
              ) : null}
            </section>

            {model.modelOptions?.length ? (
              <section className="llm-settings-section">
                <h4>{zh ? '渠道模型选项' : 'Channel model options'}</h4>
                <div className="llm-settings-grid">
                  {model.modelOptions.map((definition) => {
                    const selected = form.modelOptionValues[definition.id] ?? definition.defaultValue;
                    return (
                      <label key={definition.id}>
                        <span>{definition.label}</span>
                        <Dropdown
                          value={String(selected)}
                          options={definition.choices.map((choice) => ({
                            value: String(choice.value),
                            label: choice.label,
                          }))}
                          onChange={(value) => setForm((current) => ({
                            ...current,
                            modelOptionValues: updateModelOptionSelection(
                              model.modelOptions,
                              current.modelOptionValues,
                              definition.id,
                              value,
                            ),
                          }))}
                        />
                        {definition.description ? <small>{definition.description}</small> : null}
                      </label>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section className="llm-settings-section">
              <h4>{zh ? '价格（美元 / 百万 tokens）' : 'Pricing (USD / 1M tokens)'}</h4>
              <div className="llm-settings-grid">
                <label><span>{zh ? '输入' : 'Input'}</span><input type="number" min="0" step="any" value={form.inputPrice} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, inputPrice: event.target.value }))} /></label>
                <label><span>{zh ? '输出' : 'Output'}</span><input type="number" min="0" step="any" value={form.outputPrice} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, outputPrice: event.target.value }))} /></label>
                <label><span>{zh ? '缓存写入' : 'Cache write'}</span><input type="number" min="0" step="any" value={form.cacheWritePrice} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, cacheWritePrice: event.target.value }))} /></label>
                <label><span>{zh ? '缓存读取' : 'Cache read'}</span><input type="number" min="0" step="any" value={form.cacheReadPrice} placeholder={zh ? '未知' : 'Unknown'} onChange={(event) => setForm((current) => ({ ...current, cacheReadPrice: event.target.value }))} /></label>
              </div>
            </section>

            <section className="llm-settings-section llm-metadata-source">
              <div><span>{zh ? '数据来源' : 'Metadata source'}</span><strong>{sourceLabel(model.metadataSource, zh)}</strong></div>
              <div><span>{zh ? '最后更新' : 'Last updated'}</span><strong>{model.metadataSyncedAt ? new Date(model.metadataSyncedAt).toLocaleString() : (zh ? '未知' : 'Unknown')}</strong></div>
            </section>
            {saveError ? <p className="llm-catalog-error">{saveError}</p> : null}
          </div>

          <footer className="llm-dialog-footer">
            <button type="button" onClick={requestClose}>{zh ? '取消' : 'Cancel'}</button>
            <button type="button" className="primary" onClick={() => void save()} disabled={saving}>{saving ? '…' : (zh ? '保存模型设置' : 'Save model settings')}</button>
          </footer>
        </>
      )}
    </Overlay>
  );
}
