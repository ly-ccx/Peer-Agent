import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceEditIpcRegistrations } from './register-resource-edit-ipc.mjs';
import { getDesktopIpcPolicy } from '../../ipc/channels.mjs';
test('intent and explicit submission routes retain actual sender and app-origin/top-frame policy; no raw execution/fact/Grant transport is exposed', () => {
  const calls = [], methods = ['open', 'resume', 'cancelOpen', 'read', 'acquire', 'save', 'discard', 'close', 'list', 'history', 'readSnapshot', 'cleanup', 'archive', 'clearDelivery'];
  const edits = Object.fromEntries([...methods, 'dispose'].map(name => [name, (...args) => { calls.push({ name, args }); return { ok: true }; }]));
  const submissionMethods = ['submit', 'continueSubmission', 'operationStatus', 'reconcileSubmission', 'cancelSubmission', 'decideSubmissionPermission', 'readExecution', 'readSubmission'];
  const submissions = Object.fromEntries(submissionMethods.map(name => [name, (...args) => { calls.push({ name, args }); return { ok: true }; }]));
  const [registration] = createResourceEditIpcRegistrations({ edits, submissions }), handlers = new Map();
  const dispose = registration.register({ handle: (key, callback) => handlers.set(key, callback) }); assert.equal(handlers.size, methods.length + submissionMethods.length);
  const sender = {}, payload = { handle: {}, sender: 'forged' }; handlers.get('resource-edit:save')({ sender }, payload);
  assert.equal(calls[0].args[0], sender); assert.equal(calls[0].args[1], payload);
  for (const channel of ['submit', 'continue-submission', 'operation-status', 'reconcile-submission', 'cancel-submission', 'decide-submission-permission', 'execution', 'submission']) {
    handlers.get(`resource-edit:${channel}`)({ sender }, payload); assert.equal(calls.at(-1).args[0], sender); assert.equal(calls.at(-1).args[1], payload);
  }
  for (const key of handlers.keys()) { const policy = getDesktopIpcPolicy(key); assert.deepEqual(policy.allowedWindowRoles, ['main', 'resource']); assert.equal(policy.originPolicy, 'app-origin'); assert.equal(policy.framePolicy, 'top-frame'); }
  assert.equal(getDesktopIpcPolicy('resource-edit:start'), null); assert.equal(getDesktopIpcPolicy('resource-edit:settle'), null); assert.equal(getDesktopIpcPolicy('resource-edit:retain-delivery'), null);
  dispose(); assert.equal(calls.at(-1).name, 'dispose');
});
