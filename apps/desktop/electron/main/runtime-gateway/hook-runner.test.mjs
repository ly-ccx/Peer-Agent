import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookRunner, matchesHook, mostRestrictiveDecision } from './hook-runner.mjs';

test('matchesHook supports capability and argument patterns', () => {
  assert.equal(matchesHook(
    { match: { capabilityId: 'local.shell.exec', argumentsPattern: 'rm -rf*' } },
    { call: { capabilityId: 'local.shell.exec', arguments: { command: 'rm -rf /tmp/x' } } },
  ), true);
  assert.equal(matchesHook(
    { match: { capabilityId: 'local.shell.exec', argumentsPattern: 'rm -rf*' } },
    { call: { capabilityId: 'local.shell.exec', arguments: { command: 'echo ok' } } },
  ), false);
});

test('runPreToolUse reads stdout json decisions and short-circuits deny', async () => {
  const runner = createHookRunner({
    hooks: {
      PreToolUse: [
        {
          id: 'deny-hook',
          match: { capabilityId: 'local.shell.exec' },
          command: 'node -e "process.stdin.resume(); console.log(JSON.stringify({ decision: \'deny\', reason: \'blocked\' }))"',
          timeoutMs: 1000,
        },
        {
          id: 'should-not-run',
          match: { capabilityId: '*' },
          command: 'node -e "console.log(JSON.stringify({ decision: \'allow\' }))"',
          timeoutMs: 1000,
        },
      ],
    },
  });

  const records = await runner.runPreToolUse({
    call: { capabilityId: 'local.shell.exec', arguments: { command: 'rm -rf /tmp/x' } },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'deny-hook');
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].reason, 'blocked');
});

test('PreToolUse non-zero exit defaults to fail-closed deny', async () => {
  const runner = createHookRunner({
    hooks: {
      PreToolUse: [{ id: 'fail', match: { capabilityId: '*' }, command: 'node -e "process.exit(2)"', timeoutMs: 1000 }],
    },
  });

  const records = await runner.runPreToolUse({ call: { capabilityId: 'x', arguments: {} } });
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].outcome, 'non_zero_exit');
});

test('mostRestrictiveDecision returns deny before ask before allow', () => {
  assert.equal(mostRestrictiveDecision([{ decision: 'allow' }, { decision: 'ask' }]), 'ask');
  assert.equal(mostRestrictiveDecision([{ decision: 'ask' }, { decision: 'deny' }]), 'deny');
  assert.equal(mostRestrictiveDecision([]), 'allow');
});
