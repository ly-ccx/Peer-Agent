import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ensureFreshTokens,
  refreshAccessToken,
} from './openai-oauth.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAI subscription OAuth', () => {
  it('refreshes with the public ChatGPT client via injected fetchImpl', async () => {
    let request = null;
    const fetchImpl = async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        access_token: 'next-access',
        expires_in: 3600,
      });
    };

    const tokens = await refreshAccessToken({
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 0,
      accountId: 'acct-1',
    }, { fetchImpl });

    assert.equal(request.url, 'https://auth.openai.com/oauth/token');
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(body.get('refresh_token'), 'refresh-token');
    assert.equal(body.get('scope'), 'openid profile email offline_access');
    assert.equal(tokens.access, 'next-access');
    // refresh 响应未回传 refresh_token / accountId 时沿用旧值
    assert.equal(tokens.refresh, 'refresh-token');
    assert.equal(tokens.accountId, 'acct-1');
  });

  it('keeps a sufficiently fresh token without network access', async () => {
    const tokens = {
      access: 'fresh',
      refresh: 'refresh',
      expires: Date.now() + 300_000,
    };
    const result = await ensureFreshTokens(tokens, {
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.tokens, tokens);
  });

  it('refreshes via injected fetchImpl when access is near expiry', async () => {
    const calls = [];
    const result = await ensureFreshTokens({
      access: 'old-access',
      refresh: 'refresh-token',
      expires: Date.now() + 1_000,
    }, {
      skewMs: 60_000,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({
          access_token: 'next-access',
          refresh_token: 'next-refresh',
          expires_in: 3600,
        });
      },
    });

    assert.equal(result.refreshed, true);
    assert.equal(result.tokens.access, 'next-access');
    assert.equal(result.tokens.refresh, 'next-refresh');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
  });
});
