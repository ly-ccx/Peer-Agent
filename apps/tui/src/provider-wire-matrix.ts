/**
 * TUI channel → wire resolution.
 *
 * Desktop owns the full channel descriptor catalog. TUI keeps a pure,
 * testable matrix so CLI never silently pretends an unsupported protocol
 * is OpenAI-compatible.
 *
 * Hard rule: known non-compatible channels must either map to the correct
 * wire or return explicit unsupported — never fake-compatible.
 */

export type TuiWire =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'qoder-private'
  | 'gemini';

export type TuiWireAuthMethod =
  | 'api_key'
  | 'oauth_chatgpt'
  | 'oauth_google'
  | 'oauth_grok'
  | 'qoder_local_auth'
  | 'local_cli'
  | string;

export type TuiWireChannelId =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'google-ai'
  | 'grok'
  | 'qoder'
  | string;

export interface TuiWireResolveInput {
  readonly channelId?: string | null;
  readonly authMethod?: string | null;
  readonly providerId?: string | null;
  readonly displayName?: string | null;
}

export type TuiWireDecision =
  | {
      readonly kind: 'supported';
      readonly wire: TuiWire;
      readonly channelId: string;
      readonly authMethod: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly channelId: string;
      readonly authMethod: string;
      readonly reason: string;
      /** Stable machine code for UI / logs. */
      readonly code: string;
    };

/** Wires TUI can actually construct a ModelProvider for today. */
export const TUI_SUPPORTED_WIRES: readonly TuiWire[] = [
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'qoder-private',
  'gemini',
] as const;

/**
 * Explicit channel/auth → wire table (mirrors Desktop defaults for hosts we care about).
 * Prefer authMethod when it is decisive; otherwise fall back to channelId.
 */
export function resolveTuiWire(input: TuiWireResolveInput): TuiWireDecision {
  const authMethod = normalize(input.authMethod) || 'api_key';
  const channelId = normalize(input.channelId);
  const providerId = normalize(input.providerId);
  const displayName = normalize(input.displayName);

  // Auth-method-first (same precedence as Desktop resolveChannel).
  if (authMethod === 'oauth_chatgpt') {
    return supported('openai-responses', channelId || 'openai', authMethod, 'ChatGPT OAuth → OpenAI Responses');
  }
  if (authMethod === 'oauth_grok') {
    return supported('openai-responses', channelId || 'grok', authMethod, 'Grok OAuth → OpenAI Responses');
  }
  if (authMethod === 'oauth_google') {
    return supported('gemini', channelId || 'google-ai', authMethod, 'Google OAuth → Gemini generateContent');
  }
  if (authMethod === 'qoder_local_auth' || authMethod === 'local_cli') {
    return supported('qoder-private', channelId || 'qoder', authMethod, 'Qoder local auth → private SSE wire');
  }

  // Channel-id path for API-key / configured providers.
  if (channelId === 'qoder' || providerId.includes('qoder') || displayName.includes('qoder')) {
    return supported('qoder-private', channelId || 'qoder', authMethod, 'Qoder channel → private SSE wire');
  }
  if (
    channelId === 'anthropic'
    || channelId === 'anthropic-compatible'
    || providerId === 'anthropic'
    || providerId.includes('anthropic')
  ) {
    return supported(
      'anthropic-messages',
      channelId || 'anthropic',
      authMethod,
      'Anthropic / anthropic-compatible → /v1/messages',
    );
  }
  if (channelId === 'google-ai' || providerId.includes('gemini') || displayName.includes('gemini')) {
    return supported('gemini', channelId || 'google-ai', authMethod, 'Google AI / Gemini → generateContent SSE');
  }
  if (channelId === 'openai' || channelId === 'grok') {
    // Official OpenAI / Grok API-key configs use chat completions unless OAuth (handled above).
    return supported('openai-chat', channelId, authMethod, `${channelId} API key → OpenAI-compatible chat`);
  }
  if (channelId === 'openai-compatible' || !channelId) {
    return supported(
      'openai-chat',
      channelId || 'openai-compatible',
      authMethod,
      'OpenAI-compatible (or unknown channel defaults to chat completions)',
    );
  }

  // Unknown but explicit channel: fail closed with a clear reason.
  return {
    kind: 'unsupported',
    channelId,
    authMethod,
    code: `unsupported_channel:${channelId}:${authMethod}`,
    reason:
      `TUI has no wire mapping for channel "${channelId}" (auth=${authMethod}). `
      + 'Configure an OpenAI-compatible endpoint, or use a supported channel '
      + '(openai / anthropic / anthropic-compatible / google-ai / grok / qoder).',
  };
}

export function assertTuiWireSupported(input: TuiWireResolveInput): Extract<TuiWireDecision, { kind: 'supported' }> {
  const decision = resolveTuiWire(input);
  if (decision.kind === 'unsupported') {
    throw new Error(decision.reason);
  }
  return decision;
}

export function formatTuiWireMatrix(): string {
  return [
    'channel/auth → wire (TUI)',
    '  oauth_chatgpt          → openai-responses',
    '  oauth_grok             → openai-responses',
    '  oauth_google           → gemini',
    '  qoder_local_auth       → qoder-private',
    '  anthropic*             → anthropic-messages',
    '  google-ai / gemini     → gemini',
    '  openai / grok (api)    → openai-chat',
    '  openai-compatible      → openai-chat',
    '  unknown channel        → unsupported (explicit error)',
  ].join('\n');
}

function supported(
  wire: TuiWire,
  channelId: string,
  authMethod: string,
  reason: string,
): Extract<TuiWireDecision, { kind: 'supported' }> {
  return { kind: 'supported', wire, channelId, authMethod, reason };
}

function normalize(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}
