import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputPredictionSettings, isInputPredictionRequest, isInputPredictionReference } from './input-prediction.ts';

test('suggestions default on for both modes while preserving explicit opt-outs and failing closed on unknown settings', () => {
  assert.equal(normalizeInputPredictionSettings(null).enabled, true);
  assert.equal(normalizeInputPredictionSettings(undefined).continuationEnabled, true);
  assert.equal(normalizeInputPredictionSettings({ enabled: true }).continuationEnabled, true);
  assert.equal(normalizeInputPredictionSettings({ enabled: false }).enabled, false);
  assert.equal(normalizeInputPredictionSettings({ enabled: false, continuationEnabled: true }).continuationEnabled, false);
  assert.equal(normalizeInputPredictionSettings({ enabled: true, continuationEnabled: false }).continuationEnabled, false);
  assert.equal(normalizeInputPredictionSettings({ schemaVersion: 2, enabled: true, continuationEnabled: true }).enabled, false);
  assert.equal(normalizeInputPredictionSettings({ schemaVersion: 2 }).continuationEnabled, false);
  for (const value of [[], 'invalid', false, { enabled: 'true' }]) {
    assert.equal(normalizeInputPredictionSettings(value).enabled, false);
  }
  assert.equal(normalizeInputPredictionSettings({ dailyRequestLimit: -1 }).dailyRequestLimit, 100);
});
test('IPC accepts only bounded collapsed-end input and bounded owner references', () => {
  const request = { requestId: 'r', composerInstanceId: 'i', workspaceId: 'w', conversationId: 'c', surface: 'desktop_bot',
    mode: 'continuation', draftText: '请', draftVersion: 1, selectionStart: 1, selectionEnd: 1 };
  assert.ok(isInputPredictionRequest(request));
  for (const patch of [{ selectionStart: 0 }, { mode: 'next_turn' }, { surface: 'quick_chat' },
    { draftText: 'a'.repeat(2049), selectionStart: 2049, selectionEnd: 2049 }, { draftVersion: NaN }]) {
    assert.equal(isInputPredictionRequest({ ...request, ...patch }), false);
  }
  for (const value of [null, {}, { requestId: [], composerInstanceId: 'i' }, { requestId: 'x'.repeat(201), composerInstanceId: 'i' }]) assert.equal(isInputPredictionReference(value), false);
  assert.ok(isInputPredictionReference({ requestId: 'r', composerInstanceId: 'i', candidateId: 'c' }));
});
