import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createUsageRequestLog } from '../usage-request-log.mjs';
import { createInputPredictionBudget } from './usage-budget.mjs';

function setup(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'requests.jsonl'), log = createUsageRequestLog({ logFile: file });
  const budget = createInputPredictionBudget({ log });
  const input = { id: 'untrusted-repeated-id', tokens: 4224,
    workspaceId: 'w', conversationId: 'c', settings: { dailyRequestLimit: 100, dailyTokenLimit: 100_000 },
    route: { provider: { id: 'p', model: 'fast-model', inputPrice: 1, outputPrice: 1 }, routing: {} } };
  return { directory, file, log, budget, input };
}

test('durable reservations survive restart and settlements count each prediction only once', t => {
  const f = setup(t), reservation = f.budget.reserve(f.input);
  assert.ok(reservation); assert.equal(f.budget.summary().tokens, 4224);
  const restarted = createInputPredictionBudget({ log: createUsageRequestLog({ logFile: f.file }) });
  assert.equal(restarted.summary().requests, 1); assert.equal(restarted.summary().estimated, true);
  f.budget.settle(reservation, { inputTokens: 20, outputTokens: 10 });
  assert.equal(restarted.summary().tokens, 30); assert.equal(restarted.summary().requests, 1);
  assert.equal(f.log.readAll().length, 1); assert.equal(f.log.readAll()[0].usageScope, 'provider_request');
  assert.equal(f.log.readAll()[0].usageIsEstimate, false);
});

test('cancelled or missing usage stays conservative; observed partial usage may only raise the estimate', t => {
  const f = setup(t), reservation = f.budget.reserve(f.input);
  f.budget.settle(reservation, { inputTokens: 8, outputTokens: 0 }, { complete: false });
  assert.equal(f.budget.summary().tokens, 4224); assert.equal(f.budget.summary().estimated, true);
  f.budget.settle(reservation, { inputTokens: 6000, outputTokens: 200 }, { complete: false });
  assert.equal(f.budget.summary().tokens, 6200);
});

test('request ids cannot reset counters; caps aggregate across workspaces and reject zero or unknown spend', t => {
  const f = setup(t);
  const settings = { dailyRequestLimit: 1, dailyTokenLimit: 100_000 };
  assert.ok(f.budget.reserve({ ...f.input, settings }));
  assert.equal(f.budget.reserve({ ...f.input, settings, workspaceId: 'another' }), null);
  assert.equal(f.budget.reserve({ ...f.input, settings: { ...settings, dailyRequestLimit: 0 } }), null);
  assert.equal(f.budget.reserve({ ...f.input, route: { provider: { id: 'unknown-price' }, routing: { dailySpendCapUsd: 1 } } }), null);
});

test('a corrupt usage record fails closed and raw request or draft data is not persisted', t => {
  const f = setup(t);
  f.budget.reserve({ ...f.input, draft: 'unsent-secret', messages: ['private-history'] });
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /unsent-secret|private-history/);
  appendFileSync(f.file, 'corrupt-record\n');
  assert.equal(f.budget.reserve(f.input), null); assert.equal(f.budget.summary().complete, false);
});
