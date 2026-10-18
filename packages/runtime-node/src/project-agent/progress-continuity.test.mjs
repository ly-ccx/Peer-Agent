import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationDecision } from './continuation-policy.mjs';

test('alternating completed reads and same failure at different paths do not renew progress indefinitely', () => {
  for (const failed of [false, true]) {
    let previous = {}, stopped = false;
    for (let i = 0; i < 5; i++) {
      const result = failed ? { ok: false, error: 'permission_denied' } : { content: `same fact ${i % 2}` };
      const decision = continuationDecision({ previous, yielded: true,
        rounds: [{ toolCalls: [{ name: 'read_file', input: { path: failed ? `changed-${i}` : `same-${i % 2}` }, result }] }] });
      if (decision.end === 'no_progress') { assert.ok(i <= 3); stopped = true; break; }
      previous = structuredClone(decision);
    }
    assert.equal(stopped, true, 'no-progress boundary missing');
  }
});
