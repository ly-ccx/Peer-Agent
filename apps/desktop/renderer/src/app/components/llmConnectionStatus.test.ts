import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aggregateGroupConnectionState, modelConnectionBadge } from './llmConnectionStatus.ts';

describe('aggregateGroupConnectionState', () => {
  it('returns available when every model is available', () => {
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'available' },
        { connectionState: 'available' },
      ]),
      'available',
    );
  });

  it('returns unavailable only when every active model is unavailable', () => {
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'unavailable' },
        { connectionState: 'unavailable' },
      ]),
      'unavailable',
    );
  });

  it('does not report unavailable when the first model failed and another is available', () => {
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'unavailable' },
        { connectionState: 'available' },
      ]),
      'partial',
    );
  });

  it('does not report unavailable when the first model failed and another is untested', () => {
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'unavailable' },
        {},
      ]),
      'partial',
    );
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'unavailable' },
        { connectionState: 'pending_verification' },
      ]),
      'partial',
    );
  });

  it('classifies mixed available and unavailable as partial', () => {
    assert.equal(
      aggregateGroupConnectionState([
        { connectionState: 'available' },
        { connectionState: 'unavailable' },
      ]),
      'partial',
    );
  });
});

describe('modelConnectionBadge', () => {
  it('marks unavailable models with a bad badge', () => {
    assert.deepEqual(modelConnectionBadge('unavailable', true), {
      text: '不可用',
      tone: 'bad',
    });
  });

  it('marks needs_attention models with a warn badge', () => {
    assert.deepEqual(modelConnectionBadge('needs_attention', true), {
      text: '需要操作',
      tone: 'warn',
    });
  });

  it('does not mark available models', () => {
    assert.equal(modelConnectionBadge('available', true), null);
  });

  it('does not mark untested models', () => {
    assert.equal(modelConnectionBadge(undefined, true), null);
    assert.equal(modelConnectionBadge('pending_verification', true), null);
    assert.equal(modelConnectionBadge('draft', true), null);
  });
});
