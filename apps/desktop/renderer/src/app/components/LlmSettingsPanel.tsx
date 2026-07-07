import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  LlmAuthMethod,
  LlmChannelDescriptor,
  LlmModelInfo,
  LlmProviderConfigView,
  LlmProviderTestResult,
  LlmProviderType,
  LlmReasoningEffortMap,
  LlmReasoningParamStyle,
  LlmWireProtocol,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Drawer } from './Drawer';
import { Dropdown } from './Dropdown';

interface FormState {
  provider: LlmProviderType;
  channelId: string;
  wireOverride: LlmWireProtocol | '';
  reasoningParamStyle: LlmReasoningParamStyle | '';
  reasoningEffortMapText: string;
  customHeadersText: string;
  // ADR 28: 鉴权方式(api_key | oauth_chatgpt),与协议族正交。
  authMethod: LlmAuthMethod;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthProjectId: string;
  contextWindow: string;
  maxOutputTokens: string;
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

const FALLBACK_CHANNELS: readonly LlmChannelDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI 官方',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat', 'openai-responses'],
    defaults: PRESETS.openai,
    capabilities: { reasoning: { supported: true, paramStyle: 'openai-effort' }, promptCache: true, vision: true },
    authMethods: { api_key: { wire: 'openai-chat' }, oauth_chatgpt: { wire: 'openai-responses' } },
  },
  {
    id: 'anthropic',
    label: 'Anthropic 官方',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    defaults: PRESETS.anthropic,
    capabilities: { reasoning: { supported: true, paramStyle: 'anthropic-enabled-budget' }, promptCache: true, vision: true },
    authMethods: { api_key: { wire: 'anthropic-messages' } },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    legacyProvider: 'openai',
    defaultWire: 'openai-chat',
    allowedWires: ['openai-chat', 'openai-responses'],
    defaults: PRESETS.openai,
    capabilities: { reasoning: { supported: false, paramStyle: 'openai-effort' }, promptCache: false, vision: false },
    authMethods: { api_key: { wire: 'openai-chat' } },
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic 兼容',
    legacyProvider: 'anthropic',
    defaultWire: 'anthropic-messages',
    allowedWires: ['anthropic-messages'],
    defaults: PRESETS.anthropic,
    capabilities: { reasoning: { supported: false, paramStyle: 'anthropic-enabled-budget' }, promptCache: false, vision: false },
    authMethods: { api_key: { wire: 'anthropic-messages' } },
  },
  {
    id: 'google-ai',
    label: 'Google AI / Gemini',
    legacyProvider: 'openai',
    defaultWire: 'gemini',
    allowedWires: ['gemini'],
    defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
    capabilities: { reasoning: { supported: false, paramStyle: 'none' }, promptCache: false, vision: true },
    authMethods: { api_key: { wire: 'gemini' }, oauth_google: { wire: 'gemini' } },
  },
  {
    id: 'qoder',
    label: 'Qoder 私有接口',
    legacyProvider: 'openai',
    defaultWire: 'qoder-private',
    allowedWires: ['qoder-private'],
    defaults: { baseUrl: 'https://api2-v2.qoder.sh/model/v1', model: 'auto' },
    capabilities: { reasoning: { supported: false, paramStyle: 'none' }, promptCache: false, vision: false },
    authMethods: { qoder_local_auth: { wire: 'qoder-private' }, local_cli: { wire: 'qoder-private' } },
  },
];

function descriptorFor(channelId: string, channels: readonly LlmChannelDescriptor[]): LlmChannelDescriptor {
  return channels.find((channel) => channel.id === channelId)
    ?? channels.find((channel) => channel.id === 'openai-compatible')
    ?? channels[0]
    ?? FALLBACK_CHANNELS[2];
}

const PROTECTED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'anthropic-version',
  'openai-beta',
  'x-goog-api-key',
  'x-goog-user-project',
  'chatgpt-account-id',
]);

function isOAuthMethod(method: LlmAuthMethod): boolean {
  return method === 'oauth_chatgpt' || method === 'oauth_google';
}

function isLocalCliMethod(method: LlmAuthMethod): boolean {
  return method === 'qoder_local_auth' || method === 'local_cli';
}

function defaultAuthMethod(channel: LlmChannelDescriptor): LlmAuthMethod {
  if (channel.authMethods?.api_key) return 'api_key';
  if (channel.authMethods?.qoder_local_auth) return 'qoder_local_auth';
  if (channel.authMethods?.local_cli) return 'local_cli';
  const [first] = Object.keys(channel.authMethods || {});
  return (first || 'api_key') as LlmAuthMethod;
}

function oauthLabel(method: LlmAuthMethod, locale: string): string {
  const zh = locale === 'zh-CN';
  if (method === 'oauth_google') return zh ? 'Google OAuth 登录' : 'Google OAuth';
  if (method === 'oauth_chatgpt') return zh ? 'ChatGPT 订阅登录' : 'ChatGPT Subscription';
  return 'API Key';
}

function wireLabel(wire: string | undefined, locale: string): string {
  const zh = locale === 'zh-CN';
  switch (wire) {
    case 'openai-chat':
      return zh ? 'Chat Completions' : 'Chat Completions';
    case 'openai-responses':
      return zh ? 'Responses API' : 'Responses API';
    case 'anthropic-messages':
      return zh ? 'Messages API' : 'Messages API';
    case 'gemini':
      return zh ? 'Gemini GenerateContent' : 'Gemini GenerateContent';
    case 'qoder-private':
      return zh ? 'Qoder 私有接口' : 'Qoder Private API';
    default:
      return wire || (zh ? '未解析' : 'Unresolved');
  }
}

