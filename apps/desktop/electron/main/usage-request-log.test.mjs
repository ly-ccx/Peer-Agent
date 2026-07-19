import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUsageRequestLog } from './usage-request-log.mjs';

test('default log file resolves under the registered data home', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-request-log-default-'));
  const previousDataHome = process.env.PEER_AGENT_HOME;

  try {
    process.env.PEER_AGENT_HOME = dir;
    const log = createUsageRequestLog();
    assert.equal(log.logFile, path.join(dir, 'usage', 'requests.jsonl'));
  } finally {
    if (previousDataHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousDataHome;
  }
});

test('appendUsageRequestLog writes request snapshot with estimated cost', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-request-log-'));
  const logFile = path.join(dir, 'requests.jsonl');
  const log = createUsageRequestLog({ logFile });

  const record = log.append({
    id: 'req-1',
    conversationId: 'conv-1',
    streamId: 'stream-1',
    modelProviderId: 'openai::gpt-4o',
    model: 'gpt-4o',
    providerName: 'OpenAI',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    pricing: {
      inputPrice: 2.5,
      outputPrice: 10,
    },
    pricingSource: 'models.dev-reference',
  });

  assert.equal(record.inputTokens, 1_000_000);
  assert.ok(Math.abs(record.estimatedCostUsd - 2.5) < 1e-9);

  const lines = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const saved = JSON.parse(lines[0]);
  assert.equal(saved.modelProviderId, 'openai::gpt-4o');
  assert.equal(saved.model, 'gpt-4o');
  assert.equal(saved.conversationId, 'conv-1');
});

test('readAll returns trailing entries', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-request-log-'));
  const logFile = path.join(dir, 'requests.jsonl');
  const log = createUsageRequestLog({ logFile });
  log.append({ id: 'a', model: 'm1', usage: { inputTokens: 1 } });
  log.append({ id: 'b', model: 'm2', usage: { inputTokens: 2 } });
  const rows = log.readAll({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, 'b');
});
