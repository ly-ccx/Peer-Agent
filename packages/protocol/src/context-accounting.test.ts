import assert from 'node:assert/strict';
import test from 'node:test';

import { contextAccountingModelKey } from './context-accounting.ts';

test('context accounting model identity is canonical across Desktop and TUI bindings', () => {
  assert.equal(
    contextAccountingModelKey('provider-a', 'grok-4.5'),
    'provider-a::grok-4.5',
  );
  assert.equal(
    contextAccountingModelKey('provider-a::grok-4.5', 'grok-4.5'),
    'provider-a::grok-4.5',
  );
});
