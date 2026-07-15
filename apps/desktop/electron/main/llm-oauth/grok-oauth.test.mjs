import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GROK_CLI_CLIENT_ID,
  GROK_LOGIN_SCOPE,
  ensureFreshGrokTokens,
  refreshGrokTokens,
  startGrokOAuthLogin,
} from './grok-oauth.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Grok subscription OAuth', () => {
  it('completes device-code login with the public Grok CLI client', async () => {
    const calls = [];
    const pending = [];
    const opened = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/oauth2/device/code')) {
        return jsonResponse({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
          expires_in: 60,
          interval: 0.001,
        });
      }
      if (String(url).endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      }
      if (String(url).endsWith('/oauth2/userinfo')) {
        return jsonResponse({ sub: 'user-1', email: 'grok@example.com' });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const session = startGrokOAuthLogin({
      fetchImpl,
      openExternal: async (url) => opened.push(url),
      onPending: (value) => pending.push(value),
    });
    const tokens = await session.promise;

    assert.equal(tokens.access, 'access-token');
    assert.equal(tokens.refresh, 'refresh-token');
    assert.equal(tokens.clientId, GROK_CLI_CLIENT_ID);
    assert.equal(tokens.email, 'grok@example.com');
    assert.equal(tokens.userId, 'user-1');
    assert.deepEqual(opened, ['https://auth.x.ai/device?user_code=ABCD-EFGH']);
    assert.equal(pending[0].userCode, 'ABCD-EFGH');

    const deviceBody = new URLSearchParams(calls[0].init.body);
    assert.equal(deviceBody.get('client_id'), GROK_CLI_CLIENT_ID);
    assert.equal(deviceBody.get('scope'), GROK_LOGIN_SCOPE);
    const tokenBody = new URLSearchParams(calls[1].init.body);
    assert.equal(tokenBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  });

  it('refreshes an expired token and preserves rotated refresh state', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 7200 });
    };
    const next = await refreshGrokTokens({
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 0,
    }, { fetchImpl });

    assert.equal(next.access, 'next-access');
    assert.equal(next.refresh, 'next-refresh');
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');
    assert.equal(body.get('client_id'), GROK_CLI_CLIENT_ID);
  });

  it('keeps a sufficiently fresh token without network access', async () => {
    const tokens = { access: 'fresh', refresh: 'refresh', expires: Date.now() + 300_000 };
    const result = await ensureFreshGrokTokens(tokens, {
      fetchImpl: async () => { throw new Error('should not fetch'); },
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.tokens, tokens);
  });
});