function reasoningStyleLabel(style: string | undefined, locale: string): string {
  const zh = locale === 'zh-CN';
  switch (style) {
    case 'openai-effort':
      return zh ? 'OpenAI reasoning_effort' : 'OpenAI reasoning_effort';
    case 'qwen-enable':
      return zh ? 'Qwen enable_thinking' : 'Qwen enable_thinking';
    case 'anthropic-enabled-budget':
      return zh ? 'Anthropic thinking budget_tokens' : 'Anthropic thinking budget_tokens';
    case 'anthropic-adaptive-effort':
      return zh ? 'Anthropic adaptive effort' : 'Anthropic adaptive effort';
    case 'anthropic-output-effort':
      return zh ? 'Anthropic output reasoning_effort' : 'Anthropic output reasoning_effort';
    case 'none':
      return zh ? '不发送推理参数' : 'Do not send reasoning parameters';
    default:
      return style || (zh ? '不发送推理参数' : 'Do not send reasoning parameters');
  }
}

function formatModelTokenLimit(tokens: number): string {
  if (tokens > 0 && tokens % 1024 === 0 && tokens % 1000 !== 0) {
    return `${Math.floor(tokens / 1024)}K`;
  }
  return `${(tokens / 1000).toFixed(0)}K`;
}

function modelMetadataPatch(model: LlmModelInfo | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!model) return patch;
  if (model.label) patch.modelLabel = model.label;
  if (typeof model.contextWindow === 'number') patch.contextWindow = model.contextWindow;
  if (typeof model.maxOutputTokens === 'number') patch.maxOutputTokens = model.maxOutputTokens;
  if (typeof model.supportsVision === 'boolean') patch.supportsVision = model.supportsVision;
  if (typeof model.supportsReasoning === 'boolean') patch.supportsReasoning = model.supportsReasoning;
  return patch;
}

function formatReasoningEffortMap(map: LlmReasoningEffortMap | undefined): string {
  return map ? JSON.stringify(map, null, 2) : '';
}

function parseReasoningEffortMap(text: string): LlmReasoningEffortMap | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed: Record<string, string | number> = {};
  const assign = (key: string, value: unknown) => {
    const name = String(key || '').trim();
    if (!name) throw new Error('reasoning_effort_map_invalid');
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed[name] = value;
      return;
    }
    if (typeof value === 'string' && value.trim()) {
      const raw = value.trim();
      const asNumber = Number(raw);
      parsed[name] = Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(raw) ? asNumber : raw;
      return;
    }
    throw new Error('reasoning_effort_map_invalid');
  };

  if (trimmed.startsWith('{')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error('reasoning_effort_map_invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reasoning_effort_map_invalid');
    for (const [key, item] of Object.entries(value)) assign(key, item);
  } else {
    for (const rawLine of trimmed.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx <= 0) throw new Error('reasoning_effort_map_invalid');
      assign(line.slice(0, idx), line.slice(idx + 1));
    }
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function formatCustomHeaders(headers: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function parseCustomHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) throw new Error('custom_header_invalid_line');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) throw new Error('custom_header_invalid_line');
    const lowerKey = key.toLowerCase();
    if (PROTECTED_HEADER_NAMES.has(lowerKey)) throw new Error(`custom_header_protected:${lowerKey}`);
    headers[key] = value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function validateForm(
  form: FormState,
  editingId: string | null,
  selectedChannel: LlmChannelDescriptor,
  // B-2 组内加模型:凭证(apiKey/baseUrl)继承自组内首条,不要求用户重填。
  isAddModel = false,
): string | null {
  if (!selectedChannel.id) return 'unknown_channel';
  if (isLocalCliMethod(form.authMethod)) {
    if (!selectedChannel.authMethods?.qoder_local_auth && !selectedChannel.authMethods?.local_cli) return 'unsupported_auth_method';
    if (!form.model.trim()) return 'model_required';
    return null;
  }
  if (isOAuthMethod(form.authMethod)) {
    if (!selectedChannel.authMethods?.[form.authMethod]) return 'unsupported_auth_method';
    if (form.authMethod === 'oauth_google') {
      if (!form.oauthClientId.trim()) return 'oauth_google_client_id_required';
      if (!editingId && !form.oauthClientSecret.trim()) return 'oauth_google_client_secret_required';
      if (!form.oauthProjectId.trim()) return 'oauth_google_project_required';
      if (!form.model.trim()) return 'model_required';
    }
    return null;
  }
  if (!isAddModel && !form.baseUrl.trim()) return 'base_url_required';
  if (!form.model.trim()) return 'model_required';
  if (!editingId && !isAddModel && !form.apiKey.trim()) return 'api_key_required';
  try {
    parseCustomHeaders(form.customHeadersText);
    if (form.supportsReasoning) parseReasoningEffortMap(form.reasoningEffortMapText);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : 'custom_header_invalid_line';
  }
  const numberFields = [
    form.contextWindow,
    form.maxOutputTokens,
    form.inputPrice,
    form.outputPrice,
    form.cacheWritePrice,
    form.cacheReadPrice,
  ];
  if (numberFields.some((value) => value.trim() && (!Number.isFinite(Number(value)) || Number(value) < 0))) {
    return 'number_field_invalid';
  }
  return null;
}

function emptyForm(channels: readonly LlmChannelDescriptor[] = FALLBACK_CHANNELS, channelId = 'openai-compatible'): FormState {
  const channel = descriptorFor(channelId, channels);
  const provider = channel.legacyProvider;
  const authMethod = defaultAuthMethod(channel);
  return {
    provider,
    channelId: channel.id,
    wireOverride: '',
    reasoningParamStyle: channel.capabilities?.reasoning?.paramStyle ?? '',
    reasoningEffortMapText: '',
    customHeadersText: '',
    authMethod,
    name: '',
    baseUrl: channel.defaults.baseUrl,
    model: channel.defaults.model,
    apiKey: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthProjectId: '',
    contextWindow: '',
    maxOutputTokens: '',
    inputPrice: '',
    outputPrice: '',
    cacheWritePrice: '',
    cacheReadPrice: '',
    supportsVision: channel.capabilities?.vision ?? false,
    supportsReasoning: channel.capabilities?.reasoning?.supported ?? false,
    supportsPromptCaching: channel.capabilities?.promptCache ?? false,
  };
}

