/**
 * Single seam for Desktop Main stream/auth adapters used by TUI providers.
 *
 * This does NOT make CLI depend on the Desktop app at install/runtime.
 * Monorepo builds may still compile these modules into the `peer` binary.
 * Hosts should inject fakes in tests; production defaults load Desktop adapters
 * dynamically so the import surface stays localized.
 */

import type { ChatGptOAuthTokens } from '@peer-agent/runtime-node';

export type DesktopStreamArgs = Record<string, unknown>;

export async function loadQoderAccessTokenFromDesktop(): Promise<string> {
  const { loadQoderAccessToken } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/qoder-local-auth.mjs'
  );
  return loadQoderAccessToken();
}

export async function sendQoderPrivateStreamFromDesktop(
  args: DesktopStreamArgs,
): Promise<Record<string, unknown>> {
  const { sendQoderPrivateStream } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/qoder-private-adapter.mjs'
  );
  return sendQoderPrivateStream(args) as Promise<Record<string, unknown>>;
}

export async function sendAnthropicMessagesStreamFromDesktop(
  args: DesktopStreamArgs,
): Promise<Record<string, unknown>> {
  const { sendAnthropicMessagesStream } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/anthropic-messages-adapter.mjs'
  );
  return sendAnthropicMessagesStream(args) as Promise<Record<string, unknown>>;
}

export async function sendGeminiStreamFromDesktop(
  args: DesktopStreamArgs,
): Promise<Record<string, unknown>> {
  const { sendGeminiStream } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/gemini-adapter.mjs'
  );
  return sendGeminiStream(args) as Promise<Record<string, unknown>>;
}

export async function ensureFreshGoogleTokensFromDesktop(
  tokens: ChatGptOAuthTokens,
): Promise<ChatGptOAuthTokens> {
  const { ensureFreshGoogleTokens } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/llm-oauth/google-oauth.mjs'
  );
  return ensureFreshGoogleTokens(tokens);
}

/** Code Assist base used by Desktop for oauth_google (not generativelanguage openai shim). */
export const GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com';

export async function ensureFreshGrokTokensFromDesktop(
  tokens: ChatGptOAuthTokens,
  options?: { fetchImpl?: typeof fetch },
): Promise<{
  tokens: ChatGptOAuthTokens;
  [key: string]: unknown;
}> {
  const { ensureFreshGrokTokens } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/llm-oauth/grok-oauth.mjs'
  );
  return ensureFreshGrokTokens(tokens, options);
}

