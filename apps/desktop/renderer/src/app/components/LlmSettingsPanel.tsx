import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  LlmAuthMethod,
  LlmChannelDescriptor,
  LlmServiceTemplateDescriptor,
  LlmModelInfo,
  LlmModelListResult,
  LlmProviderConfigView,
  LlmProviderTestResult, LlmSubscriptionQuota,
  LlmProviderType,
  LlmReasoningParamStyle,
  LlmWireProtocol,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { getProviderDisplayName } from '../../chat/state/providerDisplay';
import { Switch } from '../../ui/boolean-controls';
import { PeerIcon } from '../../ui/icons';
import { CascadingMenu, type CascadingMenuGroup } from './CascadingMenu';
import { ConfiguredModelRow } from './ConfiguredModelRow';
import { useConfirm } from './ConfirmProvider';
import { LlmBrandIcon } from './LlmBrandIcon';
import { Dropdown } from './Dropdown';
import { ModelCatalogDialog } from './ModelCatalogDialog';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { Overlay } from './Overlay';
import {
  buildModelImportPatches,
  calculateModelSelectionChanges,
  formatReasoningEffortMap,
  metadataSourceFromList,
  modelMetadataPatch,
  parseReasoningEffortMap,
} from './llmModelConfiguration';
import {
  availableOAuthMethods,
  shouldOpenOAuthModelCatalog,
  subscriptionLoginLabel,
} from './llmSubscriptionAuth';
import {
  formatQuotaLine,
  isOAuthMethod,
  supportsSubscriptionQuotaMethod,
} from './llmSubscriptionQuota';

interface PendingProviderDraft extends Record<string, unknown> {
  readonly channelId: string;
  readonly wireOverride?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly customHeaders?: Record<string, string>;
  readonly name: string;
  readonly authMethod: LlmAuthMethod;
}

/** 表单打开来源：template 表示从服务目录卡片进入，应锁定渠道与鉴权。 */
type FormLockSource = 'manual' | 'template' | 'edit' | 'add-model';

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
    defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
    capabilities: { reasoning: { supported: false, paramStyle: 'none' }, promptCache: false, vision: true },
    authMethods: {
      api_key: { wire: 'gemini' },
      oauth_google: { wire: 'gemini' },
    },
  },
  {
    id: 'grok',
    label: 'Grok 官方',
    legacyProvider: 'openai',
    defaultWire: 'openai-responses',
    allowedWires: ['openai-responses'],
    defaults: { baseUrl: 'https://cli-chat-proxy.grok.com/v1', model: 'grok-4.5' },
    capabilities: { reasoning: { supported: true, paramStyle: 'openai-effort' }, promptCache: false, vision: true },
    authMethods: { oauth_grok: { wire: 'openai-responses' } },
  },
  {
    id: 'qoder',
    label: 'Qoder（本机 CLI）',
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
  'x-xai-token-auth',
  'x-grok-client-surface',
  'x-grok-client-version',
]);

function isLocalCliMethod(method: LlmAuthMethod): boolean {
  return method === 'qoder_local_auth' || method === 'local_cli';
}

type LocalCliDetectStepStatus = 'pending' | 'running' | 'passed' | 'failed';

interface LocalCliDetectStep {
  id: string;
  labelZh: string;
  labelEn: string;
  status: LocalCliDetectStepStatus;
  detail?: string;
}

function createLocalCliDetectSteps(): LocalCliDetectStep[] {
  return [
    { id: 'cli', labelZh: '查找本机 qodercli', labelEn: 'Locate local qodercli', status: 'pending' },
    { id: 'auth', labelZh: '读取登录态', labelEn: 'Read login state', status: 'pending' },
    { id: 'models', labelZh: '校验模型目录', labelEn: 'Validate model catalog', status: 'pending' },
    { id: 'connect', labelZh: '建立连接', labelEn: 'Create connection', status: 'pending' },
  ];
}

function localCliDetectStatusLabel(status: LocalCliDetectStepStatus, localeZh: boolean): string {
  if (status === 'running') return localeZh ? '检测中…' : 'Checking…';
  if (status === 'passed') return localeZh ? '通过' : 'Passed';
  if (status === 'failed') return localeZh ? '失败' : 'Failed';
  return localeZh ? '等待中' : 'Pending';
}

