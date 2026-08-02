import { describe, expect, test } from 'bun:test';

import {
  createTuiProviderFetch,
  mergeTrustedCertificates,
  proxyForUrl,
  resolveExtraCaPath,
  shouldBypassProxy,
} from './provider-transport.ts';

function connectionError(message: string, code?: string): Error {
  const error = new TypeError(message);
  if (code) {
    (error as Error & { cause?: { code?: string } }).cause = { code };
  }
  return error;
}

describe('TUI provider transport', () => {
  test('selects standard proxy variables by URL scheme', () => {
    const env = {
      HTTP_PROXY: 'http://http-proxy.example:8080',
      HTTPS_PROXY: 'http://https-proxy.example:8443',
      ALL_PROXY: 'http://fallback-proxy.example:3128',
    };
    expect(proxyForUrl(new URL('http://api.example.test'), env)).toBe(env.HTTP_PROXY);
    expect(proxyForUrl(new URL('https://api.example.test'), env)).toBe(env.HTTPS_PROXY);
    expect(proxyForUrl(new URL('ftp://api.example.test'), env)).toBe(env.ALL_PROXY);
  });

  test('honors NO_PROXY exact, suffix, port, and wildcard rules', () => {
    expect(shouldBypassProxy(new URL('https://localhost'), 'localhost')).toBe(true);
    expect(shouldBypassProxy(new URL('https://api.corp.test'), '.corp.test')).toBe(true);
    expect(shouldBypassProxy(new URL('https://corp.test'), '.corp.test')).toBe(true);
    expect(shouldBypassProxy(new URL('https://api.corp.test:444'), 'api.corp.test:443')).toBe(false);
    expect(shouldBypassProxy(new URL('https://anything.test'), '*')).toBe(true);
  });

  test('falls back to system proxy only when env proxy is unset', () => {
    const systemProxy = {
      http: 'http://system-proxy.example:9674',
      https: 'http://system-proxy.example:9675',
    };
    // Env proxy wins over system proxy.
    expect(
      proxyForUrl(new URL('https://api.example.test'), { HTTPS_PROXY: 'http://env:8443' }, systemProxy),
    ).toBe('http://env:8443');
    // No env proxy: fall back to system proxy per scheme.
    expect(proxyForUrl(new URL('https://api.example.test'), {}, systemProxy)).toBe(systemProxy.https);
    expect(proxyForUrl(new URL('http://api.example.test'), {}, systemProxy)).toBe(systemProxy.http);
  });

  test('honors NO_PROXY even when a system proxy is available', () => {
    const systemProxy = { https: 'http://system-proxy.example:9675' };
    expect(
      proxyForUrl(new URL('https://localhost'), { NO_PROXY: 'localhost' }, systemProxy),
    ).toBeUndefined();
  });

  test('uses injected system proxy config in createTuiProviderFetch', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fakeFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    ) as typeof globalThis.fetch;
    const providerFetch = createTuiProviderFetch({
      env: {},
      systemProxy: { https: 'http://system-proxy.example:9675' },
      fetch: fakeFetch,
    });

    await providerFetch('https://chatgpt.com/backend-api/codex');

    expect(calls[0]?.init).toMatchObject({ proxy: 'http://system-proxy.example:9675' });
  });

  test('prefers the Peer Agent CA setting and accepts Node extra CA compatibility', () => {
    expect(resolveExtraCaPath({
      PEER_EXTRA_CA_CERTS: '/certs/peer.pem',
      NODE_EXTRA_CA_CERTS: '/certs/node.pem',
    })).toBe('/certs/peer.pem');
    expect(resolveExtraCaPath({ NODE_EXTRA_CA_CERTS: '/certs/node.pem' })).toBe('/certs/node.pem');
  });

  test('merges built-in, macOS, and explicit CA certificates without duplicates', () => {
    expect(mergeTrustedCertificates(
      ['built-in', 'shared'],
      ['macos-enterprise', 'shared'],
      'explicit-extra',
    )).toEqual(['built-in', 'shared', 'macos-enterprise', 'explicit-extra']);
  });

  test('passes trusted CAs, certificate verification, and proxy to Bun fetch', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fakeFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    ) as typeof globalThis.fetch;
    const providerFetch = createTuiProviderFetch({
      env: { HTTPS_PROXY: 'http://proxy.example:8443' },
      systemRootCertificates: ['system-ca'],
      macosTrustedCertificates: ['enterprise-ca'],
      fetch: fakeFetch,
      // Keep this unit test focused on CA/proxy wiring.
      connectionRecovery: false,
    });

    await providerFetch('https://chatgpt.com/backend-api/codex');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      proxy: 'http://proxy.example:8443',
      tls: {
        ca: ['system-ca', 'enterprise-ca'],
        rejectUnauthorized: true,
      },
    });
  });

  test('re-reads system proxy on each request when not fixed', async () => {
    const proxies: Array<string | undefined> = [];
    let reads = 0;
    const fakeFetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        proxies.push((init as { proxy?: string } | undefined)?.proxy);
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    ) as typeof globalThis.fetch;
    const providerFetch = createTuiProviderFetch({
      env: {},
      systemRootCertificates: [],
      macosTrustedCertificates: [],
      fetch: fakeFetch,
      connectionRecovery: false,
      readSystemProxy: () => {
        reads += 1;
        return reads === 1
          ? { https: 'http://stale-proxy.example:1' }
          : { https: 'http://fresh-proxy.example:2' };
      },
    });

    await providerFetch('https://api.example.test/one');
    await providerFetch('https://api.example.test/two');

    expect(reads).toBe(2);
    expect(proxies).toEqual([
      'http://stale-proxy.example:1',
      'http://fresh-proxy.example:2',
    ]);
  });

  test('retries a transient connection failure without restarting the CLI process', async () => {
    let attempts = 0;
    const fakeFetch = Object.assign(
      async () => {
        attempts += 1;
        if (attempts === 1) throw connectionError('fetch failed', 'ECONNRESET');
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    ) as typeof globalThis.fetch;
    const providerFetch = createTuiProviderFetch({
      env: {},
      systemRootCertificates: [],
      macosTrustedCertificates: [],
      systemProxy: {},
      fetch: fakeFetch,
    });

    const response = await providerFetch('https://api.example.test/chat');
    expect(response.status).toBe(204);
    expect(attempts).toBe(2);
  });

  test('projects recovery buildInit through the TUI proxy and TLS transport', async () => {
    const attempts: RequestInit[] = [];
    const fakeFetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        attempts.push(init ?? {});
        if (attempts.length === 1) throw connectionError('fetch failed', 'ECONNRESET');
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    ) as typeof globalThis.fetch;
    const providerFetch = createTuiProviderFetch({
      env: {},
      systemRootCertificates: ['system-ca'],
      macosTrustedCertificates: [],
      systemProxy: { https: 'http://proxy.example:8443' },
      fetch: fakeFetch,
      recovery: {
        retryDelaysMs: [0],
        retryJitterRatio: 0,
        connectTimeoutMs: 0,
        waitImpl: async () => {},
        buildInit: ({ attempt, isRetry }) => ({
          body: JSON.stringify({ request_id: `req-${attempt}`, is_retry: isRetry }),
        }),
      },
    });

    const response = await providerFetch('https://api.example.test/chat', {
      method: 'POST',
      headers: { 'x-base': 'kept' },
    });

    expect(response.status).toBe(204);
    expect(attempts.map((init) => init.body)).toEqual([
      JSON.stringify({ request_id: 'req-0', is_retry: false }),
      JSON.stringify({ request_id: 'req-1', is_retry: true }),
    ]);
    for (const init of attempts) {
      expect(init.method).toBe('POST');
      expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://proxy.example:8443');
      expect((init as RequestInit & { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized)
        .toBe(true);
    }
  });
});

test('production transport keeps TLS certificate verification enabled', async () => {
  const source = await Bun.file(new URL('./provider-transport.ts', import.meta.url)).text();
  expect(source).toContain('rejectUnauthorized: true');
  expect(source).not.toContain('rejectUnauthorized: false');
  expect(source).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  expect(source).toContain('fetchWithConnectionRecovery');
});
