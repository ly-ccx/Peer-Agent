import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ensureFreshGoogleTokens,
  refreshGoogleAccessToken,
} from './google-oauth.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Google subscription OAuth', () => {
  it('refreshes with the built-in installed-app client when no manual client is configured', async () => {
    let request = null;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({
        access_token: 'next-access',
        expires_in: 3600,
      });
    };

    const tokens = await refreshGoogleAccessToken({
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 0,
    }, { fetchImpl });

    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get('client_id'), '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    assert.equal(body.get('client_secret'), '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');
    assert.equal(body.get('refresh_token'), 'refresh-token');
    assert.equal(tokens.access, 'next-access');
    assert.equal(tokens.refresh, 'refresh-token');
  });

  it('keeps a sufficiently fresh token without network access', async () => {
    const tokens = {
      access: 'fresh',
      refresh: 'refresh',
      expires: Date.now() + 300_000,
    };
    const result = await ensureFreshGoogleTokens(tokens, {
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.tokens, tokens);
  });

  it('refreshes via injected fetchImpl when access is near expiry', async () => {
    const calls = [];
    const result = await ensureFreshGoogleTokens({
      access: 'old-access',
      refresh: 'refresh-token',
      expires: Date.now() + 1_000,
    }, {
      skewMs: 60_000,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({
          access_token: 'next-access',
          expires_in: 3600,
        });
      },
    });

    assert.equal(result.refreshed, true);
    assert.equal(result.tokens.access, 'next-access');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  });
});