function friendlyLocalCliError(error: string | undefined, locale: string): string {
  const zh = locale === 'zh-CN' || locale.startsWith('zh');
  const raw = String(error || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return zh ? '检测失败，请确认本机已安装并登录 Qoder CLI。' : 'Detection failed. Install and sign in to Qoder CLI first.';
  }
  if (
    lower.includes('not found')
    || lower.includes('enoent')
    || lower.includes('command not found')
    || raw.includes('未找到')
    || (lower.includes('qodercli') && (lower.includes('missing') || lower.includes('install')))
  ) {
    if (raw.includes('登录') || lower.includes('login') || lower.includes('auth') || lower.includes('expired')) {
      return zh
        ? '未找到本机 Qoder 登录态，或登录已过期。请在终端重新登录 qodercli 后重试。'
        : 'Qoder login state is missing or expired. Sign in with qodercli in a terminal, then retry.';
    }
    return zh
      ? '未找到本机 Qoder CLI（qodercli）。请先安装并确保可在终端执行。'
      : 'Local Qoder CLI (qodercli) was not found. Install it and ensure it is available in your terminal.';
  }
  if (
    raw.includes('登录已过期')
    || raw.includes('未找到本机 Qoder 登录态')
    || lower.includes('login')
    || lower.includes('auth')
    || lower.includes('expired')
    || lower.includes('unauthorized')
  ) {
    return zh
      ? '未找到本机 Qoder 登录态，或登录已过期。请在终端重新登录 qodercli 后重试。'
      : 'Qoder login state is missing or expired. Sign in with qodercli in a terminal, then retry.';
  }
  if (raw.includes('模型') || lower.includes('model') || lower.includes('catalog')) {
    return zh
      ? '模型目录不可用。请确认 qodercli 已登录且本地缓存可用后重试。'
      : 'Model catalog is unavailable. Sign in with qodercli and retry once the local cache is ready.';
  }
  return friendlyTestError(raw, locale);
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
  if (method === 'oauth_grok') return zh ? 'Grok 官方登录' : 'Grok Official';
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
      return zh ? 'Qoder（本机 CLI）' : 'Qoder (local CLI)';
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
  existingApiKeyConfigured = false,
): string | null {
  if (!selectedChannel.id) return 'unknown_channel';
  if (isLocalCliMethod(form.authMethod)) {
    if (!selectedChannel.authMethods?.qoder_local_auth && !selectedChannel.authMethods?.local_cli) return 'unsupported_auth_method';
    if (!form.model.trim()) return 'model_required';
    return null;
  }
  if (isOAuthMethod(form.authMethod)) {
    if (!selectedChannel.authMethods?.[form.authMethod]) return 'unsupported_auth_method';
    if (form.authMethod === 'oauth_google' && !form.model.trim()) return 'model_required';
    return null;
  }
  if (!isAddModel && !form.baseUrl.trim()) return 'base_url_required';
  if (isAddModel && !form.model.trim()) return 'model_required';
  if (!isAddModel && !existingApiKeyConfigured && !form.apiKey.trim()) return 'api_key_required';
  try {
    parseCustomHeaders(form.customHeadersText);
    if (isAddModel && form.supportsReasoning) parseReasoningEffortMap(form.reasoningEffortMapText);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : 'custom_header_invalid_line';
  }
  if (isAddModel) {
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
    oauthProjectId: '',
    contextWindow: '',
    maxOutputTokens: '',
    inputPrice: '',
    outputPrice: '',
    cacheWritePrice: '',
    cacheReadPrice: '',
    supportsVision: channel.capabilities?.vision ?? false,
    supportsReasoning: channel.capabilities?.reasoning?.supported ?? false,
    supportsPromptCaching: channel.capabilities?.promptCache ?? true,
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
    case 'qoder_auth_wasm_not_found':
    case 'qoder_auth_wasm_missing':
      return zh
        ? '未找到本机 Qoder CLI（qodercli），无法获取模型目录。请安装/登录 Qoder CLI 后重试'
        : 'Local Qoder CLI (qodercli) was not found, so the model catalog cannot be loaded. Install/sign in to Qoder CLI and retry';
    case 'qoder_models_not_found':
      return zh
        ? '未能从 Qoder CLI 或本机缓存获取模型目录。请先登录 Qoder 并同步模型'
        : 'No Qoder model catalog was available from the CLI or local cache. Sign in to Qoder and sync models first';
    case 'qoder_models_unavailable':
    case 'qoder_encrypted_models_unavailable':
    case 'qoder_encrypted_models_empty':
    case 'qoder_models_empty':
      return zh
        ? 'Qoder 模型目录不可用。请确认已登录 Qoder CLI，或本机存在可用模型缓存'
        : 'The Qoder model catalog is unavailable. Ensure Qoder CLI is signed in or a usable local cache exists';
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


const ACCESS_CATEGORY_ORDER = [
  'oauth',
  'official_api',
  'cloud',
  'third_party',
  'local',
  'custom_compatible',
  'recommended',
] as const;

function accessCategoryLabel(category: string, zh: boolean): string {
  switch (category) {
    case 'oauth':
      return zh ? '授权登录' : 'Sign-in';
    case 'official_api':
      return zh ? '官方 API（直连）' : 'Official API';
    case 'cloud':
      return zh ? '云平台' : 'Cloud platforms';
    case 'third_party':
      return zh ? '第三方与套餐' : 'Third-party & plans';
    case 'local':
      return zh ? '本地服务' : 'Local services';
    case 'custom_compatible':
      return zh ? '自定义兼容' : 'Custom compatible';
    case 'recommended':
      return zh ? '推荐' : 'Recommended';
    default:
      return category;
  }
}

function supportTierLabel(tier: string, zh: boolean): string {
  switch (tier) {
    case 'native':
      return zh ? '原生适配' : 'Native';
    case 'verified':
      return zh ? '验证兼容' : 'Verified';
    case 'custom':
      return zh ? '自定义兼容' : 'Custom';
    case 'experimental':
      return zh ? '实验性' : 'Experimental';
    default:
      return tier;
  }
}

function connectionStatusLabel(
  provider: LlmProviderConfigView,
  zh: boolean,
): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (provider.connectionState === 'available') {
    return { text: zh ? '可用' : 'Available', tone: 'ok' };
  }
  if (provider.connectionState === 'partial') {
    return { text: zh ? '部分可用' : 'Partial', tone: 'warn' };
  }
  if (provider.connectionState === 'needs_attention') {
    return { text: zh ? '需要操作' : 'Needs attention', tone: 'warn' };
  }
  if (provider.connectionState === 'unavailable') {
    return { text: zh ? '不可用' : 'Unavailable', tone: 'bad' };
  }
  if (provider.connectionState === 'disabled') {
    return { text: zh ? '已停用' : 'Disabled', tone: 'muted' };
  }
  if (provider.connectionState === 'checking') {
    return { text: zh ? '检查中' : 'Checking', tone: 'muted' };
  }
  if (isOAuthMethod(provider.authMethod)) {
    if (provider.oauthStatus?.status === 'connected') {
      return { text: zh ? '已登录' : 'Signed in', tone: 'ok' };
    }
    if (provider.oauthStatus?.status === 'expired') {
      return { text: zh ? '登录已过期' : 'Session expired', tone: 'warn' };
    }
    return { text: zh ? '未登录' : 'Not signed in', tone: 'warn' };
  }
  if (provider.apiKeyConfigured) {
    return { text: zh ? '已配置' : 'Configured', tone: 'ok' };
  }
  return { text: zh ? '未配置' : 'Not configured', tone: 'muted' };
}

function accessMethodLabel(provider: LlmProviderConfigView, zh: boolean): string {
  if (isOAuthMethod(provider.authMethod)) return zh ? '授权登录' : 'Sign-in';
  if (provider.authMethod === 'qoder_local_auth' || provider.authMethod === 'local_cli') {
    return zh ? '本地 / 私有' : 'Local / private';
  }
  if ((provider.channelId || '').includes('compatible')) {
    return zh ? '自定义兼容' : 'Custom compatible';
  }
  return zh ? 'API Key' : 'API Key';
}

export function LlmSettingsPanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
}) {
  const confirm = useConfirm();
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [fallbackVisionProviderId, setFallbackVisionProviderId] = useState<string>('');
  const [fallbackVisionSaving, setFallbackVisionSaving] = useState(false);
  const [channels, setChannels] = useState<readonly LlmChannelDescriptor[]>(FALLBACK_CHANNELS);
  const [serviceTemplates, setServiceTemplates] = useState<readonly LlmServiceTemplateDescriptor[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogClosing, setCatalogClosing] = useState(false);
  const catalogCloseTimer = useRef<number | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  /** 控制是否允许在表单内切换渠道/鉴权：template 来源锁定。 */
  const [formLockSource, setFormLockSource] = useState<FormLockSource>('manual');
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmProviderTestResult>>({});
  const [quotaResults, setQuotaResults] = useState<Record<string, LlmSubscriptionQuota>>({});
  const [quotaLoadingId, setQuotaLoadingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState<{
    verificationUrl: string;
    userCode: string;
    expiresAt: string;
  } | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [addModelGroupId, setAddModelGroupId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [removingGroupId, setRemovingGroupId] = useState<string | null>(null);
  // 远程模型目录只作为候选，不直接替换已配置模型。
  const [catalogTargetId, setCatalogTargetId] = useState<string | null>(null);
  const [pendingProviderDraft, setPendingProviderDraft] = useState<PendingProviderDraft | null>(null);
  const [catalogResult, setCatalogResult] = useState<LlmModelListResult>({ success: true, models: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [modelSettingsId, setModelSettingsId] = useState<string | null>(null);
  const [localCliDetectSteps, setLocalCliDetectSteps] = useState<LocalCliDetectStep[]>([]);
  const [highlightGroupId, setHighlightGroupId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

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
      const list = await clientApi.llmListProviderGroups();
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
      return list;
    } catch { /* silent */ }
    return [];
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const settings = (clientApi.initialSettings || {}) as Record<string, unknown>;
    const raw = settings.fallbackVision;
    if (typeof raw === 'string' && raw.trim()) {
      setFallbackVisionProviderId(raw.trim());
      return;
    }
    if (raw && typeof raw === 'object' && typeof (raw as { providerId?: unknown }).providerId === 'string') {
      setFallbackVisionProviderId(String((raw as { providerId: string }).providerId).trim());
    }
  }, []);

  // 与底部模型选择器一致：一级 provider（groupId），二级 vision 模型；未配 Key 的模型置灰。
  const fallbackVisionMenuGroups: readonly CascadingMenuGroup[] = useMemo(() => {
    const isZh = i18n.locale === 'zh-CN';
    // CascadingMenu 触发器展示「分组 · 模型」；「不使用」拆成两级文案，避免重复。
    const noneGroupLabel = isZh ? '不使用' : 'None';
    const noneItemLabel = isZh ? '仅剥离图片' : 'Strip images only';
    const order: string[] = [];
    const byGroup = new Map<string, { label: string; items: { id: string; label: string; disabled: boolean }[] }>();
    for (const prov of providers) {
      if (!prov.supportsVision) continue;
      const key = prov.groupId || prov.id;
      let bucket = byGroup.get(key);
      if (!bucket) {
        bucket = { label: getProviderDisplayName(prov, isZh), items: [] };
        byGroup.set(key, bucket);
        order.push(key);
      }
      bucket.items.push({
        id: prov.id,
        label: prov.modelLabel || prov.model,
        disabled: !prov.apiKeyConfigured,
      });
    }
    const providerGroups = order.map((key) => {
      const bucket = byGroup.get(key)!;
      return {
        id: key,
        label: bucket.label,
        items: bucket.items,
        disabled: bucket.items.every((it) => it.disabled),
      };
    });
    return [
      {
        id: '__none__',
        label: noneGroupLabel,
        items: [{ id: '__none__', label: noneItemLabel }],
      },
      ...providerGroups,
    ];
  }, [providers, i18n]);

  const handleFallbackVisionChange = async (nextId: string) => {
    const normalized = nextId === '__none__' ? '' : nextId;
    const previous = fallbackVisionProviderId;
    setFallbackVisionProviderId(normalized);
    setFallbackVisionSaving(true);
    try {
      await clientApi.updateSettings({
        fallbackVision: normalized ? { providerId: normalized } : null,
      });
    } catch {
      setFallbackVisionProviderId(previous);
    } finally {
      setFallbackVisionSaving(false);
    }
  };

  useEffect(() => clientApi.onLlmOAuthPending((pending) => {
    setOauthPending(pending);
  }), []);

  useEffect(() => clientApi.onLlmOAuthAuthorized(() => {
    setOauthPending(null);
  }), []);

  // 后台静默刷新真正更新凭证后，增量刷新渠道列表（不阻塞首屏）。
  useEffect(() => clientApi.onLlmOAuthRefreshed(() => {
    void refresh();
  }), [refresh]);

  useEffect(() => {
    let cancelled = false;
    void clientApi.llmListChannels()
      .then((list) => {
        if (!cancelled && list.length) setChannels(list);
      })
      .catch(() => {});
    void (clientApi as { llmListServiceTemplates?: () => Promise<readonly LlmServiceTemplateDescriptor[]> })
      .llmListServiceTemplates?.()
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length) setServiceTemplates(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 显式读取远程模型目录。目录结果只用于导入，不会自动替换或删除已配置模型。
  const loadCatalog = useCallback(async (id: string) => {
    setCatalogLoading(true);
    setCatalogResult({ success: true, models: [] });
    try {
      setCatalogResult(await clientApi.llmListModels({ id }));
    } catch (error: unknown) {
      setCatalogResult({ success: false, models: [], error: error instanceof Error ? error.message : 'models_list_failed' });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadPendingCatalog = useCallback(async (draft: PendingProviderDraft) => {
    setCatalogLoading(true);
    setCatalogResult({ success: true, models: [] });
    try {
      setCatalogResult(await clientApi.llmFetchModels({
        channelId: draft.channelId,
        wireOverride: draft.wireOverride,
        authMethod: draft.authMethod,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        customHeaders: draft.customHeaders,
      }));
    } catch (error: unknown) {
      setCatalogResult({ success: false, models: [], error: error instanceof Error ? error.message : 'models_list_failed' });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const openCatalog = (id: string) => {
    setPendingProviderDraft(null);
    setCatalogTargetId(id);
    void loadCatalog(id);
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
      supportsPromptCaching: channel.capabilities?.promptCache ?? true,
      reasoningParamStyle: channel.capabilities?.reasoning?.paramStyle ?? '',
      reasoningEffortMapText: '',
      customHeadersText: '',
    }));
  };

  const openAdd = () => {
    if (catalogCloseTimer.current !== null) {
      window.clearTimeout(catalogCloseTimer.current);
      catalogCloseTimer.current = null;
    }
    setCatalogQuery('');
    setCatalogClosing(false);
    setCatalogOpen(true);
  };

  const closeCatalog = () => {
    setCatalogClosing(true);
    if (catalogCloseTimer.current !== null) {
      window.clearTimeout(catalogCloseTimer.current);
    }
    catalogCloseTimer.current = window.setTimeout(() => {
      catalogCloseTimer.current = null;
      setCatalogOpen(false);
      setCatalogClosing(false);
    }, 170);
  };

  const clearLocalCliFlow = useCallback(() => {
    setLocalCliDetectSteps([]);
  }, []);

  const focusConnectedGroup = useCallback((groupId: string) => {
    setHighlightGroupId(groupId);
    if (highlightTimerRef.current != null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightGroupId((current) => (current === groupId ? null : current));
      highlightTimerRef.current = null;
    }, 3200);

    // 服务目录关闭有 170ms 动画，列表 DOM 要稍后才挂载；重试滚动到新建项。
    const tryScroll = (attempt: number) => {
      const el = document.querySelector(`[data-llm-group-id="${groupId}"]`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (attempt < 12) {
        window.setTimeout(() => tryScroll(attempt + 1), 50);
      }
    };
    window.requestAnimationFrame(() => tryScroll(0));
  }, []);

  useEffect(() => () => {
    if (highlightTimerRef.current != null) {
      window.clearTimeout(highlightTimerRef.current);
    }
  }, []);

  const openAddFromTemplate = (template: LlmServiceTemplateDescriptor) => {
    setEditingId(null);
    setAddModelGroupId(null);
    clearLocalCliFlow();
    // 保持服务目录在背景；仅打开配置 Modal，并锁定模板的渠道与鉴权。
    setFormLockSource('template');
    setShowAdvancedFields(false);
    const channel = descriptorFor(template.channelId, channels);
    const next = emptyForm(channels, template.channelId);
    setForm({
      ...next,
      provider: template.legacyProvider,
      channelId: template.channelId,
      authMethod: template.authMethod,
      wireOverride: '',
      baseUrl: template.defaults.baseUrl || channel.defaults.baseUrl,
      model: template.defaults.model || channel.defaults.model,
      name: template.title,
      supportsVision: channel.capabilities?.vision ?? false,
      supportsReasoning: channel.capabilities?.reasoning?.supported ?? false,
      supportsPromptCaching: channel.capabilities?.promptCache ?? true,
      reasoningParamStyle: channel.capabilities?.reasoning?.paramStyle ?? '',
    });
    setShowForm(true);
  };

  // B-2 给某个已有 provider 组「加模型」：预填该组的凭证/协议字段(只读展示用),
  // 只让用户填模型名与模型级参数;apiKey 留空(继承组内首条)。
  const openAddModel = (group: LlmProviderConfigView) => {
    setEditingId(null);
    setAddModelGroupId(group.groupId ?? group.id);
    setFormLockSource('add-model');
    setShowAdvancedFields(false);
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
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const openEdit = (p: LlmProviderConfigView) => {
    setEditingId(p.id);
    setAddModelGroupId(null);
    clearLocalCliFlow();
    setFormLockSource('edit');
    setShowAdvancedFields(false);
    const channel = descriptorFor(p.channelId || (p.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'), channels);
    setForm({
      provider: p.provider,
      channelId: p.channelId || channel.id,
      wireOverride: p.wireOverride ?? '',
      reasoningParamStyle: p.reasoningParamStyle ?? channel.capabilities?.reasoning?.paramStyle ?? '',
      reasoningEffortMapText: formatReasoningEffortMap(p.reasoningEffortMap),
      customHeadersText: formatCustomHeaders(p.customHeaders),
      // 保留历史订阅登录态（含 oauth_google），编辑时只改显示名称等连接元数据，
      // 不要强制降级成 api_key，否则会出现 Base URL / API Key 误校验。
      authMethod: p.authMethod ?? 'api_key',
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      oauthProjectId: p.oauthProjectId ?? '',
      contextWindow: p.contextWindow ? String(p.contextWindow) : '',
      maxOutputTokens: p.maxOutputTokens ? String(p.maxOutputTokens) : '',
      inputPrice: p.inputPrice != null ? String(p.inputPrice) : '',
      outputPrice: p.outputPrice != null ? String(p.outputPrice) : '',
      cacheWritePrice: p.cacheWritePrice != null ? String(p.cacheWritePrice) : '',
      cacheReadPrice: p.cacheReadPrice != null ? String(p.cacheReadPrice) : '',
      supportsVision: p.supportsVision ?? false,
      supportsReasoning: p.supportsReasoning ?? false,
      supportsPromptCaching: p.supportsPromptCaching ?? true,
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
        const edited = providers.find((provider) => provider.id === editingId);
        const groupId = edited?.groupId ?? editingId;
        const groupModels = providers.filter((provider) => (provider.groupId ?? provider.id) === groupId);
        const connectionPatch: Record<string, unknown> = {
          provider: form.provider,
          channelId: form.channelId,
          wireOverride: form.wireOverride || '',
          customHeaders: customHeaders ?? {},
          authMethod: form.authMethod,
          name: form.name,
          baseUrl: form.baseUrl,
          oauthProjectId: form.oauthProjectId,
        };
        for (const [index, model] of groupModels.entries()) {
          await clientApi.llmUpdateProvider({
            id: model.id,
            ...connectionPatch,
            ...(index === 0 && form.apiKey ? { apiKey: form.apiKey } : {}),
          });
        }
      } else {
        const draft = {
          provider: form.provider,
          channelId: form.channelId,
          wireOverride: form.wireOverride || undefined,
          customHeaders,
          authMethod: form.authMethod,
          name: form.name || (localCli
            ? 'Qoder（本机 CLI）'
            : form.authMethod === 'oauth_google'
              ? 'Gemini OAuth'
              : form.authMethod === 'oauth_grok'
                ? 'Grok 官方'
                : form.authMethod === 'oauth_chatgpt'
                  ? 'ChatGPT 订阅'
                  : selectedChannel?.label || form.provider),
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          oauthProjectId: form.oauthProjectId,
        } as PendingProviderDraft;
        if (addModelGroupId) {
          // 手动新增只写模型字段；连接信息与密钥由组内记录继承。
          await clientApi.llmAddModel({
            groupId: addModelGroupId,
            name: form.name,
            model: form.model,
            contextWindow: ctxWin,
            maxOutputTokens: maxOut,
            inputPrice: inPrice,
            outputPrice: outPrice,
            cacheWritePrice: cwPrice,
            cacheReadPrice: crPrice,
            supportsVision: form.supportsVision,
            supportsReasoning: form.supportsReasoning,
            supportsPromptCaching: form.supportsPromptCaching,
            reasoningParamStyle: form.reasoningParamStyle || undefined,
            reasoningEffortMap,
            metadataSource: 'manual',
            metadataSyncedAt: new Date().toISOString(),
          });
        } else if (isOAuthMethod(form.authMethod)) {
          // 订阅链路必须先登录、成功后才落盘；失败或取消不留空记录。
          await handleOAuthLogin({ draft });
          return;
        } else if (localCli) {
          // Qoder / 本机 CLI：检测 CLI + 登录态 + 模型目录后落盘，成功后直接回列表并高亮新建连接。
          const localeZh = i18n.locale === 'zh-CN';
          const steps = createLocalCliDetectSteps();
          const markStep = (id: string, status: LocalCliDetectStepStatus, detail?: string) => {
            const next = steps.map((step) => (
              step.id === id
                ? { ...step, status, detail: detail ?? step.detail }
                : step
            ));
            steps.splice(0, steps.length, ...next);
            setLocalCliDetectSteps([...steps]);
          };

          setLocalCliDetectSteps(steps.map((step) => ({ ...step })));
          markStep('cli', 'running');
          markStep('auth', 'pending');
          markStep('models', 'pending');
          markStep('connect', 'pending');

          let catalog: Awaited<ReturnType<typeof clientApi.llmFetchModels>>;
          try {
            catalog = await clientApi.llmFetchModels({
              channelId: draft.channelId,
              wireOverride: draft.wireOverride,
              authMethod: draft.authMethod,
              baseUrl: draft.baseUrl,
              apiKey: draft.apiKey,
              customHeaders: draft.customHeaders,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'models_list_failed';
            markStep('cli', 'failed', message);
            markStep('auth', 'failed');
            markStep('models', 'failed');
            throw new Error(message);
          }

          if (!catalog.success) {
            const message = catalog.error || 'models_list_failed';
            const lower = message.toLowerCase();
            const authFailed = (
              message.includes('登录')
              || lower.includes('login')
              || lower.includes('auth')
              || lower.includes('expired')
              || lower.includes('unauthorized')
            );
            const cliFailed = (
              lower.includes('not found')
              || lower.includes('enoent')
              || lower.includes('qodercli')
              || message.includes('未找到')
              || lower.includes('install')
            );
            if (cliFailed && !authFailed) {
              markStep('cli', 'failed', message);
              markStep('auth', 'pending');
              markStep('models', 'pending');
            } else if (authFailed) {
              markStep('cli', 'passed');
              markStep('auth', 'failed', message);
              markStep('models', 'pending');
            } else {
              markStep('cli', 'passed');
              markStep('auth', 'passed');
              markStep('models', 'failed', message);
            }
            throw new Error(message);
          }

          markStep('cli', 'passed');
          markStep('auth', 'passed');
          markStep('models', 'passed', localeZh
            ? `已发现 ${catalog.models.length} 个模型`
            : `Found ${catalog.models.length} models`);
          markStep('connect', 'running');

          const preferredModel = (
            form.model
            || catalog.models[0]?.id
            || selectedChannel?.defaults.model
            || 'auto'
          );
          const created = await clientApi.llmAddProvider({
            ...draft,
            model: preferredModel,
            modelLabel: catalog.models.find((item) => item.id === preferredModel)?.label,
          });
          markStep('connect', 'passed');
          await refresh();
          const connectedGroupId = created.groupId ?? created.id;
          setShowForm(false);
          setEditingId(null);
          setAddModelGroupId(null);
          setFormLockSource('manual');
          setShowAdvancedFields(false);
          clearLocalCliFlow();
          // 回到「已连接服务」列表，避免停在添加服务目录页可重复点添加
          closeCatalog();
          focusConnectedGroup(connectedGroupId);
          return;
        } else {
          setPendingProviderDraft(draft);
          setCatalogTargetId(null);
          setShowForm(false);
          await loadPendingCatalog(draft);
          return;
        }
      }
      setShowForm(false);
      setEditingId(null);
      setAddModelGroupId(null);
      clearLocalCliFlow();
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
    if (modelSettingsId === id) setModelSettingsId(null);
    await refresh();
  };

  // B-2 删除整个 provider 组(该 provider 及其下全部模型)。
  const handleRemoveGroup = async (groupId: string, groupLabel?: string) => {
    const zh = i18n.locale === 'zh-CN';
    const label = (groupLabel || groupId).trim() || groupId;
    const ok = await confirm({
      title: zh ? '删除渠道' : 'Remove provider',
      message: zh
        ? `确认删除渠道「${label}」及其全部模型？此操作不可撤销。`
        : `Delete provider “${label}” and all its models? This cannot be undone.`,
      confirmText: zh ? '删除' : 'Delete',
      cancelText: zh ? '取消' : 'Cancel',
      tone: 'danger',
    });
    if (!ok) return;

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

  // 同渠道复制一条模型：立刻落库，刷新后打开新副本的设置弹窗。
  const handleDuplicateModel = async (id: string) => {
    setDuplicatingId(id);
    try {
      const beforeIds = new Set(providers.map((p) => p.id));
      await clientApi.llmDuplicateModel({ id });
      const latest = await refresh();
      const created = (latest ?? []).find((p) => !beforeIds.has(p.id));
      if (created) setModelSettingsId(created.id);
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

  const handleImportModels = async (
    models: readonly LlmModelInfo[],
    sourceOverride?: Parameters<typeof buildModelImportPatches>[1],
  ): Promise<readonly LlmProviderConfigView[]> => {
    if (models.length === 0) return [];
    const source = sourceOverride ?? metadataSourceFromList(catalogResult);
    const patches = buildModelImportPatches(models, source);
    if (patches.length === 0) return [];

    if (pendingProviderDraft) {
      const [first, ...rest] = patches;
      if (!first) return [];
      let createdGroupId: string | null = null;
      try {
        const created = await clientApi.llmAddProvider({ ...pendingProviderDraft, ...first });
        createdGroupId = created.groupId ?? created.id;
        for (const patch of rest) {
          await clientApi.llmAddModel({ groupId: createdGroupId, name: created.name, ...patch });
        }
      } catch (error) {
        if (createdGroupId) {
          try { await clientApi.llmRemoveGroup({ groupId: createdGroupId }); } catch { /* keep original error */ }
        }
        await refresh();
        throw error;
      }
      const providersAfter = await refresh();
      // 新建渠道选完模型后，退出服务目录回到已连接列表
      closeCatalog();
      if (createdGroupId) focusConnectedGroup(createdGroupId);
      return providersAfter;
    }

    const target = providers.find((provider) => provider.id === catalogTargetId);
    if (!target) return [];
    const groupId = target.groupId ?? target.id;
    const configuredModels = providers.filter(
      (provider) => (provider.groupId ?? provider.id) === groupId,
    );
    const changes = calculateModelSelectionChanges(models, configuredModels);
    if (changes.additions.length === 0 && changes.removals.length === configuredModels.length) {
      throw new Error('provider_requires_at_least_one_model');
    }
    const additionPatches = buildModelImportPatches(changes.additions, source);
    try {
      for (const { configured, model } of changes.updates) {
        await clientApi.llmUpdateProvider({
          id: configured.id,
          ...modelMetadataPatch(model, source),
        });
      }
      for (const patch of additionPatches) {
        await clientApi.llmAddModel({ groupId, name: target.name, ...patch });
      }
      for (const removed of changes.removals) {
        await clientApi.llmRemoveProvider({ id: removed.id });
      }
    } catch (error) {
      await refresh();
      throw error;
    }
    const latest = await refresh();
    return latest.filter((provider) => (provider.groupId ?? provider.id) === groupId);
  };

  const handleSaveModelSettings = async (id: string, patch: Record<string, unknown>) => {
    await clientApi.llmUpdateProvider({ id, ...patch });
    await refresh();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await clientApi.llmTestConnection({ id });
      setTestResults((prev) => ({ ...prev, [id]: result }));
      // 诊断结果会写回 connectionState / lastDiagnostic，刷新列表以更新服务卡片状态。
      await refresh();
    } catch (err: unknown) {
      setTestResults((prev) => ({ ...prev, [id]: { success: false, error: err instanceof Error ? err.message : 'Test failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRefreshQuota = async (id: string, force = true) => {
    setQuotaLoadingId(id);
    try {
      const result = await clientApi.llmGetSubscriptionQuota({ id, force });
      setQuotaResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: unknown) {
      // 静默/手动刷新失败时保留上次成功结果，避免把已展示额度冲成错误态。
      setQuotaResults((prev) => {
        if (prev[id]?.success) return prev;
        return {
          ...prev,
          [id]: {
            success: false,
            status: 'fetch_failed',
            error: err instanceof Error ? err.message : 'Quota fetch failed',
            fetchedAt: new Date().toISOString(),
          },
        };
      });
    } finally {
      setQuotaLoadingId((current) => (current === id ? null : current));
    }
  };

  // 进入设置页：先 force=false 立刻拿到主进程上次成功/TTL 缓存，再 force=true 静默刷新。
  // 渠道维度：每个 OAuth 分组只刷 head，避免同凭证重复请求。
  useEffect(() => {
    let cancelled = false;
    const headIds: string[] = [];
    const seenGroup = new Set<string>();
    for (const provider of providers) {
      if (!supportsSubscriptionQuotaMethod(provider.authMethod)) continue;
      if (isOAuthMethod(provider.authMethod) && provider.oauthStatus?.status !== 'connected') continue;
      const groupId = provider.groupId || provider.id;
      if (seenGroup.has(groupId)) continue;
      seenGroup.add(groupId);
      const head = providers.find((p) => p.id === groupId) ?? provider;
      headIds.push(head.id);
    }
    void (async () => {
      for (const id of headIds) {
        if (cancelled) return;
        // 先展示缓存（含 TTL 过期后的上次成功结果）
        try {
          const cached = await clientApi.llmGetSubscriptionQuota({ id, force: false });
          if (cancelled) return;
          setQuotaResults((prev) => ({ ...prev, [id]: cached }));
        } catch {
          /* silent; 下方仍会 force 刷新 */
        }
        if (cancelled) return;
        // 再后台静默拉最新
        await handleRefreshQuota(id, true);
      }
    })();
    return () => { cancelled = true; };
    // 仅在 providers 列表身份变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.map((provider) => `${provider.id}:${provider.oauthStatus?.status ?? ''}`).join('|')]);

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
    setOauthPending(null);
    setFormError(null);
    try {
      const result = await clientApi.llmOAuthStart(target);
      if (!result.success) {
        setFormError(result.error);
        setTestResults((prev) => ({ ...prev, [busyKey]: { success: false, error: result.error } }));
        // 登录失败:保持表单打开,让用户可重试或取消。
        return;
      }
      clearTestResult(busyKey);
      if (shouldOpenOAuthModelCatalog(result.provider.model, result.models)) {
        setCatalogTargetId(result.provider.id);
        setCatalogResult({ success: true, models: result.models ?? [], source: 'builtin' });
      }
      setShowForm(false);
      setEditingId(null);
      setAddModelGroupId(null);
      setFormLockSource('manual');
      setShowAdvancedFields(false);
      await refresh();
      // 从服务目录进入的订阅登录成功后，回到已连接列表
      closeCatalog();
      focusConnectedGroup(result.provider.groupId ?? result.provider.id);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : 'Login failed';
      setFormError(error);
      setTestResults((prev) => ({ ...prev, [busyKey]: { success: false, error } }));
    } finally {
      setOauthPending(null);
      setOauthBusyId(null);
    }
  };

  const selectedChannel = descriptorFor(form.channelId, channels);
  const oauthMethods = availableOAuthMethods(selectedChannel);
  const canUseOAuth = oauthMethods.length > 0;
  const canChooseWire = !isOAuthMethod(form.authMethod) && selectedChannel.allowedWires.length > 1;
  const isAddModel = Boolean(addModelGroupId);
  const isLocalCliAuth = isLocalCliMethod(form.authMethod);
  /** 从服务目录卡片进入：锁定渠道与鉴权，不允许在 Modal 内二次选择。 */
  const templateLocked = formLockSource === 'template';
  const hideChannelPicker = templateLocked || formLockSource === 'edit' || formLockSource === 'add-model';
  const hideAuthPicker = templateLocked || formLockSource === 'edit' || formLockSource === 'add-model' || Boolean(editingId);
  const activeTemplate = templateLocked
    ? serviceTemplates.find((item) => item.channelId === form.channelId && item.authMethod === form.authMethod)
    : undefined;
  const hideBaseUrlByDefault = Boolean(
    (activeTemplate?.defaults as { hideBaseUrlByDefault?: boolean } | undefined)?.hideBaseUrlByDefault,
  );
  const collapseOfficialAdvanced = templateLocked && !isOAuthMethod(form.authMethod) && !isLocalCliAuth;
  const editingProvider = editingId ? providers.find((provider) => provider.id === editingId) : undefined;
  const formValidationError = validateForm(
    form,
    editingId,
    selectedChannel,
    isAddModel,
    editingProvider?.authMethod === 'api_key' && editingProvider.apiKeyConfigured,
  );
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
            <PeerIcon name="back" size={18} />
          </button>
          <strong>{i18n.locale === 'zh-CN' ? '服务商' : 'Providers'}</strong>
        </header>
      ) : null}

      <div className="llm-list-toolbar">
        <div className="llm-list-summary">
          <strong>{i18n.locale === 'zh-CN' ? '已连接服务' : 'Connected services'}</strong>
          <span>{groups.length} {i18n.locale === 'zh-CN' ? '个渠道' : 'channels'} · {groups.reduce((sum, group) => sum + group.models.length, 0)} {i18n.locale === 'zh-CN' ? '个模型' : 'models'}</span>
        </div>
        <button type="button" className="llm-add-channel-btn" onClick={openAdd}>
          <PeerIcon name="plus" size={14} />
          {i18n.locale === 'zh-CN' ? '添加服务' : 'Add service'}
        </button>
      </div>

      <section className="llm-fallback-vision" aria-label={i18n.t('settings.fallbackVision')}>
        <div className="llm-fallback-vision-copy">
          <strong>{i18n.t('settings.fallbackVision')}</strong>
          <p>{i18n.t('settings.fallbackVision.description')}</p>
        </div>
        <div className="llm-fallback-vision-select">
          <CascadingMenu
            className="llm-fallback-vision-menu"
            value={fallbackVisionProviderId || '__none__'}
            groups={fallbackVisionMenuGroups}
            onChange={(nextId) => { void handleFallbackVisionChange(nextId); }}
            disabled={fallbackVisionSaving}
            ariaLabel={i18n.t('settings.fallbackVision')}
            placeholder={i18n.t('settings.fallbackVision.none')}
            menuPlacement="down"
          />
        </div>
      </section>

            {catalogOpen ? (

        <div className={`llm-service-catalog${catalogClosing ? ' is-closing' : ''}`} role="dialog" aria-label={i18n.locale === 'zh-CN' ? '添加服务' : 'Add service'}>
          <div className="llm-service-catalog-header">
            <div>
              <strong>{i18n.locale === 'zh-CN' ? '添加服务' : 'Add service'}</strong>
              <p>
                {i18n.locale === 'zh-CN'
                  ? '通过订阅、API Key、第三方中转或本地模型接入新服务'
                  : 'Connect via subscription, API key, third-party gateway, or local models'}
              </p>
            </div>
            <button type="button" className="llm-catalog-back-btn" onClick={closeCatalog}>
              <PeerIcon name="back" size={14} />
              {i18n.locale === 'zh-CN' ? '返回' : 'Back'}
            </button>
            {/* Decorative back control is a linear <svg> via PeerIcon, not a character arrow. */}
          </div>
          <label className="llm-service-catalog-search">
            <span className="sr-only">{i18n.locale === 'zh-CN' ? '搜索服务' : 'Search services'}</span>
            <input
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
              placeholder={i18n.locale === 'zh-CN' ? '搜索服务、平台或接入方式' : 'Search services, platforms, or access methods'}
            />
          </label>
          {(() => {
            const zh = i18n.locale === 'zh-CN';
            const q = catalogQuery.trim().toLowerCase();
            const filtered = (serviceTemplates.length ? serviceTemplates : []).filter((template) => {
              if (!q) return true;
              const hay = [
                template.title,
                template.brand,
                template.description,
                template.accessCategory,
                template.supportTier,
                ...(template.searchAliases || []),
                ...(template.tags || []),
              ].join(' ').toLowerCase();
              return hay.includes(q);
            });
            if (!filtered.length) {
              return (
                <div className="llm-empty">
                  <p>{zh ? '没有匹配的服务模板' : 'No matching service templates'}</p>
                  <button
                    type="button"
                    className="llm-add-channel-btn"
                    onClick={() => openAddFromTemplate({
                      id: 'openai-compatible',
                      brand: 'OpenAI Compatible',
                      title: zh ? 'OpenAI 兼容' : 'OpenAI Compatible',
                      description: '',
                      accessCategory: 'custom_compatible',
                      supportTier: 'custom',
                      channelId: 'openai-compatible',
                      authMethod: 'api_key',
                      legacyProvider: 'openai',
                      defaultWire: 'openai-chat',
                      defaults: { baseUrl: '', model: 'gpt-4o' },
                    })}
                  >
                    {zh ? '添加自定义兼容服务' : 'Add custom compatible service'}
                  </button>
                </div>
              );
            }
            const groups = ACCESS_CATEGORY_ORDER
              .map((category) => ({
                category,
                items: filtered.filter((item) => item.accessCategory === category),
              }))
              .filter((group) => group.items.length > 0);
            return groups.map((group) => (
              <section key={group.category} className="llm-service-catalog-group">
                <h4>{accessCategoryLabel(group.category, zh)}</h4>
                <div className="llm-service-catalog-grid">
                  {group.items.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="llm-service-template-card"
                      onClick={() => openAddFromTemplate(template)}
                    >
                      <div className="llm-service-template-card-title">
                        <LlmBrandIcon brand={template.brand} channelId={template.channelId} serviceTemplateId={template.id} />
                        <strong>{template.title}</strong>
                        <span className="llm-service-tier">{supportTierLabel(template.supportTier, zh)}</span>
                      </div>
                      <p>{template.description}</p>
                      <span className="llm-service-template-meta">
                        {(template.tags && template.tags[0]) || accessCategoryLabel(template.accessCategory, zh)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ));
          })()}
        </div>
      ) : (
        <div className="llm-provider-list">
{providers.length === 0 ? (
          <div className="llm-empty">
            <p>{i18n.locale === 'zh-CN' ? '还没有连接 AI 服务。' : 'No AI services connected yet.'}</p>
            <button type="button" onClick={openAdd}>
              <PeerIcon name="plus" size={14} />
              {i18n.locale === 'zh-CN' ? '添加服务' : 'Add service'}
            </button>
          </div>
        ) : groups.map((g) => {
          const head = g.head;
          const collapsed = !expandedGroups.has(g.groupId);
          const groupChannel = descriptorFor(head.channelId || (head.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'), channels);
          return (
          <div key={g.groupId} data-llm-group-id={g.groupId} className={`llm-provider-group${highlightGroupId === g.groupId ? ' is-highlight' : ''}`}>
            <div className="llm-group-header">
              <div className="llm-group-header-main">
              <button type="button" className="llm-group-toggle" onClick={() => toggleGroup(g.groupId)} aria-expanded={!collapsed}>
                <LlmBrandIcon
                  channelId={head.channelId}
                  providerName={head.name}
                  serviceTemplateId={head.serviceTemplateId}
                />
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
                  {(() => {
                    const status = connectionStatusLabel(head, i18n.locale === 'zh-CN');
                    return (
                      <span className={`llm-connection-status tone-${status.tone}`} title={head.connectionStateReason || head.lastErrorCategory || ''}>
                        {status.text}
                        <span className="llm-connection-method"> · {accessMethodLabel(head, i18n.locale === 'zh-CN')}</span>
                        {head.apiKeyConfigured ? ` · ${head.apiKeyMasked || 'Key'}` : ''}
                      </span>
                    );
                  })()}
                </small>
              )}
              <div className="llm-group-actions">
                <button type="button" className="primary" onClick={() => openCatalog(head.id)}>
                  {i18n.locale === 'zh-CN' ? '获取模型列表' : 'Get models'}
                </button>
                {!isOAuthMethod(head.authMethod) ? (
                  <button type="button" onClick={() => openAddModel(head)}>
                    {i18n.locale === 'zh-CN' ? '手动新增' : 'Add manually'}
                  </button>
                ) : null}
                <button type="button" onClick={() => openEdit(head)}>
                  {i18n.locale === 'zh-CN' ? '编辑连接' : 'Edit connection'}
                </button>
                {isOAuthMethod(head.authMethod) && head.oauthStatus?.status !== 'connected' ? (
                  <button type="button" onClick={() => void handleOAuthLogin({ id: head.id })} disabled={oauthBusyId === head.id}>
                    {oauthBusyId === head.id ? '...' : (i18n.locale === 'zh-CN' ? '重新登录' : 'Re-login')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleRemoveGroup(g.groupId, head.name || head.provider)}
                  disabled={removingGroupId === g.groupId}
                >
                  {removingGroupId === g.groupId ? '...' : (i18n.locale === 'zh-CN' ? '删除渠道' : 'Remove provider')}
                </button>
              </div>
            
              </div>
              {supportsSubscriptionQuotaMethod(head.authMethod) ? (
                <div className="llm-group-header-quota">
                  <div className="llm-subscription-quota llm-group-quota">
                    <span
                      className={`llm-subscription-quota-text${quotaResults[head.id] && !quotaResults[head.id].success ? ' is-error' : ''}`}
                      title={formatQuotaLine(quotaResults[head.id], i18n.locale === 'zh-CN') ?? undefined}
                    >
                      {formatQuotaLine(quotaResults[head.id], i18n.locale === 'zh-CN')
                        ?? (quotaLoadingId === head.id
                          ? (i18n.locale === 'zh-CN' ? '额度加载中…' : 'Loading quota…')
                          : '')}
                    </span>
                    <button
                      type="button"
                      className="llm-subscription-quota-refresh"
                      disabled={quotaLoadingId === head.id}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleRefreshQuota(head.id);
                      }}
                    >
                      {quotaLoadingId === head.id ? '…' : (i18n.locale === 'zh-CN' ? '刷新额度' : 'Quota')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {!collapsed ? (
              <div className="llm-group-models">
                {g.models.map((p) => (
                  <ConfiguredModelRow
                    key={p.id}
                    i18n={i18n}
                    model={p}
                    result={testResults[p.id]}
                    testing={testingId === p.id}
                    duplicating={duplicatingId === p.id}
                    onSetDefault={() => void handleSetDefault(p.id)}
                    onTest={() => void handleTest(p.id)}
                    onDuplicate={() => void handleDuplicateModel(p.id)}
                    onEdit={() => setModelSettingsId(p.id)}
                    onDelete={() => void handleDelete(p.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          );
        })}
        </div>
      )}

{showForm ? (
        <Overlay
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
            setAddModelGroupId(null);
            setFormLockSource('manual');
            setShowAdvancedFields(false);
            clearLocalCliFlow();
          }}
          closeOnBackdrop={!saving && !oauthBusyId}
          ariaLabel={editingId
            ? (i18n.locale === 'zh-CN' ? '编辑连接' : 'Edit Connection')
            : isAddModel
              ? (i18n.locale === 'zh-CN' ? '添加模型' : 'Add Model')
              : (i18n.locale === 'zh-CN'
                ? `连接 ${activeTemplate?.title || selectedChannel.label || form.name || '服务'}`
                : `Connect ${activeTemplate?.title || selectedChannel.label || form.name || 'service'}`)}
          panelClassName="pa-overlay-panel llm-provider-modal"
        >
          {({ requestClose }) => (
          <>
            <header className="llm-modal-header">
              <div className="llm-provider-modal-title">
                <LlmBrandIcon
                  brand={activeTemplate?.brand || selectedChannel.label || form.name || form.provider}
                  channelId={form.channelId}
                  serviceTemplateId={activeTemplate?.id}
                  providerName={form.name || selectedChannel.label}
                />
                <div>
                  <h3>{editingId
                    ? (i18n.locale === 'zh-CN' ? '编辑连接' : 'Edit Connection')
                    : isAddModel
                      ? (i18n.locale === 'zh-CN' ? `给 ${form.name} 加模型` : `Add model to ${form.name}`)
                      : (i18n.locale === 'zh-CN'
                        ? `连接 ${activeTemplate?.title || selectedChannel.label || form.name || '服务'}`
                        : `Connect ${activeTemplate?.title || selectedChannel.label || form.name || 'service'}`)}</h3>
                  {templateLocked && activeTemplate ? (
                    <p className="llm-provider-modal-subtitle">
                      {activeTemplate.description || (isOAuthMethod(form.authMethod)
                        ? (i18n.locale === 'zh-CN' ? '授权登录' : 'Sign-in')
                        : (i18n.locale === 'zh-CN' ? 'API Key' : 'API Key'))}
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="llm-modal-close"
                aria-label={i18n.locale === 'zh-CN' ? '关闭' : 'Close'}
                onClick={requestClose}
              >
                <PeerIcon name="close" size={14} />
              </button>
            </header>
            <div className="llm-form llm-modal-body">

          {!isAddModel && (
          <>
          {!hideChannelPicker ? (
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
          ) : null}

          {canUseOAuth && !hideAuthPicker ? (
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

          {canChooseWire && !collapseOfficialAdvanced ? (
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

          {/* 订阅(OAuth)模式下直接登录，成功后才落盘。 */}
          {isOAuthMethod(form.authMethod) ? (
            <>
              {editingId ? (
                <label>
                  <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                  <input
                    value={form.name}
                    placeholder={selectedChannel.label || form.provider}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  />
                </label>
              ) : null}
              <label>
                <span>{i18n.locale === 'zh-CN' ? '订阅登录' : 'Subscription Login'}</span>
                <p className="llm-oauth-hint">
                  {editingId
                    ? (i18n.locale === 'zh-CN'
                      ? '当前为订阅登录连接。可直接修改显示名称并保存；无需填写 Base URL 或 API Key。'
                      : 'This is a subscription login connection. You can update the display name and save without Base URL or API Key.')
                    : form.authMethod === 'oauth_grok'
                      ? (i18n.locale === 'zh-CN'
                        ? '点击登录将打开 Grok 官方设备授权页。按页面提示确认一次性验证码后，Peer Agent 会保存 Grok 官方登录态并拉取 Grok Build 模型。'
                        : 'Click login to open the official Grok device authorization page. Confirm the one-time code to save your Grok Official session and load Grok Build models.')
                      : form.authMethod === 'oauth_google'
                        ? (i18n.locale === 'zh-CN'
                          ? '点击登录将直接打开浏览器，使用 Google 账号完成订阅授权。无需填写或校验 API Key。'
                          : 'Click login to open your browser and authorize with your Google subscription account. No API key is required.')
                        : (i18n.locale === 'zh-CN'
                          ? '点击登录将打开浏览器完成 ChatGPT 订阅账号登录;登录成功后才会保存,登录失败或取消不会保存任何配置。登录后自动拉取可用模型(默认使用最新模型)。'
                          : 'Clicking login opens your browser to sign in with your ChatGPT subscription. The provider is saved only after a successful login — nothing is saved if login fails or is cancelled. Available models are fetched after login (latest selected by default).')}
                </p>
              </label>
            </>
          ) : isLocalCliAuth ? (
            <>
                <div className="llm-oauth-hint llm-local-cli-hint">
                  {i18n.locale === 'zh-CN'
                    ? '复用本机 Qoder CLI 登录态，请求发往 Qoder 私有端点（不是 Ollama 这类纯本地模型）。'
                    : 'Reuses your local Qoder CLI login and sends requests to Qoder private endpoint (not a fully local runtime like Ollama).'}
                  <ul className="llm-local-cli-checklist">
                    <li>{i18n.locale === 'zh-CN' ? '本机已安装 Qoder CLI（qodercli）' : 'Qoder CLI (qodercli) is installed'}</li>
                    <li>{i18n.locale === 'zh-CN' ? '已在终端登录，且登录态未过期' : 'Signed in via terminal with a valid session'}</li>
                  </ul>
                </div>
                <label>
                  <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                  <input
                    value={form.name}
                    placeholder="Qoder（本机 CLI）"
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    disabled={saving}
                  />
                </label>
                {localCliDetectSteps.length > 0 ? (
                  <ol className="llm-local-cli-steps" aria-live="polite">
                    {localCliDetectSteps.map((step) => (
                      <li key={step.id} className={`llm-local-cli-step is-${step.status}`}>
                        <div className="llm-local-cli-step-main">
                          <span className="llm-local-cli-step-label">
                            {i18n.locale === 'zh-CN' ? step.labelZh : step.labelEn}
                          </span>
                          <span className="llm-local-cli-step-status">
                            {localCliDetectStatusLabel(step.status, i18n.locale === 'zh-CN')}
                          </span>
                        </div>
                        {step.detail ? (
                          <p className="llm-local-cli-step-detail">{friendlyLocalCliError(step.detail, i18n.locale)}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
            </>
          ) : (
            <>
              {!collapseOfficialAdvanced ? (
                <label>
                  <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                  <input value={form.name} placeholder={selectedChannel.label || form.provider} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
                </label>
              ) : null}

              <label>
                <span>API Key</span>
                <input type="password" value={form.apiKey} placeholder={editingId ? (i18n.locale === 'zh-CN' ? '留空则不修改' : 'Leave empty to keep') : ''} onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))} />
              </label>

              {collapseOfficialAdvanced ? (
                <div className="llm-advanced-block">
                  <button
                    type="button"
                    className="llm-advanced-toggle"
                    aria-expanded={showAdvancedFields}
                    onClick={() => setShowAdvancedFields((prev) => !prev)}
                  >
                    {showAdvancedFields
                      ? (i18n.locale === 'zh-CN' ? '收起高级设置' : 'Hide advanced settings')
                      : (i18n.locale === 'zh-CN' ? '高级设置' : 'Advanced settings')}
                  </button>
                  <div
                    className={`llm-advanced-panel${showAdvancedFields ? ' is-open' : ''}`}
                    aria-hidden={!showAdvancedFields}
                  >
                    <div className="llm-advanced-panel-inner">
                      <div className="llm-advanced-fields">
                        <label>
                          <span>{i18n.locale === 'zh-CN' ? '显示名称' : 'Display Name'}</span>
                          <input value={form.name} placeholder={selectedChannel.label || form.provider} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
                        </label>
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
                        <label>
                          <span>Base URL</span>
                          <input value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} />
                          {hideBaseUrlByDefault ? (
                            <small className="llm-field-hint">
                              {i18n.locale === 'zh-CN' ? '官方默认端点，通常无需修改。' : 'Official default endpoint; usually no need to change.'}
                            </small>
                          ) : null}
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <label>
                  <span>Base URL</span>
                  <input value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} />
                </label>
              )}
            </>
          )}
          </>
          )}

          {isAddModel && !isOAuthMethod(form.authMethod) ? (
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

          <div className="llm-vision-toggle">
            <span>{i18n.locale === 'zh-CN' ? '支持多模态（图像输入）' : 'Multimodal (image input) support'}</span>
            <Switch
              checked={form.supportsVision}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, supportsVision: checked }))}
              aria-label={i18n.locale === 'zh-CN' ? '支持多模态（图像输入）' : 'Multimodal (image input) support'}
            />
          </div>

          <div className="llm-vision-toggle">
            <span>{i18n.locale === 'zh-CN' ? '支持原生推理参数（reasoning/thinking）' : 'Native reasoning/thinking parameters'}</span>
            <Switch
              checked={form.supportsReasoning}
              onCheckedChange={(checked) => setForm((prev) => ({
                ...prev,
                supportsReasoning: checked,
                reasoningEffortMapText: checked ? prev.reasoningEffortMapText : '',
              }))}
              aria-label={i18n.locale === 'zh-CN' ? '支持原生推理参数' : 'Native reasoning parameters'}
            />
          </div>

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

          <div className="llm-vision-toggle">
            <span>{i18n.locale === 'zh-CN' ? '启用 Prompt 缓存（仅当网关真正复用缓存时开启，否则纯增成本）' : 'Enable prompt caching (only if the gateway actually reuses cache; otherwise pure cost)'}</span>
            <Switch
              checked={form.supportsPromptCaching}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, supportsPromptCaching: checked }))}
              aria-label={i18n.locale === 'zh-CN' ? '启用 Prompt 缓存' : 'Enable prompt caching'}
            />
          </div>

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

          {formError ? <p className="llm-form-error">{(isLocalCliAuth ? friendlyLocalCliError(formError, i18n.locale) : friendlyTestError(formError, i18n.locale))}</p> : null}
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
                ? (isLocalCliAuth
                    ? (i18n.locale === 'zh-CN' ? '检测中…' : 'Detecting…')
                    : '...')
                : (isLocalCliAuth && !editingId
                    ? (i18n.locale === 'zh-CN' ? '检测并连接' : 'Detect & connect')
                    : (isOAuthMethod(form.authMethod) && !editingId
                    ? subscriptionLoginLabel(form.authMethod, i18n.locale === 'zh-CN')
                    : (!editingId && !isAddModel && form.authMethod === 'api_key'
                      ? (i18n.locale === 'zh-CN' ? '下一步：选择模型' : 'Next: choose models')
                      : (i18n.locale === 'zh-CN' ? '保存' : 'Save'))))}
            </button>
            </div>
          </>
          )}
        </Overlay>
      ) : null}

      {pendingProviderDraft ? (
        <ModelCatalogDialog
          i18n={i18n}
          providerName={pendingProviderDraft.name}
          models={catalogResult.models}
          configuredModels={[]}
          source={catalogResult.source}
          loading={catalogLoading}
          error={catalogResult.error}
          selectionMode="multiple"
          allowManualModel
          onRefresh={() => void loadPendingCatalog(pendingProviderDraft)}
          onImport={handleImportModels}
          onClose={() => {
            setPendingProviderDraft(null);
            setShowForm(true);
          }}
          onAppliedClose={() => {
            setPendingProviderDraft(null);
            setCatalogTargetId(null);
          }}
        />
      ) : catalogTargetId ? (() => {
        const target = providers.find((provider) => provider.id === catalogTargetId);
        if (!target) return null;
        const groupId = target.groupId ?? target.id;
        const configuredModels = providers.filter((provider) => (provider.groupId ?? provider.id) === groupId);
        return (
          <ModelCatalogDialog
            i18n={i18n}
            providerName={target.name || target.provider}
            models={catalogResult.models}
            configuredModels={configuredModels}
            source={catalogResult.source}
            loading={catalogLoading}
            error={catalogResult.error}
            selectionMode="multiple"
            onRefresh={() => void loadCatalog(target.id)}
            onImport={handleImportModels}
            onClose={() => setCatalogTargetId(null)}
          />
        );
      })() : null}

      {modelSettingsId ? (() => {
        const target = providers.find((provider) => provider.id === modelSettingsId);
        if (!target) return null;
        return (
          <ModelSettingsDialog
            i18n={i18n}
            model={target}
            onSave={(patch) => handleSaveModelSettings(target.id, patch)}
            onClose={() => setModelSettingsId(null)}
          />
        );
      })() : null}

      {oauthPending ? (
        <Overlay
          onClose={() => undefined}
          closeOnBackdrop={false}
          ariaLabel={i18n.locale === 'zh-CN' ? 'Grok 登录授权码' : 'Grok sign-in authorization code'}
          panelClassName="llm-oauth-code-dialog"
          backdropClassName="llm-oauth-code-backdrop"
        >
          <div className="llm-oauth-code-content" role="status" aria-live="polite">
            <span>{i18n.locale === 'zh-CN' ? 'Grok 授权码（已复制）' : 'Grok authorization code (copied)'}</span>
            <strong>{oauthPending.userCode}</strong>
            <small>
              {i18n.locale === 'zh-CN'
                ? '请在已打开的 Grok 登录页面粘贴此授权码。授权完成后弹层会自动关闭。'
                : 'Paste this code into the Grok sign-in page. This dialog closes automatically after authorization.'}
            </small>
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                void clientApi.llmOAuthOpenPending().then((result) => {
                  if (!result.success) setFormError(result.error || 'oauth_open_browser_failed');
                }).catch((error: unknown) => {
                  setFormError(error instanceof Error ? error.message : 'oauth_open_browser_failed');
                });
              }}
            >
              {i18n.locale === 'zh-CN' ? '重新打开授权页' : 'Open authorization page again'}
            </button>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}
