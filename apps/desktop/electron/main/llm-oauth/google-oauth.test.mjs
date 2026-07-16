import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { refreshGoogleAccessToken } from './google-oauth.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Google subscription OAuth', () => {
  it('refreshes with the built-in installed-app client when no manual client is configured', async () => {
    let request = null;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        access_token: 'next-access',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tokens = await refreshGoogleAccessToken({
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 0,
    });

    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get('client_id'), '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    assert.equal(body.get('client_secret'), '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');
    assert.equal(body.get('refresh_token'), 'refresh-token');
    assert.equal(tokens.access, 'next-access');
    assert.equal(tokens.refresh, 'refresh-token');
  });

});
