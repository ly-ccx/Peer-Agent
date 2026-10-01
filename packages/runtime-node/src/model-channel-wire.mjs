/** Shared model-dependent OpenCode Go protocol and endpoint selection. */
export const OPENCODE_GO_OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';

export function resolveOpenCodeGoWire(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return 'openai-chat';

  // Official docs: only GPT Luna uses the Responses endpoint on Go.
  if (id.includes('luna') || /^gpt-[\w.-]*luna\b/.test(id)) {
    return 'openai-responses';
  }

  // Anthropic Messages endpoint on Go.
  if (
    id.includes('claude')
    || id.includes('anthropic')
    || id.includes('minimax')
    || id.startsWith('qwen')
    || id.includes('qwen3')
  ) {
    return 'anthropic-messages';
  }

  // Chat Completions endpoint: glm / kimi / deepseek / grok / mimo / hy3, etc.
  return 'openai-chat';
}

/**
 * Pick the correct OpenCode Go base URL for the selected wire.
 * Accepts either /zen/go or /zen/go/v1 from saved configs and normalizes.
 */
export function resolveOpenCodeGoBaseUrl(wire, configuredBaseUrl) {
  const raw = String(configuredBaseUrl || '').trim().replace(/\/+$/, '');
  if (wire === 'anthropic-messages') {
    if (!raw) return OPENCODE_GO_ANTHROPIC_BASE_URL;
    if (/\/zen\/go\/v1$/i.test(raw)) return raw.replace(/\/v1$/i, '');
    return raw;
  }
  if (!raw) return OPENCODE_GO_OPENAI_BASE_URL;
  if (/\/zen\/go$/i.test(raw)) return `${raw}/v1`;
  return raw;
}
