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
 * TUI runs in an alternate screen buffer, so we must NOT write to
 * stdout/stderr (that would paint over the input box). Instead:
 *   1. Best-effort open the verification URL in the system browser
 *   2. Copy the user code to the clipboard (same as Desktop)
 *   3. Poll until the user completes browser auth
 * If the browser cannot be opened, throw a structured Error so the
 * existing chat Error renderer can show URL + code without layout damage.
 */
export async function startGrokReLoginFromDesktop(
  options?: { fetchImpl?: typeof fetch },
): Promise<ChatGptOAuthTokens> {
  const { startGrokOAuthLogin } = await import(
    // @ts-expect-error Desktop ESM adapter does not publish declarations.
    '../../desktop/electron/main/llm-oauth/grok-oauth.mjs'
  );
  const { spawn } = await import('node:child_process');

  function copyToClipboard(value: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child;
      try {
        if (process.platform === 'darwin') {
          child = spawn('pbcopy');
        } else if (process.platform === 'win32') {
          child = spawn('cmd', ['/c', 'clip']);
        } else {
          child = spawn('xclip', ['-selection', 'clipboard']);
        }
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.end(value);
    });
  }

  function openBrowser(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child;
      try {
        if (process.platform === 'darwin') {
          child = spawn('open', [url], { stdio: 'ignore', detached: true });
        } else if (process.platform === 'win32') {
          child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
        } else {
          child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
        }
      } catch {
        resolve(false);
        return;
      }
      child.unref();
      child.on('error', () => resolve(false));
      // open/xdg-open exit quickly after handing off to the browser
      child.on('close', (code) => resolve(code === 0 || code === null));
    });
  }

  type GrokPendingInfo = { verificationUrl: string; userCode: string };
  let pendingInfo: GrokPendingInfo | null = null;
  let browserOpened = false;
  let codeCopied = false;
  let pendingReady: (() => void) | null = null;
  const pendingDone = new Promise<void>((resolve) => {
    pendingReady = resolve;
  });

  const session = startGrokOAuthLogin({
    fetchImpl: options?.fetchImpl,
    openExternal: async (url: string) => {
      browserOpened = await openBrowser(url);
    },
    onPending: (pending: {
      verificationUrl: string;
      userCode: string;
      expiresAt: string;
    }) => {
      pendingInfo = {
        verificationUrl: pending.verificationUrl,
        userCode: pending.userCode,
      };
      // Fire-and-forget clipboard; Desktop does the same.
      void copyToClipboard(pending.userCode).then((ok) => {
        codeCopied = ok;
      });
      pendingReady?.();
    },
  });

  try {
    const tokens = await session.promise;
    return tokens as ChatGptOAuthTokens;
  } catch (err) {
    await pendingDone.catch(() => undefined);
    // If browser open failed, surface URL/code via the normal Error path
    // (chat message), never via stderr which breaks the TUI alt-screen.
    if (!browserOpened && pendingInfo) {
      const info: GrokPendingInfo = pendingInfo;
      const hint = codeCopied
        ? `授权码已复制到剪贴板: ${info.userCode}`
        : `授权码: ${info.userCode}`;
      const error = new Error(
        `Grok 需要重新授权，但无法自动打开浏览器。\n请访问: ${info.verificationUrl}\n${hint}`,
      );
      (error as Error & { code?: string }).code = 'grok_oauth_browser_open_failed';
      throw error;
    }
    throw err;
  }
}
