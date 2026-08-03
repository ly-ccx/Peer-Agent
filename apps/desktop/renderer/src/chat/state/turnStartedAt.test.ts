import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTurnStartedAt } from './turnStartedAt.ts';

describe('resolveTurnStartedAt', () => {
  it('prefers an existing finite anchor', () => {
    const result = resolveTurnStartedAt({
      existing: 1_700_000_000_000,
      messages: [
        { role: 'user', timestamp: 1_700_000_000_100 },
        { role: 'assistant', timestamp: 1_700_000_000_200 },
      ],
      fallback: 1_700_000_000_300,
    });
    assert.equal(result, 1_700_000_000_000);
  });

  it('falls back to the last user message timestamp', () => {
    const result = resolveTurnStartedAt({
      existing: null,
      messages: [
        { role: 'user', timestamp: 100 },
        { role: 'assistant', timestamp: 200 },
        { role: 'user', timestamp: 300 },
        { role: 'assistant', timestamp: 400 },
      ],
      fallback: 999,
    });
    assert.equal(result, 300);
  });

  it('skips invalid user timestamps and uses fallback', () => {
    const result = resolveTurnStartedAt({
      existing: undefined,
      messages: [
        { role: 'user', timestamp: undefined },
        { role: 'assistant', timestamp: 50 },
      ],
      fallback: 777,
    });
    assert.equal(result, 777);
  });

  it('returns null when nothing is usable', () => {
    const result = resolveTurnStartedAt({
      existing: null,
      messages: [{ role: 'assistant', timestamp: 1 }],
      fallback: null,
    });
    assert.equal(result, null);
  });

  it('does not treat zero / non-finite existing as valid', () => {
    assert.equal(
      resolveTurnStartedAt({
        existing: 0,
        messages: [{ role: 'user', timestamp: 42 }],
      }),
      42,
    );
    assert.equal(
      resolveTurnStartedAt({
        existing: Number.NaN,
        fallback: 9,
      }),
      9,
    );
  });
});
