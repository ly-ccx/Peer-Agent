import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CapabilityExecutionContext, CapabilityRequest } from '@peer-agent/runtime-core';

import { fetchNodeWebPage, normalizeWebUrl, stripHtml } from './web-fetch-engine.ts';
import { createNodeWebFetchProvider } from './web-fetch-provider.ts';

function request(url: string): CapabilityRequest {
  const input = { url, waitForRender: true, timeoutMs: 5_000 };
  return {
    capabilityId: 'local.web.fetch',
    toolCall: {
      toolCallId: 'call-web-fetch',
      capabilityId: 'local.web.fetch',
      input,
    },
    input,
  };
}

function context(): CapabilityExecutionContext {
  return {
    runId: 'run-web-fetch',
    sessionId: 'session-web-fetch',
    workspace: { root: '/workspace' },
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
}

test('web fetch engine validates protocols and extracts readable HTML', async () => {
  assert.throws(() => normalizeWebUrl('file:///tmp/secret'), /unsupported_protocol/);
  assert.equal(stripHtml('<title>Ignored</title><script>x()</script><p>Hello &amp; world</p>'), 'Ignored Hello & world');
});

test('web fetch engine follows validated redirects and reports static HTTP mode', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/page' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Peer Page</title></head><body><h1>Hello</h1><p>Readable body</p></body></html>');
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = await listen(server);

  const result = await fetchNodeWebPage({ url: `${root}/redirect` });
  assert.equal(result.ok, true);
  assert.equal(result.fetchMode, 'http');
  assert.equal(result.finalUrl, `${root}/page`);
  assert.equal(result.title, 'Peer Page');
  assert.match(result.content ?? '', /Readable body/);
});

test('web fetch provider requires approval before network access', async (t) => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-web-denied-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(artifactRoot, { recursive: true, force: true })));
  let fetchCalls = 0;
  const provider = createNodeWebFetchProvider({
    workspaceRoot: artifactRoot,
    artifactRoot,
    requestApproval: async () => ({ granted: false, reason: 'user_denied' }),
    webFetcher: async () => {
      fetchCalls += 1;
      return { ok: true, fetchMode: 'http', content: 'should not run' };
    },
  });

  const result = await provider.execute(request('https://example.com/'), context());
  assert.equal(result.status, 'denied');
  assert.equal(result.error?.code, 'user_denied');
  assert.equal(fetchCalls, 0);
});

test('web fetch provider stores full content as artifact and returns bounded factual context', async (t) => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-web-artifact-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(artifactRoot, { recursive: true, force: true })));
  const provider = createNodeWebFetchProvider({
    workspaceRoot: artifactRoot,
    artifactRoot,
    requestApproval: async (prompt) => {
      assert.equal(prompt.confirmation.approvalKind, 'web-fetch');
      assert.equal(prompt.riskLevel, 'L3_sensitive');
      return { granted: true, reason: 'test_approved' };
    },
    webFetcher: async () => ({
      ok: true,
      finalUrl: 'https://example.com/final',
      title: 'Example',
      content: 'full page content',
      contentType: 'text/plain',
      httpStatus: 200,
      fetchMode: 'http',
    }),
    now: () => '2026-07-23T00:00:00.000Z',
    idFactory: () => 'web-id',
  });

  const result = await provider.execute(request('https://example.com/start'), context());
  assert.equal(result.status, 'completed');
  assert.equal(result.permissionGrant?.decision, 'allow');
  const output = result.output as {
    finalUrl: string;
    title: string;
    summary: string;
    fetchMode: string;
    rendered: boolean;
    artifactRef: string;
    artifactRefs: readonly string[];
  };
  assert.equal(output.finalUrl, 'https://example.com/final');
  assert.equal(output.title, 'Example');
  assert.equal(output.summary, 'full page content');
  assert.equal(output.fetchMode, 'http');
  assert.equal(output.rendered, false);
  assert.equal(output.artifactRef, 'local-web-artifact://web-id');
  assert.deepEqual(output.artifactRefs, [
    'local-web-artifact://web-id/content',
    'local-web-artifact://web-id/metadata',
  ]);
  assert.equal(
    await readFile(path.join(artifactRoot, '2026-07-23', 'web-id', 'content.txt'), 'utf8'),
    'full page content',
  );
});
