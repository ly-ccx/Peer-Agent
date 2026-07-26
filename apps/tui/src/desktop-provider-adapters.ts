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

export async function countAnthropicRequestFromDesktop(
  args: DesktopStreamArgs,
): Promise<{ inputTokens: number; source: 'provider_count_api' }> {
  const { countAnthropicCanonicalRequest } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/context-count-adapter.mjs'
  );
  return countAnthropicCanonicalRequest(args);
}

export async function countGeminiRequestFromDesktop(
  args: DesktopStreamArgs,
): Promise<{ inputTokens: number; source: 'provider_count_api' }> {
  const { countGeminiCanonicalRequest } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/provider-adapters/context-count-adapter.mjs'
  );
  return countGeminiCanonicalRequest(args);
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

/**
 * CLI-side Grok re-login via RFC 8628 device authorization grant.
 *
 * Used when the existing token's scope is missing `api:access`
 * (error code `grok_oauth_scope_upgrade_required`). Refresh tokens
 * cannot upgrade scope — only a fresh device flow can.
 *
 * In the CLI/TUI environment we:
 *   1. Print the verification URL + user code to stderr (visible above TUI)
 *   2. Best-effort open the browser via the platform's `open`/`xdg-open`/`start`
 *   3. Poll until the user completes browser auth
 *   4. Return the fresh token set so the caller can persist + use it
 */
export async function startGrokReLoginFromDesktop(
  options?: { fetchImpl?: typeof fetch },
): Promise<ChatGptOAuthTokens> {
  const { startGrokOAuthLogin } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/llm-oauth/grok-oauth.mjs'
  );

  const session = startGrokOAuthLogin({
    fetchImpl: options?.fetchImpl,
    openExternal: async (url: string) => {
      const { exec } = await import('node:child_process');
      const platform = process.platform;
      const cmd =
        platform === 'darwin'
          ? `open "${url}"`
          : platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd, (err) => {
        if (err) {
          process.stderr.write(
            `\n  ⚠ 无法自动打开浏览器，请手动访问:\n  ${url}\n\n`,
          );
        }
      });
    },
    onPending: (pending: {
      verificationUrl: string;
      userCode: string;
      expiresAt: string;
    }) => {
      process.stderr.write(
        `\n  🔑 Grok 重新授权 — 请在浏览器中完成登录\n` +
          `  授权码: ${pending.userCode}\n` +
          `  授权链接: ${pending.verificationUrl}\n` +
          `  过期时间: ${pending.expiresAt}\n\n`,
      );
    },
  });

  const tokens = await session.promise;
  return tokens as ChatGptOAuthTokens;
}
