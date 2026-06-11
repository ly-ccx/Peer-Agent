import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView, LlmProviderTestResult, LlmProviderType } from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

interface FormState {
  provider: LlmProviderType;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: string;
  inputPrice: string;
  outputPrice: string;
  cacheWritePrice: string;
  cacheReadPrice: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

const PRESETS: Record<LlmProviderType, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
};

function emptyForm(provider: LlmProviderType = 'openai'): FormState {
  return { provider, name: '', baseUrl: PRESETS[provider].baseUrl, model: PRESETS[provider].model, apiKey: '', contextWindow: '', inputPrice: '', outputPrice: '', cacheWritePrice: '', cacheReadPrice: '', supportsVision: false, supportsReasoning: false };
}

export function LlmSettingsPanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
}) {
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, LlmProviderTestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await clientApi.llmListProviders();
      setProviders(list);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleProviderTypeChange = (provider: LlmProviderType) => {
    const preset = PRESETS[provider];
    setForm((prev) => ({
      ...prev,
      provider,
      baseUrl: prev.baseUrl === PRESETS[prev.provider].baseUrl ? preset.baseUrl : prev.baseUrl,
      model: prev.model === PRESETS[prev.provider].model ? preset.model : prev.model,
    }));
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
  };

  const openEdit = (p: LlmProviderConfigView) => {
    setEditingId(p.id);
    setForm({
      provider: p.provider, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '',
      contextWindow: p.contextWindow ? String(p.contextWindow) : '',
      inputPrice: p.inputPrice != null ? String(p.inputPrice) : '',
      outputPrice: p.outputPrice != null ? String(p.outputPrice) : '',
      cacheWritePrice: p.cacheWritePrice != null ? String(p.cacheWritePrice) : '',
      cacheReadPrice: p.cacheReadPrice != null ? String(p.cacheReadPrice) : '',
      supportsVision: p.supportsVision ?? false,
      supportsReasoning: p.supportsReasoning ?? false,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const ctxWin = form.contextWindow ? Number(form.contextWindow) : undefined;
      const inPrice = form.inputPrice ? Number(form.inputPrice) : undefined;
      const outPrice = form.outputPrice ? Number(form.outputPrice) : undefined;
      const cwPrice = form.cacheWritePrice ? Number(form.cacheWritePrice) : undefined;
      const crPrice = form.cacheReadPrice ? Number(form.cacheReadPrice) : undefined;
      if (editingId) {
        const patch: Record<string, unknown> = {
          id: editingId,
          provider: form.provider,
          name: form.name,
          baseUrl: form.baseUrl,
          model: form.model,
          contextWindow: ctxWin,
          inputPrice: inPrice,
          outputPrice: outPrice,
          cacheWritePrice: cwPrice,
          cacheReadPrice: crPrice,
          supportsVision: form.supportsVision,
          supportsReasoning: form.supportsReasoning,
        };
        if (form.apiKey) patch.apiKey = form.apiKey;
        await clientApi.llmUpdateProvider(patch as { id: string });
      } else {
        await clientApi.llmAddProvider({
          provider: form.provider,
          name: form.name || form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          apiKey: form.apiKey,
          contextWindow: ctxWin,
          inputPrice: inPrice,
          outputPrice: outPrice,
          cacheWritePrice: cwPrice,
          cacheReadPrice: crPrice,
          supportsVision: form.supportsVision,
          supportsReasoning: form.supportsReasoning,
        } as Record<string, unknown>);
      }
      setShowForm(false);
      setEditingId(null);
      await refresh();
    } catch { /* silent */ } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await clientApi.llmRemoveProvider({ id });
    if (editingId === id) { setShowForm(false); setEditingId(null); }
    await refresh();
  };

  const handleSetDefault = async (id: string) => {
    await clientApi.llmSetDefault({ id });
    await refresh();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await clientApi.llmTestConnection({ id });
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: unknown) {
      setTestResults((prev) => ({ ...prev, [id]: { success: false, error: err instanceof Error ? err.message : 'Test failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="llm-settings-panel">
      {onBack ? (
        <header className="llm-settings-header">
          <button type="button" onClick={onBack} aria-label="Back">←</button>
          <strong>{i18n.locale === 'zh-CN' ? '模型配置' : 'Model Settings'}</strong>
        </header>
      ) : null}

      <div className="llm-provider-list">
        {providers.length === 0 ? (
          <p className="llm-empty">{i18n.locale === 'zh-CN' ? '尚未配置任何模型，点击下方按钮添加。' : 'No models configured. Add one below.'}</p>
        ) : providers.map((p) => (
          <div key={p.id} className={`llm-provider-card ${p.isDefault ? 'is-default' : ''}`}>
            <div className="llm-provider-info">
              <strong>{p.name || p.provider}</strong>
              <span className="llm-provider-meta">
                {p.provider.toUpperCase()} · {p.model}
                {p.isDefault ? <span className="llm-badge-default">{i18n.locale === 'zh-CN' ? '默认' : 'Default'}</span> : null}
              </span>
              {p.contextWindow || p.inputPrice != null ? (
                <span className="llm-provider-specs">
                  {p.contextWindow ? `${(p.contextWindow / 1000).toFixed(0)}K ctx` : ''}
                  {p.contextWindow && p.inputPrice != null ? ' · ' : ''}
                  {p.inputPrice != null ? `$${p.inputPrice}/${p.outputPrice ?? '?'}` : ''}
                </span>
              ) : null}
              <small className="llm-provider-key">
                {p.apiKeyConfigured ? `Key: ${p.apiKeyMasked}` : (i18n.locale === 'zh-CN' ? '未配置 Key' : 'Key not set')}
              </small>
              {testResults[p.id] ? (
                <small className={`llm-test-result ${testResults[p.id].success ? 'success' : 'fail'}`}>
                  {testResults[p.id].success
                    ? `✓ ${testResults[p.id].model} (${testResults[p.id].latencyMs}ms)`
                    : `✗ ${testResults[p.id].error}`}
                </small>
              ) : null}
            </div>
            <div className="llm-provider-actions">
              {!p.isDefault ? (
                <button type="button" onClick={() => handleSetDefault(p.id)}>
                  {i18n.locale === 'zh-CN' ? '设为默认' : 'Set Default'}
                </button>
              ) : null}
              <button type="button" onClick={() => handleTest(p.id)} disabled={testingId === p.id}>
                {testingId === p.id ? '...' : (i18n.locale === 'zh-CN' ? '测试' : 'Test')}
              </button>
              <button type="button" onClick={() => openEdit(p)}>
                {i18n.locale === 'zh-CN' ? '编辑' : 'Edit'}
              </button>
              <button type="button" className="danger" onClick={() => handleDelete(p.id)}>
                {i18n.locale === 'zh-CN' ? '删除' : 'Delete'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {!showForm ? (
        <button type="button" className="llm-add-btn" onClick={openAdd}>
          ＋ {i18n.locale === 'zh-CN' ? '添加模型' : 'Add Model'}
        </button>
      ) : (
        <div className="llm-form">
          <h3>{editingId ? (i18n.locale === 'zh-CN' ? '编辑模型' : 'Edit Model') : (i18n.locale === 'zh-CN' ? '添加模型' : 'Add Model')}</h3>

          <label>
            <span>{i18n.locale === 'zh-CN' ? '协议类型' : 'Protocol'}</span>
            <div className="llm-radio-group">
              <label>
                <input type="radio" checked={form.provider === 'openai'} onChange={() => handleProviderTypeChange('openai')} />
                OpenAI {i18n.locale === 'zh-CN' ? '兼容' : 'Compatible'}
              </label>
              <label>
                <input type="radio" checked={form.provider === 'anthropic'} onChange={() => handleProviderTypeChange('anthropic')} />
                Anthropic {i18n.locale === 'zh-CN' ? '兼容' : 'Compatible'}
              </label>
            </div>
          </label>

          <label>
            <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
            <input value={form.name} placeholder={form.provider} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          </label>

          <label>
            <span>Base URL</span>
            <input value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} />
          </label>

          <label>
            <span>API Key</span>
            <input type="password" value={form.apiKey} placeholder={editingId ? (i18n.locale === 'zh-CN' ? '留空则不修改' : 'Leave empty to keep') : ''} onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))} />
          </label>

          <label>
            <span>{i18n.locale === 'zh-CN' ? '模型名称' : 'Model'}</span>
            <input value={form.model} onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))} />
          </label>

          <label>
            <span>{i18n.locale === 'zh-CN' ? '上下文窗口' : 'Context Window'}</span>
            <input type="number" value={form.contextWindow} placeholder={i18n.locale === 'zh-CN' ? '如 200000' : 'e.g. 200000'} onChange={(e) => setForm((prev) => ({ ...prev, contextWindow: e.target.value }))} />
          </label>

          <div className="llm-price-group">
            <span className="llm-price-group-label">{i18n.locale === 'zh-CN' ? '定价（$/百万 tokens）' : 'Pricing ($/M tokens)'}</span>
            <div className="llm-price-row">
              <label className="llm-price-field">
                <span>{i18n.locale === 'zh-CN' ? '输入' : 'Input'}</span>
                <input type="number" step="0.01" value={form.inputPrice} placeholder="0.00" onChange={(e) => setForm((prev) => ({ ...prev, inputPrice: e.target.value }))} />
              </label>
              <label className="llm-price-field">
                <span>{i18n.locale === 'zh-CN' ? '输出' : 'Output'}</span>
                <input type="number" step="0.01" value={form.outputPrice} placeholder="0.00" onChange={(e) => setForm((prev) => ({ ...prev, outputPrice: e.target.value }))} />
              </label>
            </div>
            <div className="llm-price-row">
              <label className="llm-price-field">
                <span>{i18n.locale === 'zh-CN' ? '缓存写入' : 'Cache Write'}</span>
                <input type="number" step="0.01" value={form.cacheWritePrice} placeholder="0.00" onChange={(e) => setForm((prev) => ({ ...prev, cacheWritePrice: e.target.value }))} />
              </label>
              <label className="llm-price-field">
                <span>{i18n.locale === 'zh-CN' ? '缓存读取' : 'Cache Read'}</span>
                <input type="number" step="0.01" value={form.cacheReadPrice} placeholder="0.00" onChange={(e) => setForm((prev) => ({ ...prev, cacheReadPrice: e.target.value }))} />
              </label>
            </div>
          </div>

          <label className="llm-vision-toggle">
            <input
              type="checkbox"
              checked={form.supportsVision}
              onChange={(e) => setForm((prev) => ({ ...prev, supportsVision: e.target.checked }))}
            />
            <span>{i18n.locale === 'zh-CN' ? '支持多模态（图像输入）' : 'Multimodal (image input) support'}</span>
          </label>

          <label className="llm-vision-toggle">
            <input
              type="checkbox"
              checked={form.supportsReasoning}
              onChange={(e) => setForm((prev) => ({ ...prev, supportsReasoning: e.target.checked }))}
            />
            <span>{i18n.locale === 'zh-CN' ? '支持原生推理参数（reasoning/thinking）' : 'Native reasoning/thinking parameters'}</span>
          </label>

          <div className="llm-form-actions">
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}>
              {i18n.locale === 'zh-CN' ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="primary" onClick={handleSave} disabled={saving || (!form.apiKey && !editingId)}>
              {saving ? '...' : (i18n.locale === 'zh-CN' ? '保存' : 'Save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
