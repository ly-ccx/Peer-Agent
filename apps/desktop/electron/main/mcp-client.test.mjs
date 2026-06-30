import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __mcpClientInternals } from './mcp-client.mjs';

describe('MCP client OAuth transport integration', () => {
  it('injects an OAuth authProvider for HTTP transports and persists token updates', async () => {
    const updates = [];
    const server = {
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Trace': 'trace-id' },
      __authContext: {
        mode: 'oauth2',
        credentialRef: 'mcp-cred:test',
        hasCredential: true,
        authProviderConfig: {
          credentialRef: 'mcp-cred:test',
          oauth: {
            authorizationServerUrl: 'https://auth.example.com/',
            clientId: 'client-id',
            scopes: ['mcp.read', 'mcp.write'],
            redirectUrl: 'http://127.0.0.1:33418/mcp/oauth/callback',
          },
          updateOAuth: async (patch) => updates.push(patch),
          openAuthorizationUrl: async (url) => updates.push({ opened: url }),
        },
      },
    };

    const transport = __mcpClientInternals.createTransport(server);
    const provider = transport._authProvider;

    assert.ok(provider, 'transport should receive authProvider');
    assert.equal(provider.redirectUrl, 'http://127.0.0.1:33418/mcp/oauth/callback');
    assert.equal(provider.clientMetadata.client_id, 'client-id');
    assert.equal(provider.clientMetadata.scope, 'mcp.read mcp.write');

    await provider.saveTokens({ access_token: 'access-secret', token_type: 'Bearer' });
    assert.deepEqual(updates.at(-1), { tokens: { access_token: 'access-secret', token_type: 'Bearer' } });

    await provider.saveCodeVerifier('pkce-secret');
    assert.deepEqual(updates.at(-1), { codeVerifier: 'pkce-secret' });

    await provider.redirectToAuthorization('https://auth.example.com/authorize');
    assert.deepEqual(updates.at(-1), { opened: 'https://auth.example.com/authorize' });
  });

  it('classifies auth challenge errors for MCP probe state', () => {
    assert.equal(__mcpClientInternals.isAuthRequiredError({ status: 401, message: 'Unauthorized' }), true);
    assert.equal(__mcpClientInternals.isAuthRequiredError(new Error('HTTP 403 Forbidden')), true);
    assert.equal(__mcpClientInternals.isAuthRequiredError(new Error('www-authenticate: Bearer')), true);
    assert.equal(__mcpClientInternals.isAuthRequiredError(new Error('ECONNREFUSED')), false);
  });
});
