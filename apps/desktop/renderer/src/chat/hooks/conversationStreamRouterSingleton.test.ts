import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acquireStreamRouterLease,
  releaseStreamRouterLease,
} from '../state/conversationStreamRouterSingleton.ts';

describe('conversation stream router singleton lease', () => {
  it('lets the first owner occupy the lease', () => {
    assert.deepEqual(acquireStreamRouterLease(null, 'router-a'), {
      occupiedBy: 'router-a',
      acquired: true,
    });
  });

  it('rejects a second owner while the first is alive', () => {
    assert.deepEqual(acquireStreamRouterLease('router-a', 'router-b'), {
      occupiedBy: 'router-a',
      acquired: false,
    });
  });

  it('is idempotent for the same owner', () => {
    assert.deepEqual(acquireStreamRouterLease('router-a', 'router-a'), {
      occupiedBy: 'router-a',
      acquired: true,
    });
  });

  it('releases only the current owner', () => {
    assert.equal(releaseStreamRouterLease('router-a', 'router-b'), 'router-a');
    assert.equal(releaseStreamRouterLease('router-a', 'router-a'), null);
    assert.equal(releaseStreamRouterLease(null, 'router-a'), null);
  });
});
