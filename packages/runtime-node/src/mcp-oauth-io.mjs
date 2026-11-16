import { isDeepStrictEqual } from 'node:util';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

// A base OAuthError is deliberately used: the SDK must not turn a guarded failure
// into registration, credential invalidation, or another token exchange.
export class McpOAuthGuardError extends OAuthError {
  static errorCode = 'mcp_oauth_guarded_failure';
  constructor(message) {
    super(message);
    this.code = message === 'mcp_execution_outcome_unknown' ? 'execution_outcome_unknown' : message;
  }
}
export function oauthGuard(error) {
  if (error instanceof McpOAuthGuardError) return error;
  const message = /^mcp_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'mcp_oauth_operation_failed';
  return new McpOAuthGuardError(message);
}
const fail = (code) => { throw new McpOAuthGuardError(code); };
export function tokenNeedsRefresh(tokens) {
  if (!tokens?.access_token) return true;
  const expires = tokens.expires_at ?? tokens.expiresAt;
  if (expires !== undefined && expires !== null) {
    if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 0 || expires > 8640000000000000) fail('mcp_oauth_token_invalid');
    return expires <= Date.now() + 30_000;
  }
  return tokens.expires_in !== undefined && tokens.expires_in !== null;
}
function bounded(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (++nodes > 8192 || depth > 32) fail('mcp_oauth_limit');
    if (v && typeof v === 'object') for (const child of Object.values(v)) {
      if (stack.length + nodes >= 8192) fail('mcp_oauth_limit');
      stack.push([child, depth + 1]);
    }
  }
}
async function readBody(response) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0, complete = false;
  try {
    if (reader) for (;;) {
      const {value, done} = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > 1024 * 1024) fail('mcp_oauth_limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    if (reader) { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

/** Owns SDK HTTP exchanges and the one-shot receipt for the following saveTokens callback. */
export function createMcpOAuthIo(config, {signal} = {}) {
  if (typeof config.assertCurrent !== 'function' || typeof config.exchangeTokens !== 'function') fail('mcp_oauth_revision_guard_required');
  const active = new Set(), controllers = new Set();
  let closed = false, receipt;
  const check = () => {
    if (closed || signal?.aborted) fail('mcp_oauth_cancelled');
    try { config.assertCurrent(); } catch (error) { throw oauthGuard(error); }
  };
  async function request(input, init = {}) {
    check();
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let body = init.body;
    if (body === undefined && input instanceof Request && !['GET','HEAD'].includes(input.method)) fail('mcp_oauth_request_body_required');
    let rpc;
    if (typeof body === 'string' && body.startsWith('{')) {
      try { const v = JSON.parse(body); if (v.jsonrpc === '2.0') rpc = v; } catch { /* SDK handles malformed protocol payloads. */ }
    }
    const tool = rpc?.method === 'tools/call';
    const form = body instanceof URLSearchParams ? body : typeof body === 'string' && headers.get('content-type')?.includes('application/x-www-form-urlencoded') ? new URLSearchParams(body) : undefined;
    const grant = form?.get('grant_type');
    const token = grant !== undefined && grant !== null;
    const stream = rpc || url === config.serverUrl;
    if (body != null && Buffer.byteLength(String(body)) > 256 * 1024) fail('mcp_oauth_limit');
    if (token && (!['refresh_token','authorization_code'].includes(grant) || receipt)) fail('mcp_oauth_exchange_forbidden');
    if (tool) {
      if (tokenNeedsRefresh(config.oauth.tokens)) fail('mcp_oauth_refresh_required');
    }
    const controller = new AbortController();
    controllers.add(controller);
    const signals = [controller.signal, signal, init.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
    const requestSignal = AbortSignal.any(signals);
    const deadline = Date.now() + 30_000;
    const timer = !stream || token ? setTimeout(() => controller.abort(), 30_000) : undefined;
    const send = () => fetch(input, {...init, signal:requestSignal, redirect:'manual'});
    try {
      if (token) {
        const saved = await config.exchangeTokens({tokenUrl:url, grantType:grant, refreshToken:form.get('refresh_token'), codeVerifier:form.get('code_verifier')}, async () => {
          if (requestSignal.aborted || Date.now() >= deadline) fail('mcp_oauth_cancelled');
          const response = await send();
          if (!response.ok) { await response.body?.cancel(); fail('mcp_oauth_token_response_failed'); }
          const parsed = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(await readBody(response)));
          bounded(parsed);
          if (requestSignal.aborted || Date.now() >= deadline) fail('mcp_oauth_cancelled');
          return OAuthTokensSchema.parse(parsed);
        });
        // Store has already persisted the absolute expiry and preserved grant fields.
        receipt = OAuthTokensSchema.parse(saved);
        return Response.json(receipt);
      }
      const response = await send();
      if (tool && ([401,403].includes(response.status) || (response.status >= 300 && response.status < 400))) {
        await response.body?.cancel(); fail('mcp_execution_outcome_unknown');
      }
      if (!stream) {
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('mcp_oauth_redirect_forbidden'); }
        const bytes = await readBody(response);
        if (response.ok && response.headers.get('content-type')?.includes('json')) {
          const parsed = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
          bounded(parsed);
        }
        const nextHeaders = new Headers(response.headers);
        nextHeaders.delete('content-encoding'); nextHeaders.delete('content-length');
        return new Response(bytes, {status:response.status, headers:nextHeaders});
      }
      return response;
    } catch (error) {
      if (tool) fail('mcp_execution_outcome_unknown');
      throw oauthGuard(error);
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  return {
    check,
    fetch(input, init) {
      const operation = request(input, init);
      active.add(operation);
      operation.then(() => active.delete(operation), () => active.delete(operation));
      return operation;
    },
    saveTokens(tokens) {
      check();
      if (!receipt || !isDeepStrictEqual(tokens, receipt)) fail('mcp_oauth_commit_receipt_required');
      receipt = undefined;
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active]);
      receipt = undefined;
    },
  };
}
