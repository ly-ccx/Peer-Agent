import assert from 'node:assert/strict';
import test from 'node:test';
import { automationOutcomeDecision, createAutomationOutcomeController } from './automation-outcome-controller.mjs';

const definition = (failures = 0, succeeded = false) => ({
  automationId: 'a1', name: 'Health check', consecutiveFailures: failures,
  notifications: { needsAttention: 'system_and_badge', failed: true, succeeded },
});

test('third consecutive failure pauses the definition', () => {
  assert.deepEqual(automationOutcomeDecision(definition(2), { status: 'failed' }), {
    failed: true, nextFailures: 3, autoPause: true, notify: true,
  });
});

test('success resets failures and only notifies when configured', () => {
  assert.equal(automationOutcomeDecision(definition(2), { status: 'succeeded' }).nextFailures, 0);
  assert.equal(automationOutcomeDecision(definition(2), { status: 'succeeded' }).notify, false);
  assert.equal(automationOutcomeDecision(definition(2, true), { status: 'succeeded' }).notify, true);
});

test('notification click returns to the exact run', () => {
  const patches = [];
  let click = null;
  let target = null;
  let shown = false;
  const store = {
    getDefinition: () => definition(0),
    updateDefinitionRuntimeFacts: (_id, patch) => patches.push(patch),
  };
  const controller = createAutomationOutcomeController({
    store,
    createNotification: () => ({ on: (_name, listener) => { click = listener; }, show: () => { shown = true; } }),
    openRun: (value) => { target = value; },
  });
  controller.handleRunUpdated({ automationId: 'a1', runId: 'r1', conversationId: 42, status: 'waiting_user', blockedReason: 'user_input' });
  assert.equal(shown, true);
  click();
  assert.deepEqual(target, { automationId: 'a1', runId: 'r1', conversationId: 42 });
  assert.deepEqual(patches, []);
});
