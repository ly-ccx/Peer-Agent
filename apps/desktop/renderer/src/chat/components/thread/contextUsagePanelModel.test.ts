import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveContextUsagePanelModel } from './contextUsagePanelModel.ts';

describe('resolveContextUsagePanelModel', () => {
  it('renders the snapshot breakdown without inventing extra categories', () => {
    const model = resolveContextUsagePanelModel({
      percent: 86,
      usedTokens: 220_100,
      contextWindow: 256_000,
      breakdown: {
        version: 1,
        quality: 'scaled',
        estimatedTokens: 220_100,
        categories: [
          { id: 'system_prompt', tokens: 1_400 },
          { id: 'conversation', tokens: 218_700 },
        ],
      },
      isZh: false,
    });

    assert.equal(model.title, 'Context Usage');
    assert.equal(model.statusLabel, '86% Full');
    assert.match(model.tokenLabel, /220\.1k \/ 256\.0k/i);
    assert.deepEqual(model.rows.map((row) => row.id), ['system_prompt', 'conversation']);
    assert.ok(model.unusedRatio > 0.1 && model.unusedRatio < 0.2);
  });

  it('falls back to a single used row when the snapshot has no composition', () => {
    const model = resolveContextUsagePanelModel({
      percent: 12,
      usedTokens: 12_000,
      contextWindow: 100_000,
      breakdown: null,
      isZh: true,
    });

    assert.equal(model.title, '上下文用量');
    assert.equal(model.statusLabel, '已用 12%');
    assert.deepEqual(model.rows.map((row) => row.label), ['已用上下文']);
  });

  it('keeps pending copy when occupancy has never been measured', () => {
    const model = resolveContextUsagePanelModel({
      percent: null,
      usedTokens: null,
      contextWindow: 256_000,
      breakdown: null,
      isZh: false,
    });

    assert.equal(model.statusLabel, 'Pending');
    assert.equal(model.tokenLabel, 'Pending');
    assert.deepEqual(model.rows, []);
  });
});
