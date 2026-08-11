import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalIpcRegistrations } from './register-goal-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createGoalIpcRegistrations({
    goalPlans: {
      list: port('plans.list'),
      awaitingCounts: port('plans.awaitingCounts'),
      get: port('plans.get'),
      create: port('plans.create'),
      revise: port('plans.revise'),
      approve: port('plans.approve'),
      setStatus: port('plans.setStatus'),
      markRequestedUserInput: port('plans.markRequestedUserInput'),
      recordManualConfirmation: port('plans.recordManualConfirmation'),
      recordTaskEvidence: port('plans.recordTaskEvidence'),
      remove: port('plans.remove'),
    },
    goalRunner: {
      getState: port('runner.getState'),
      start: port('runner.start'),
      pause: port('runner.pause'),
      resume: port('runner.resume'),
      clear: port('runner.clear'),
    },
  });
  const handlers = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
    });
  }
  return { calls, handlers, owners };
}

test('goal owners register the exact 15 invoke channels', () => {
  const { handlers, owners } = createHarness();
  assert.deepEqual(owners, ['goalPlans-ipc', 'goalRunner-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'goalPlans:approve',
    'goalPlans:awaiting-counts',
    'goalPlans:create',
    'goalPlans:delete',
    'goalPlans:get',
    'goalPlans:list',
    'goalPlans:mark-requested-user-input',
    'goalPlans:record-manual-confirmation',
    'goalPlans:record-task-evidence',
    'goalPlans:revise',
    'goalPlans:set-status',
    'goalRunner:clear',
    'goalRunner:get-state',
    'goalRunner:pause',
    'goalRunner:resume',
    'goalRunner:start',
  ]);
});

test('goal handlers preserve payload defaults and return values', () => {
  const { calls, handlers } = createHarness();
  const payload = { planId: 'plan-1' };

  assert.equal(handlers.get('goalPlans:list')({}, payload), 'plans.list');
  assert.equal(handlers.get('goalPlans:awaiting-counts')({}), 'plans.awaitingCounts');
  assert.equal(handlers.get('goalPlans:get')({}, payload), 'plans.get');
  assert.equal(handlers.get('goalPlans:create')({}, payload), 'plans.create');
  assert.equal(handlers.get('goalPlans:revise')({}, payload), 'plans.revise');
  assert.equal(handlers.get('goalPlans:approve')({}, payload), 'plans.approve');
  assert.equal(handlers.get('goalPlans:set-status')({}, payload), 'plans.setStatus');
  assert.equal(
    handlers.get('goalPlans:mark-requested-user-input')({}, payload),
    'plans.markRequestedUserInput',
  );
  assert.equal(
    handlers.get('goalPlans:record-manual-confirmation')({}, payload),
    'plans.recordManualConfirmation',
  );
  assert.equal(handlers.get('goalPlans:record-task-evidence')({}, payload), 'plans.recordTaskEvidence');
  assert.equal(handlers.get('goalPlans:delete')({}, payload), 'plans.remove');
  assert.equal(handlers.get('goalRunner:get-state')({}, payload), 'runner.getState');
  assert.equal(handlers.get('goalRunner:start')({}, undefined), 'runner.start');
  assert.equal(handlers.get('goalRunner:pause')({}, payload), 'runner.pause');
  assert.equal(handlers.get('goalRunner:resume')({}, undefined), 'runner.resume');
  assert.equal(handlers.get('goalRunner:clear')({}, payload), 'runner.clear');

  assert.deepEqual(calls, [
    ['plans.list', payload],
    ['plans.awaitingCounts'],
    ['plans.get', payload],
    ['plans.create', payload],
    ['plans.revise', payload],
    ['plans.approve', payload],
    ['plans.setStatus', payload],
    ['plans.markRequestedUserInput', payload],
    ['plans.recordManualConfirmation', payload],
    ['plans.recordTaskEvidence', payload],
    ['plans.remove', payload],
    ['runner.getState', payload],
    ['runner.start', {}],
    ['runner.pause', payload],
    ['runner.resume', {}],
    ['runner.clear', payload],
  ]);
});
