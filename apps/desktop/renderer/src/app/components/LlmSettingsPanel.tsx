import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmAuthMethod, LlmModelInfo, LlmProviderConfigView, LlmProviderTestResult, LlmProviderType } from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from './Dropdown';

interface FormState {
  provider: LlmProviderType;
  // ADR 28: 鉴权方式(api_key | oauth_chatgpt),与协议族正交。
  authMethod: LlmAuthMethod;
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
  supportsPromptCaching: boolean;
}

const PRESETS: Record<LlmProviderType, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
};

function emptyForm(provider: LlmProviderType = 'openai'): FormState {
  return { provider, authMethod: 'api_key', name: '', baseUrl: PRESETS[provider].baseUrl, model: PRESETS[provider].model, apiKey: '', contextWindow: '', inputPrice: '', outputPrice: '', cacheWritePrice: '', cacheReadPrice: '', supportsVision: false, supportsReasoning: false, supportsPromptCaching: false };
}

// 把后端连通性测试的错误码映射为可读文案；未知码原样透传(便于排障)。
function friendlyTestError(error: string | undefined, locale: string): string {
  const zh = locale === 'zh-CN';
  switch (error) {
    case 'oauth_not_logged_in':
      return zh ? '未登录，请先登录 ChatGPT' : 'Not logged in — please log in to ChatGPT';
    case 'oauth_session_expired':
      return zh ? '登录已过期，请重新登录' : 'Session expired — please re-login';
    case 'API key not configured':
      return zh ? '未配置 API Key' : 'API key not configured';
    default:
      return error || (zh ? '测试失败' : 'Test failed');
  }
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
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  // ADR 28(方案 B): 订阅 provider 的远程模型清单与加载态(按 provider id 维度)。
  const [modelLists, setModelLists] = useState<Record<string, readonly LlmModelInfo[]>>({});
  const [modelLoadingId, setModelLoadingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await clientApi.llmListProviders();
      setProviders(list);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 拉取某订阅 provider 的可用模型(远程,失败回退内置清单)。
  const loadModels = useCallback(async (id: string) => {
    setModelLoadingId(id);
    try {
      const res = await clientApi.llmListModels({ id });
      if (res.success) setModelLists((prev) => ({ ...prev, [id]: res.models }));
    } catch { /* silent */ } finally {
      setModelLoadingId((cur) => (cur === id ? null : cur));
    }
  }, []);

  // 已登录(connected)的订阅 provider 自动加载一次模型清单。
  useEffect(() => {
    for (const p of providers) {
      if (p.authMethod === 'oauth_chatgpt' && p.oauthStatus?.status === 'connected' && !modelLists[p.id]) {
        void loadModels(p.id);
      }
    }
  }, [providers, modelLists, loadModels]);

  // 切换订阅 provider 当前使用的模型。
  const handleSelectModel = async (id: string, model: string) => {
    try {
      await clientApi.llmUpdateProvider({ id, model });
      await refresh();
    } catch { /* silent */ }
  };

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
      provider: p.provider, authMethod: p.authMethod ?? 'api_key', name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '',
      contextWindow: p.contextWindow ? String(p.contextWindow) : '',
      inputPrice: p.inputPrice != null ? String(p.inputPrice) : '',
      outputPrice: p.outputPrice != null ? String(p.outputPrice) : '',
      cacheWritePrice: p.cacheWritePrice != null ? String(p.cacheWritePrice) : '',
      cacheReadPrice: p.cacheReadPrice != null ? String(p.cacheReadPrice) : '',
      supportsVision: p.supportsVision ?? false,
      supportsReasoning: p.supportsReasoning ?? false,
      supportsPromptCaching: p.supportsPromptCaching ?? false,
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
          supportsPromptCaching: form.supportsPromptCaching,
        };
        if (form.apiKey) patch.apiKey = form.apiKey;
        await clientApi.llmUpdateProvider(patch as { id: string });
      } else {
        const draft = {
          provider: form.provider,
          authMethod: form.authMethod,
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
          supportsPromptCaching: form.supportsPromptCaching,
        } as Record<string, unknown>;
        // ADR 28: 订阅链路必须"先登录、成功后才落盘"。
        // 不在这里 llmAddProvider —— 把草稿交给 OAuth,登录成功才由 main 创建 provider,
        // 失败/取消则什么都不留。
        if (form.authMethod === 'oauth_chatgpt') {
          await handleOAuthLogin({ draft });
          return;
        }
        await clientApi.llmAddProvider(draft);
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

  // ADR 28: 拉起 ChatGPT 订阅 OAuth 登录(browser 模式)。token 由 main 进程写入。
  // 链路契约:"先登录、成功后才落盘"。
  // - 传 { id }   : 对已存在订阅 provider 重新登录。
  // - 传 { draft }: 新建订阅,登录成功后才由 main 创建 provider;失败/取消不落盘。
  const handleOAuthLogin = async (
    target: { id: string; draft?: undefined } | { id?: undefined; draft: Record<string, unknown> },
  ) => {
    // 新建订阅尚无 provider id,用 'new' 作为按钮 busy 哨兵。
    const busyKey = target.id ?? 'new';
    setOauthBusyId(busyKey);
    try {
      const result = await clientApi.llmOAuthStart(target);
      if (!result.success) {
        setTestResults((prev) => ({ ...prev, [busyKey]: { success: false, error: result.error } }));
        // 登录失败:保持表单打开,让用户可重试或取消。
        return;
      }
      setShowForm(false);
      setEditingId(null);
      await refresh();
    } catch (err: unknown) {
      setTestResults((prev) => ({ ...prev, [busyKey]: { success: false, error: err instanceof Error ? err.message : 'Login failed' } }));
    } finally {
      setOauthBusyId(null);
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
              {p.authMethod === 'oauth_chatgpt' ? (
                <small className={`llm-provider-key llm-oauth-status-${p.oauthStatus?.status ?? 'disconnected'}`}>
                  {p.oauthStatus?.status === 'connected'
                    ? (i18n.locale === 'zh-CN' ? `已登录${p.oauthStatus.accountId ? ` · ${p.oauthStatus.accountId}` : ''}` : `Connected${p.oauthStatus.accountId ? ` · ${p.oauthStatus.accountId}` : ''}`)
                    : p.oauthStatus?.status === 'expired'
                      ? (i18n.locale === 'zh-CN' ? '登录已过期,请重新登录' : 'Session expired, please re-login')
                      : (i18n.locale === 'zh-CN' ? '未登录' : 'Not logged in')}
                </small>
              ) : (
                <small className="llm-provider-key">
                  {p.apiKeyConfigured ? `Key: ${p.apiKeyMasked}` : (i18n.locale === 'zh-CN' ? '未配置 Key' : 'Key not set')}
                </small>
              )}
              {p.authMethod === 'oauth_chatgpt' && p.oauthStatus?.status === 'connected' ? (
                <div className="llm-model-select">
                  <span>{i18n.locale === 'zh-CN' ? '模型' : 'Model'}</span>
                  <Dropdown
                    value={p.model}
                    disabled={modelLoadingId === p.id && !modelLists[p.id]}
                    ariaLabel={i18n.locale === 'zh-CN' ? '选择模型' : 'Select model'}
                    placeholder={
                      modelLoadingId === p.id && !modelLists[p.id]
                        ? (i18n.locale === 'zh-CN' ? '加载中…' : 'Loading…')
                        : p.model
                    }
                    options={(modelLists[p.id] && modelLists[p.id].length > 0
                      ? modelLists[p.id]
                      : [{ id: p.model, label: p.model } as LlmModelInfo]
                    ).map((m) => ({ value: m.id, label: m.label }))}
                    onChange={(value) => void handleSelectModel(p.id, value)}
                  />
                </div>
              ) : null}
              {testResults[p.id] ? (
                <small className={`llm-test-result ${testResults[p.id].success ? 'success' : 'fail'}`}>
                  {testResults[p.id].success
                    ? `✓ ${testResults[p.id].model} (${testResults[p.id].latencyMs}ms)`
                    : `✗ ${friendlyTestError(testResults[p.id].error, i18n.locale)}`}
                </small>
              ) : null}
            </div>
            <div className="llm-provider-actions">
              {!p.isDefault ? (
                <button type="button" onClick={() => handleSetDefault(p.id)}>
                  {i18n.locale === 'zh-CN' ? '设为默认' : 'Set Default'}
                </button>
              ) : null}
              {p.authMethod === 'oauth_chatgpt' && p.oauthStatus?.status !== 'connected' ? (
                <button type="button" className="primary" onClick={() => void handleOAuthLogin({ id: p.id })} disabled={oauthBusyId === p.id}>
                  {oauthBusyId === p.id ? '...' : (i18n.locale === 'zh-CN' ? '重新登录' : 'Re-login')}
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

          {form.provider === 'openai' && !editingId ? (
            <label>
              <span>{i18n.locale === 'zh-CN' ? '鉴权方式' : 'Auth Method'}</span>
              <div className="llm-radio-group">
                <label>
                  <input type="radio" checked={form.authMethod === 'api_key'} onChange={() => setForm((prev) => ({ ...prev, authMethod: 'api_key' }))} />
                  API Key
                </label>
                <label>
                  <input type="radio" checked={form.authMethod === 'oauth_chatgpt'} onChange={() => setForm((prev) => ({ ...prev, authMethod: 'oauth_chatgpt' }))} />
                  {i18n.locale === 'zh-CN' ? 'ChatGPT 订阅登录' : 'ChatGPT Subscription'}
                </label>
              </div>
            </label>
          ) : null}

          {/* ADR 28: 订阅(OAuth)模式下显示名称/baseUrl/模型/定价均由系统确定,表单折叠为"仅登录"。 */}
          {form.authMethod === 'oauth_chatgpt' ? (
            <label>
              <span>{i18n.locale === 'zh-CN' ? '登录' : 'Login'}</span>
              <p className="llm-oauth-hint">
                {i18n.locale === 'zh-CN'
                  ? '点击登录将打开浏览器完成 ChatGPT 订阅账号登录;登录成功后才会保存,登录失败或取消不会保存任何配置。登录后自动拉取可用模型(默认使用最新模型)。'
                  : 'Clicking login opens your browser to sign in with your ChatGPT subscription. The provider is saved only after a successful login — nothing is saved if login fails or is cancelled. Available models are fetched after login (latest selected by default).'}
              </p>
            </label>
          ) : (
            <>
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
            </>
          )}

          {form.authMethod !== 'oauth_chatgpt' ? (
          <>
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

          <label className="llm-vision-toggle">
            <input
              type="checkbox"
              checked={form.supportsPromptCaching}
              onChange={(e) => setForm((prev) => ({ ...prev, supportsPromptCaching: e.target.checked }))}
            />
            <span>{i18n.locale === 'zh-CN' ? '启用 Prompt 缓存（仅当网关真正复用缓存时开启，否则纯增成本）' : 'Enable prompt caching (only if the gateway actually reuses cache; otherwise pure cost)'}</span>
          </label>
          </>
          ) : null}

          <div className="llm-form-actions">
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}>
              {i18n.locale === 'zh-CN' ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="primary" onClick={handleSave} disabled={saving || Boolean(oauthBusyId) || (form.authMethod !== 'oauth_chatgpt' && !form.apiKey && !editingId)}>
              {saving || oauthBusyId ? '...' : (form.authMethod === 'oauth_chatgpt' && !editingId ? (i18n.locale === 'zh-CN' ? '登录 ChatGPT' : 'Login with ChatGPT') : (i18n.locale === 'zh-CN' ? '保存' : 'Save'))}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