// 把后端连通性测试的错误码映射为可读文案；未知码原样透传(便于排障)。
function friendlyTestError(error: string | undefined, locale: string): string {
  const zh = locale === 'zh-CN';
  if (error?.startsWith('custom_header_protected:')) {
    const name = error.slice('custom_header_protected:'.length);
    return zh
      ? `${name} 由渠道鉴权统一管理，不能放在自定义 Header`
      : `${name} is managed by channel auth and cannot be set as a custom header`;
  }
  if (error?.startsWith('oauth_port_in_use:')) {
    const port = error.slice('oauth_port_in_use:'.length);
    return zh
      ? `本地登录回调端口 ${port} 被占用，请关闭可能占用该端口的程序（或上一次未完成的登录窗口）后重试`
      : `Local login callback port ${port} is in use. Close the program occupying it (or a leftover login window) and try again`;
  }
  switch (error) {
    case 'oauth_not_logged_in':
      return zh ? '未登录，请先完成 OAuth 登录' : 'Not logged in — please complete OAuth login';
    case 'oauth_session_expired':
      return zh ? '登录已过期，请重新登录' : 'Session expired — please re-login';
    case 'oauth_google_client_id_required':
      return zh ? '请填写 Google OAuth Client ID' : 'Please enter the Google OAuth Client ID';
    case 'oauth_google_client_secret_required':
      return zh ? '请填写 Google OAuth Client Secret' : 'Please enter the Google OAuth Client Secret';
    case 'oauth_google_project_required':
      return zh ? '请填写 Google Cloud Project ID' : 'Please enter the Google Cloud Project ID';
    case 'API key not configured':
      return zh ? '未配置 API Key' : 'API key not configured';
    case 'api_key_required':
      return zh ? '请填写 API Key' : 'Please enter an API key';
    case 'qoder_auth_not_found':
      return zh ? '未找到本机 Qoder 登录态，请先完成 Qoder 登录' : 'Local Qoder auth was not found. Please sign in to Qoder first';
    case 'qoder_auth_expired':
      return zh ? '本机 Qoder 登录态已过期，请重新登录 Qoder' : 'Local Qoder auth has expired. Please sign in to Qoder again';
    case 'qoder_auth_unavailable':
      return zh ? '无法读取本机 Qoder 登录态' : 'Unable to read local Qoder auth';
    case 'qoder_private_empty_response':
      return zh ? 'Qoder 私有接口未返回内容' : 'Qoder private API returned an empty response';
    case 'base_url_required':
      return zh ? '请填写 Base URL' : 'Please enter a Base URL';
    case 'model_required':
      return zh ? '请填写模型名称' : 'Please enter a model name';
    case 'custom_header_invalid_line':
      return zh ? '自定义 Header 应按 Name: value 每行填写一条' : 'Custom headers must be one Name: value pair per line';
    case 'reasoning_effort_map_invalid':
      return zh ? '思考强度映射应填写 JSON 对象，或每行一条 level: value' : 'Reasoning effort map must be a JSON object or one level: value pair per line';
    case 'number_field_invalid':
      return zh ? '数字字段必须是大于等于 0 的数值' : 'Number fields must be non-negative values';
    case 'unknown_channel':
      return zh ? '未知渠道，请重新选择' : 'Unknown channel. Please choose again';
    case 'unsupported_wire':
      return zh ? '该渠道不支持所选 Wire 协议' : 'This channel does not support the selected wire protocol';
    case 'unsupported_auth_method':
      return zh ? '该渠道不支持所选鉴权方式' : 'This channel does not support the selected auth method';
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
  const [channels, setChannels] = useState<readonly LlmChannelDescriptor[]>(FALLBACK_CHANNELS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmProviderTestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  // ADR 28(方案 B): 订阅 provider 的模型清单与加载态(按 provider id 维度)。
  const [modelLists, setModelLists] = useState<Record<string, readonly LlmModelInfo[]>>({});
  const [modelLoadingId, setModelLoadingId] = useState<string | null>(null);
  // B-2 手风琴：给某个 provider 组「加模型」的模式(非 null 表示当前是加模型而非新建 provider)。
  const [addModelGroupId, setAddModelGroupId] = useState<string | null>(null);
  // B-2 手风琴：已折叠的组 groupId 集合(默认全部展开)。
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [removingGroupId, setRemovingGroupId] = useState<string | null>(null);

  const clearTestResult = useCallback((id: string) => {
    setTestResults((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await clientApi.llmListProviders();
      setProviders(list);
      setTestResults((prev) => {
        let next: Record<string, LlmProviderTestResult> | null = null;
        for (const provider of list) {
          if (!isOAuthMethod(provider.authMethod) || provider.oauthStatus?.status !== 'connected' || !prev[provider.id]) continue;
          next ??= { ...prev };
          delete next[provider.id];
        }
        return next ?? prev;
      });
    } catch { /* silent */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void clientApi.llmListChannels()
      .then((list) => {
        if (!cancelled && list.length) setChannels(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 拉取 provider 的可用模型: OAuth 走远程/内置目录,Qoder 走本机 catalog。
  const loadModels = useCallback(async (id: string) => {
    setModelLoadingId(id);
    try {
      const res = await clientApi.llmListModels({ id });
      if (res.success) {
        setModelLists((prev) => ({ ...prev, [id]: res.models }));
        const provider = providers.find((item) => item.id === id);
        const selected = res.models.find((item) => item.id === provider?.model);
        const patch = modelMetadataPatch(selected);
        const shouldPatch = provider && Object.entries(patch).some(([key, value]) => (provider as unknown as Record<string, unknown>)[key] !== value);
        if (shouldPatch) {
          await clientApi.llmUpdateProvider({ id, ...patch });
          await refresh();
        }
      }
    } catch { /* silent */ } finally {
      setModelLoadingId((cur) => (cur === id ? null : cur));
    }
  }, [providers, refresh]);

  // 已登录(connected)的订阅 provider 与本机 Qoder provider 自动加载一次模型清单。
  useEffect(() => {
    for (const p of providers) {
      const shouldLoad = (isOAuthMethod(p.authMethod) && p.oauthStatus?.status === 'connected')
        || isLocalCliMethod(p.authMethod);
      if (shouldLoad && !modelLists[p.id]) {
        void loadModels(p.id);
      }
    }
  }, [providers, modelLists, loadModels]);

  // 切换订阅 provider 当前使用的模型。
  const handleSelectModel = async (id: string, model: string) => {
    try {
      const selected = modelLists[id]?.find((item) => item.id === model);
      await clientApi.llmUpdateProvider({ id, model, ...modelMetadataPatch(selected) });
      await refresh();
    } catch { /* silent */ }
  };

  const handleChannelChange = (channelId: string) => {
    const channel = descriptorFor(channelId, channels);
    setForm((prev) => ({
      ...prev,
      channelId: channel.id,
      provider: channel.legacyProvider,
      wireOverride: '',
      authMethod: channel.authMethods?.[prev.authMethod] ? prev.authMethod : defaultAuthMethod(channel),
      baseUrl: channel.defaults.baseUrl,
      model: channel.defaults.model,
      supportsVision: channel.capabilities?.vision ?? false,
      supportsReasoning: channel.capabilities?.reasoning?.supported ?? false,
      supportsPromptCaching: channel.capabilities?.promptCache ?? false,
      reasoningParamStyle: channel.capabilities?.reasoning?.paramStyle ?? '',
      reasoningEffortMapText: '',
      customHeadersText: '',
    }));
  };

  const openAdd = () => {
    setEditingId(null);
    setAddModelGroupId(null);
    setForm(emptyForm(channels));
    setShowForm(true);
  };

  // B-2 给某个已有 provider 组「加模型」：预填该组的凭证/协议字段(只读展示用),
  // 只让用户填模型名与模型级参数;apiKey 留空(继承组内首条)。
  const openAddModel = (group: LlmProviderConfigView) => {
    setEditingId(null);
    setAddModelGroupId(group.groupId ?? group.id);
    const channel = descriptorFor(group.channelId || (group.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'), channels);
    setForm({
      ...emptyForm(channels, group.channelId || channel.id),
      provider: group.provider,
      channelId: group.channelId || channel.id,
      wireOverride: group.wireOverride ?? '',
      authMethod: group.authMethod ?? 'api_key',
      baseUrl: group.baseUrl,
      name: group.name,
      model: '',
      apiKey: '',
    });
    setShowForm(true);
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const openEdit = (p: LlmProviderConfigView) => {
    setEditingId(p.id);
    setAddModelGroupId(null);
    const channel = descriptorFor(p.channelId || (p.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'), channels);
    setForm({
      provider: p.provider,
      channelId: p.channelId || channel.id,
      wireOverride: p.wireOverride ?? '',
      reasoningParamStyle: p.reasoningParamStyle ?? channel.capabilities?.reasoning?.paramStyle ?? '',
      reasoningEffortMapText: formatReasoningEffortMap(p.reasoningEffortMap),
      customHeadersText: formatCustomHeaders(p.customHeaders),
      authMethod: p.authMethod ?? 'api_key',
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      oauthClientId: p.oauthClientId ?? '',
      oauthClientSecret: '',
      oauthProjectId: p.oauthProjectId ?? '',
      contextWindow: p.contextWindow ? String(p.contextWindow) : '',
      maxOutputTokens: p.maxOutputTokens ? String(p.maxOutputTokens) : '',
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
    setFormError(null);
    try {
      const localCli = isLocalCliMethod(form.authMethod);
      const customHeaders = localCli ? undefined : parseCustomHeaders(form.customHeadersText);
      const reasoningEffortMap = !localCli && form.supportsReasoning ? parseReasoningEffortMap(form.reasoningEffortMapText) : undefined;
      const ctxWin = form.contextWindow ? Number(form.contextWindow) : undefined;
      const maxOut = form.maxOutputTokens ? Number(form.maxOutputTokens) : undefined;
      const inPrice = form.inputPrice ? Number(form.inputPrice) : undefined;
      const outPrice = form.outputPrice ? Number(form.outputPrice) : undefined;
      const cwPrice = form.cacheWritePrice ? Number(form.cacheWritePrice) : undefined;
      const crPrice = form.cacheReadPrice ? Number(form.cacheReadPrice) : undefined;
      if (editingId) {
        const patch: Record<string, unknown> = {
          id: editingId,
          provider: form.provider,
          channelId: form.channelId,
          wireOverride: form.wireOverride || undefined,
          reasoningParamStyle: form.reasoningParamStyle || undefined,
          reasoningEffortMap,
          customHeaders,
          name: form.name,
          baseUrl: form.baseUrl,
          model: form.model,
          oauthClientId: form.oauthClientId,
          oauthClientSecret: form.oauthClientSecret || undefined,
          oauthProjectId: form.oauthProjectId,
          contextWindow: ctxWin,
          maxOutputTokens: maxOut,
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
          channelId: form.channelId,
          wireOverride: form.wireOverride || undefined,
          reasoningParamStyle: form.reasoningParamStyle || undefined,
          reasoningEffortMap,
          customHeaders,
          authMethod: form.authMethod,
          name: form.name || (localCli ? 'Qoder 私有接口' : form.provider),
          baseUrl: form.baseUrl,
          model: form.model,
          apiKey: form.apiKey,
          oauthClientId: form.oauthClientId,
          oauthClientSecret: form.oauthClientSecret,
          oauthProjectId: form.oauthProjectId,
          contextWindow: ctxWin,
          maxOutputTokens: maxOut,
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
        if (isOAuthMethod(form.authMethod)) {
          await handleOAuthLogin({ draft });
          return;
        }
        if (addModelGroupId) {
          // B-2 组内加模型:凭证继承自组内首条,apiKey 由 main 复用,无需重填。
          await clientApi.llmAddModel({ groupId: addModelGroupId, ...draft });
        } else {
          await clientApi.llmAddProvider(draft);
        }
      }
      setShowForm(false);
      setEditingId(null);
      setAddModelGroupId(null);
      await refresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await clientApi.llmRemoveProvider({ id });
    if (editingId === id) { setShowForm(false); setEditingId(null); }
    await refresh();
  };

  // B-2 删除整个 provider 组(该 provider 及其下全部模型)。
  const handleRemoveGroup = async (groupId: string) => {
    setRemovingGroupId(groupId);
    try {
      await clientApi.llmRemoveGroup({ groupId });
      if (showForm) { setShowForm(false); setEditingId(null); setAddModelGroupId(null); }
      await refresh();
    } finally {
      setRemovingGroupId(null);
    }
  };

  // 复制一个非订阅 provider，副本由 main 进程生成（新 id、名称追加「副本」/「(Copy)」、密钥一并复制）。
  const handleDuplicate = async (id: string) => {
    setDuplicatingId(id);
    try {
      await clientApi.llmDuplicateProvider({ id });
      await refresh();
    } catch (err: unknown) {
      setTestResults((prev) => ({ ...prev, [id]: { success: false, error: err instanceof Error ? err.message : 'Duplicate failed' } }));
    } finally {
      setDuplicatingId(null);
    }
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
      clearTestResult(busyKey);
      setShowForm(false);
      setEditingId(null);
      await refresh();
    } catch (err: unknown) {
      setTestResults((prev) => ({ ...prev, [busyKey]: { success: false, error: err instanceof Error ? err.message : 'Login failed' } }));
    } finally {
      setOauthBusyId(null);
    }
  };

  const selectedChannel = descriptorFor(form.channelId, channels);
  const oauthMethods = (['oauth_chatgpt', 'oauth_google'] as const)
    .filter((method) => Boolean(selectedChannel.authMethods?.[method]));
  const canUseOAuth = oauthMethods.length > 0;
  const canChooseWire = !isOAuthMethod(form.authMethod) && selectedChannel.allowedWires.length > 1;
  const isAddModel = Boolean(addModelGroupId);
  const isLocalCliAuth = isLocalCliMethod(form.authMethod);
  const formValidationError = validateForm(form, editingId, selectedChannel, isAddModel);
  const canSubmit = !saving && !oauthBusyId;
  // B-2 手风琴：把打平的 provider×model 列表按 groupId 归组，保持原有顺序。
  // 每组的首条记录承载 provider 级展示信息(名称/凭证/协议)，其 models 为该组全部记录。
  const groups: { groupId: string; head: LlmProviderConfigView; models: readonly LlmProviderConfigView[] }[] = (() => {
    const order: string[] = [];
    const byGroup = new Map<string, LlmProviderConfigView[]>();
    for (const p of providers) {
      const gid = p.groupId ?? p.id;
      if (!byGroup.has(gid)) { byGroup.set(gid, []); order.push(gid); }
      byGroup.get(gid)!.push(p);
    }
    return order.map((gid) => {
      const models = byGroup.get(gid)!;
      return { groupId: gid, head: models[0], models };
    });
  })();
  const reasoningStyles: readonly LlmReasoningParamStyle[] = selectedChannel.legacyProvider === 'anthropic'
    ? ['anthropic-enabled-budget', 'anthropic-adaptive-effort', 'anthropic-output-effort', 'none']
    : ['openai-effort', 'qwen-enable', 'none'];

  return (
    <div className="llm-settings-panel">
      {onBack ? (
        <header className="llm-settings-header">
          <button type="button" onClick={onBack} aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
          </button>
          <strong>{i18n.locale === 'zh-CN' ? '模型配置' : 'Model Settings'}</strong>
        </header>
      ) : null}

      <div className="llm-list-toolbar">
        <div className="llm-list-summary">
          <strong>{i18n.locale === 'zh-CN' ? '渠道' : 'Channels'}</strong>
          <span>{providers.length} {i18n.locale === 'zh-CN' ? '个渠道' : 'channels'} · {providers.length === 1 ? groups[0]?.models.length ?? 0 : groups.reduce((sum, group) => sum + group.models.length, 0)} {i18n.locale === 'zh-CN' ? '个模型' : 'models'}</span>
        </div>
        <button type="button" className="llm-add-channel-btn" onClick={openAdd}>
          ＋ {i18n.locale === 'zh-CN' ? '添加渠道' : 'Add Channel'}
        </button>
      </div>

      <div className="llm-provider-list">
        {providers.length === 0 ? (
          <div className="llm-empty">
            <p>{i18n.locale === 'zh-CN' ? '尚未配置任何模型渠道。' : 'No model channels configured.'}</p>
            <button type="button" onClick={openAdd}>
              ＋ {i18n.locale === 'zh-CN' ? '添加渠道' : 'Add Channel'}
            </button>
          </div>
        ) : groups.map((g) => {
          const head = g.head;
          const collapsed = collapsedGroups.has(g.groupId);
          const groupChannel = descriptorFor(head.channelId || (head.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'), channels);
          return (
          <div key={g.groupId} className="llm-provider-group">
            <div className="llm-group-header">
              <button type="button" className="llm-group-toggle" onClick={() => toggleGroup(g.groupId)} aria-expanded={!collapsed}>
                <svg
                  className={`llm-group-caret ${collapsed ? 'is-collapsed' : ''}`}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                <strong>{head.name || head.provider}</strong>
                <span className="llm-group-count">{g.models.length} {i18n.locale === 'zh-CN' ? '个模型' : 'models'}</span>
              </button>
              <span className="llm-provider-meta">
                <span className="llm-provider-chip">{groupChannel.label}</span>
                <span className="llm-provider-chip">{wireLabel(head.resolvedWire || groupChannel.defaultWire, i18n.locale)}</span>
              </span>
              {isLocalCliMethod(head.authMethod) ? (
                <small className="llm-provider-key">
                  {i18n.locale === 'zh-CN' ? '本机 Qoder 登录态' : 'Local Qoder Auth'}
                </small>
              ) : isOAuthMethod(head.authMethod) ? (
                <small className={`llm-provider-key llm-oauth-status-${head.oauthStatus?.status ?? 'disconnected'}`}>
                  {head.oauthStatus?.status === 'connected'
                    ? (i18n.locale === 'zh-CN' ? `已登录${head.oauthStatus.accountId ? ` · ${head.oauthStatus.accountId}` : ''}` : `Signed in${head.oauthStatus.accountId ? ` · ${head.oauthStatus.accountId}` : ''}`)
                    : head.oauthStatus?.status === 'expired'
                      ? (i18n.locale === 'zh-CN' ? '⚠ 登录已过期，请点击“重新登录”' : '⚠ Session expired — click “Re-login”')
                      : (i18n.locale === 'zh-CN' ? '未登录' : 'Not logged in')}
                </small>
              ) : (
                <small className="llm-provider-key">
                  {head.apiKeyConfigured ? `Key: ${head.apiKeyMasked}` : (i18n.locale === 'zh-CN' ? '未配置 Key' : 'Key not set')}
                </small>
              )}
              <div className="llm-group-actions">
                <button type="button" onClick={() => openAddModel(head)}>
                  {i18n.locale === 'zh-CN' ? '+ 加模型' : '+ Add model'}
                </button>
                {isOAuthMethod(head.authMethod) && head.oauthStatus?.status !== 'connected' ? (
                  <button type="button" className="primary" onClick={() => void handleOAuthLogin({ id: head.id })} disabled={oauthBusyId === head.id}>
                    {oauthBusyId === head.id ? '...' : (i18n.locale === 'zh-CN' ? '重新登录' : 'Re-login')}
                  </button>
                ) : null}
                <button type="button" className="danger" onClick={() => handleRemoveGroup(g.groupId)} disabled={removingGroupId === g.groupId}>
                  {removingGroupId === g.groupId ? '...' : (i18n.locale === 'zh-CN' ? '删除组' : 'Remove group')}
                </button>
              </div>
            </div>
            {!collapsed ? (
              <div className="llm-group-models">
                {g.models.map((p) => {
                  const canSelectModel = (isOAuthMethod(p.authMethod) && p.oauthStatus?.status === 'connected') || isLocalCliMethod(p.authMethod);
                  const modelOptions = (modelLists[p.id] && modelLists[p.id].length > 0
                    ? modelLists[p.id]
                    : [{ id: p.model, label: p.modelLabel || p.model } as LlmModelInfo]
                  ).map((m) => ({ value: m.id, label: m.label }));
                  const selectedModelMetadata = modelLists[p.id]?.find((item) => item.id === p.model);
                  const modelDisplayName = p.modelLabel || p.model;
                  return (
                  <div key={p.id} className={`llm-model-row ${p.isDefault ? 'is-default' : ''}`}>
                    <div className="llm-model-row-info">
                      {canSelectModel ? (
                        <Dropdown
                          className="llm-model-picker"
                          value={p.model}
                          disabled={modelLoadingId === p.id && !modelLists[p.id]}
                          ariaLabel={i18n.locale === 'zh-CN' ? '选择模型' : 'Select model'}
                          placeholder={
                            modelLoadingId === p.id && !modelLists[p.id]
                              ? (i18n.locale === 'zh-CN' ? '加载中…' : 'Loading…')
                              : modelDisplayName
                          }
                          options={modelOptions}
                          onChange={(value) => void handleSelectModel(p.id, value)}
                        />
                      ) : (
                        <span className="llm-provider-chip mono" title={p.model}>{modelDisplayName}</span>
                      )}
                      {p.isDefault ? <span className="llm-badge-default">{i18n.locale === 'zh-CN' ? '已激活' : 'Active'}</span> : null}
                      {selectedModelMetadata?.contextWindow || p.contextWindow || selectedModelMetadata?.maxOutputTokens || p.maxOutputTokens || p.inputPrice != null ? (
                        <span className="llm-provider-specs">
                          {selectedModelMetadata?.contextWindow || p.contextWindow ? `${formatModelTokenLimit(selectedModelMetadata?.contextWindow ?? p.contextWindow ?? 0)} ctx` : ''}
                          {(selectedModelMetadata?.contextWindow || p.contextWindow) && (selectedModelMetadata?.maxOutputTokens || p.maxOutputTokens) ? ' · ' : ''}
                          {selectedModelMetadata?.maxOutputTokens || p.maxOutputTokens ? `${formatModelTokenLimit(selectedModelMetadata?.maxOutputTokens ?? p.maxOutputTokens ?? 0)} out` : ''}
                          {((selectedModelMetadata?.contextWindow || p.contextWindow) || (selectedModelMetadata?.maxOutputTokens || p.maxOutputTokens)) && p.inputPrice != null ? ' · ' : ''}
                          {p.inputPrice != null ? `$${p.inputPrice}/${p.outputPrice ?? '?'}` : ''}
                        </span>
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
                        (() => {
                          const oauthNotConnected = isOAuthMethod(p.authMethod) && p.oauthStatus?.status !== 'connected';
                          return (
                            <button
                              type="button"
                              onClick={() => handleSetDefault(p.id)}
                              disabled={oauthNotConnected}
                              title={oauthNotConnected ? (i18n.locale === 'zh-CN' ? '会话已过期，请先重新登录' : 'Session expired — please re-login first') : undefined}
                            >
                              {i18n.locale === 'zh-CN' ? '激活' : 'Activate'}
                            </button>
                          );
                        })()
                      ) : null}
                      <button type="button" onClick={() => handleTest(p.id)} disabled={testingId === p.id}>
                        {testingId === p.id ? '...' : (i18n.locale === 'zh-CN' ? '测试' : 'Test')}
                      </button>
                      {!isOAuthMethod(p.authMethod) ? (
                        <button type="button" onClick={() => handleDuplicate(p.id)} disabled={duplicatingId === p.id}>
                          {duplicatingId === p.id ? '...' : (i18n.locale === 'zh-CN' ? '复制' : 'Duplicate')}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => openEdit(p)}>
                        {i18n.locale === 'zh-CN' ? '编辑' : 'Edit'}
                      </button>
                      <button type="button" className="danger" onClick={() => handleDelete(p.id)}>
                        {i18n.locale === 'zh-CN' ? '删除' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          );
        })}
      </div>

      {showForm ? (
        <Drawer
          onClose={() => { setShowForm(false); setEditingId(null); }}
          closeOnBackdrop={!saving && !oauthBusyId}
          ariaLabel={editingId
            ? (i18n.locale === 'zh-CN' ? '编辑模型' : 'Edit Model')
            : isAddModel
              ? (i18n.locale === 'zh-CN' ? '添加模型' : 'Add Model')
              : (i18n.locale === 'zh-CN' ? '添加渠道' : 'Add Channel')}
          panelClassName="llm-drawer"
          softBackdrop
        >
          {({ requestClose }) => (
          <>
            <header className="llm-modal-header">
              <h3>{editingId
                ? (i18n.locale === 'zh-CN' ? '编辑模型' : 'Edit Model')
                : isAddModel
                  ? (i18n.locale === 'zh-CN' ? `给 ${form.name} 加模型` : `Add model to ${form.name}`)
                  : (i18n.locale === 'zh-CN' ? '添加渠道' : 'Add Channel')}</h3>
              <button
                type="button"
                className="llm-modal-close"
                aria-label={i18n.locale === 'zh-CN' ? '关闭' : 'Close'}
                onClick={requestClose}
              >
                ✕
              </button>
            </header>
            <div className="llm-form llm-modal-body">

          {!isAddModel && (
          <>
          <label>
            <span>{i18n.locale === 'zh-CN' ? '渠道' : 'Channel'}</span>
            <Dropdown
              value={form.channelId}
              ariaLabel={i18n.locale === 'zh-CN' ? '选择渠道' : 'Select channel'}
              options={channels.map((channel) => ({
                value: channel.id,
                label: channel.label || channel.id,
              }))}
              onChange={handleChannelChange}
            />
          </label>

          {canUseOAuth && !editingId ? (
            <label>
              <span>{i18n.locale === 'zh-CN' ? '鉴权方式' : 'Auth Method'}</span>
              <div className="llm-radio-group">
                <label>
                  <input type="radio" checked={form.authMethod === 'api_key'} onChange={() => setForm((prev) => ({ ...prev, authMethod: 'api_key' }))} />
                  API Key
                </label>
                {oauthMethods.map((method) => (
                  <label key={method}>
                    <input
                      type="radio"
                      checked={form.authMethod === method}
                      onChange={() => setForm((prev) => ({ ...prev, authMethod: method, wireOverride: '' }))}
                    />
                    {oauthLabel(method, i18n.locale)}
                  </label>
                ))}
              </div>
            </label>
          ) : null}

          {canChooseWire ? (
            <label>
              <span>{i18n.locale === 'zh-CN' ? 'Wire 协议' : 'Wire Protocol'}</span>
              <Dropdown
                value={form.wireOverride || selectedChannel.defaultWire}
                ariaLabel={i18n.locale === 'zh-CN' ? '选择 Wire 协议' : 'Select wire protocol'}
                options={selectedChannel.allowedWires.map((wire) => ({ value: wire, label: wireLabel(wire, i18n.locale) }))}
                onChange={(wire) => setForm((prev) => ({
                  ...prev,
                  wireOverride: wire === selectedChannel.defaultWire ? '' : wire as LlmWireProtocol,
                }))}
              />
            </label>
          ) : null}

          {/* ADR 28: 订阅(OAuth)模式下先登录、成功后才落盘。 */}
          {form.authMethod === 'oauth_chatgpt' ? (
            <label>
              <span>{i18n.locale === 'zh-CN' ? '登录' : 'Login'}</span>
              <p className="llm-oauth-hint">
                {i18n.locale === 'zh-CN'
                  ? '点击登录将打开浏览器完成 ChatGPT 订阅账号登录;登录成功后才会保存,登录失败或取消不会保存任何配置。登录后自动拉取可用模型(默认使用最新模型)。'
                  : 'Clicking login opens your browser to sign in with your ChatGPT subscription. The provider is saved only after a successful login — nothing is saved if login fails or is cancelled. Available models are fetched after login (latest selected by default).'}
              </p>
            </label>
          ) : form.authMethod === 'oauth_google' ? (
            <>
              <label>
                <span>Google OAuth Client ID</span>
                <input value={form.oauthClientId} onChange={(e) => setForm((prev) => ({ ...prev, oauthClientId: e.target.value }))} />
              </label>
              <label>
                <span>Google OAuth Client Secret</span>
                <input
                  type="password"
                  value={form.oauthClientSecret}
                  placeholder={editingId ? (i18n.locale === 'zh-CN' ? '留空则不修改' : 'Leave empty to keep') : ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, oauthClientSecret: e.target.value }))}
                />
              </label>
              <label>
                <span>Google Cloud Project ID</span>
                <input value={form.oauthProjectId} onChange={(e) => setForm((prev) => ({ ...prev, oauthProjectId: e.target.value }))} />
              </label>
              <label>
                <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                <input value={form.name} placeholder="Gemini OAuth" onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>
              <label>
                <span>Base URL</span>
                <input value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} />
              </label>
              <p className="llm-oauth-hint">
                {i18n.locale === 'zh-CN'
                  ? '使用 Google Cloud OAuth Desktop Client 登录 Gemini API；登录成功后才会保存配置。Project ID 会作为 x-goog-user-project 发送。'
                  : 'Uses a Google Cloud OAuth Desktop Client for the Gemini API. The provider is saved only after login; Project ID is sent as x-goog-user-project.'}
              </p>
            </>
          ) : isLocalCliAuth ? (
            <>
              <label>
                <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                <input value={form.name} placeholder="Qoder 私有接口" onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>
            </>
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
          </>
          )}

          {form.authMethod !== 'oauth_chatgpt' ? (
          <>
          <label>
            <span>{isLocalCliAuth ? (i18n.locale === 'zh-CN' ? 'Qoder 模型' : 'Qoder Model') : (i18n.locale === 'zh-CN' ? '模型名称' : 'Model')}</span>
            <input value={form.model} onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))} />
          </label>

          {!isLocalCliAuth ? (
          <>
          <div className="llm-token-row">
            <label>
              <span>{i18n.locale === 'zh-CN' ? '上下文窗口' : 'Context Window'}</span>
              <input type="number" value={form.contextWindow} placeholder={i18n.locale === 'zh-CN' ? '如 200000' : 'e.g. 200000'} onChange={(e) => setForm((prev) => ({ ...prev, contextWindow: e.target.value }))} />
            </label>
            <label>
              <span>{i18n.locale === 'zh-CN' ? '最大输出 tokens' : 'Max Output Tokens'}</span>
              <input type="number" value={form.maxOutputTokens} placeholder={i18n.locale === 'zh-CN' ? '如 8192' : 'e.g. 8192'} onChange={(e) => setForm((prev) => ({ ...prev, maxOutputTokens: e.target.value }))} />
            </label>
          </div>

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
              onChange={(e) => setForm((prev) => ({
                ...prev,
                supportsReasoning: e.target.checked,
                reasoningEffortMapText: e.target.checked ? prev.reasoningEffortMapText : '',
              }))}
            />
            <span>{i18n.locale === 'zh-CN' ? '支持原生推理参数（reasoning/thinking）' : 'Native reasoning/thinking parameters'}</span>
          </label>

          {form.supportsReasoning ? (
            <>
              <label>
                <span>{i18n.locale === 'zh-CN' ? '推理参数方言' : 'Reasoning Param Style'}</span>
                <Dropdown
                  value={form.reasoningParamStyle || selectedChannel.capabilities?.reasoning?.paramStyle || 'none'}
                  ariaLabel={i18n.locale === 'zh-CN' ? '选择推理参数方言' : 'Select reasoning parameter style'}
                  options={reasoningStyles.map((style) => ({ value: style, label: reasoningStyleLabel(style, i18n.locale) }))}
                  onChange={(style) => setForm((prev) => ({ ...prev, reasoningParamStyle: style as LlmReasoningParamStyle }))}
                />
              </label>

              <label>
                <span>{i18n.locale === 'zh-CN' ? '思考强度映射' : 'Reasoning Effort Map'}</span>
                <textarea
                  value={form.reasoningEffortMapText}
                  rows={4}
                  placeholder={'{\n  "minimal": "high",\n  "low": "high",\n  "medium": "high",\n  "high": "high",\n  "xhigh": "max"\n}'}
                  onChange={(e) => setForm((prev) => ({ ...prev, reasoningEffortMapText: e.target.value }))}
                />
                <small className="llm-field-hint">
                  {i18n.locale === 'zh-CN'
                    ? '可选。把统一思考档位映射成当前网关真正接受的值；default 会优先匹配 default，其次匹配 medium。'
                    : 'Optional. Maps Peer Agent effort levels to values accepted by this gateway; default checks default first, then medium.'}
                </small>
              </label>
            </>
          ) : null}

          <label className="llm-vision-toggle">
            <input
              type="checkbox"
              checked={form.supportsPromptCaching}
              onChange={(e) => setForm((prev) => ({ ...prev, supportsPromptCaching: e.target.checked }))}
            />
            <span>{i18n.locale === 'zh-CN' ? '启用 Prompt 缓存（仅当网关真正复用缓存时开启，否则纯增成本）' : 'Enable prompt caching (only if the gateway actually reuses cache; otherwise pure cost)'}</span>
          </label>

          <label>
            <span>{i18n.locale === 'zh-CN' ? '自定义 Header' : 'Custom Headers'}</span>
            <textarea
              value={form.customHeadersText}
              rows={3}
              placeholder={'X-Request-Source: peer-agent\nX-Gateway-Project: default'}
              onChange={(e) => setForm((prev) => ({ ...prev, customHeadersText: e.target.value }))}
            />
            <small className="llm-field-hint">
              {i18n.locale === 'zh-CN'
                ? '每行一条 Header。Authorization、x-api-key、Content-Type 等鉴权与协议 Header 由渠道接管。'
                : 'One header per line. Authorization, x-api-key, Content-Type, and protocol headers are managed by the channel.'}
            </small>
          </label>
          </>
          ) : null}
          </>
          ) : null}

          {formError ? <p className="llm-form-error">{friendlyTestError(formError, i18n.locale)}</p> : null}
            </div>
            <div className="llm-modal-footer">
            <button type="button" className="llm-modal-cancel" onClick={requestClose}>
              {i18n.locale === 'zh-CN' ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (formValidationError) {
                  setFormError(formValidationError);
                  return;
                }
                void handleSave();
              }}
              disabled={!canSubmit}
            >
              {saving || oauthBusyId
                ? '...'
                : (isOAuthMethod(form.authMethod) && !editingId
                    ? (i18n.locale === 'zh-CN' ? `登录 ${form.authMethod === 'oauth_google' ? 'Google' : 'ChatGPT'}` : `Login with ${form.authMethod === 'oauth_google' ? 'Google' : 'ChatGPT'}`)
                    : (i18n.locale === 'zh-CN' ? '保存' : 'Save'))}
            </button>
            </div>
          </>
          )}
        </Drawer>
      ) : null}
    </div>
  );
}
