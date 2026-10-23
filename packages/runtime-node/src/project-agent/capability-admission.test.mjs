import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDelegationCapabilities, validCapabilityRequirements } from './capability-admission.mjs';
import { capabilityDenial } from './capability-denial.mjs';
import { spawnIdentity } from './spawn-identity.mjs';

test('readonly Git observation uses structured capability and retains criteria when unavailable', () => {
  const input = { readOnly: true, requiredCapabilities: ['local.git.query'], successCriteria: [{ id: 'git', kind: 'model_review', description: '核验两仓未提交/未跟踪状态', requiredCapabilities: ['local.git.query'] }] };
  const before = JSON.stringify(input);
  assert.equal(evaluateDelegationCapabilities(input, ['local.git.query']).ok, true);
  const missing = evaluateDelegationCapabilities(input, ['local.file.read']);
  assert.equal(missing.error, 'delegation_capability_unavailable');
  assert.deepEqual(missing.diagnostic.missing, ['local.git.query']);
  assert.deepEqual(missing.diagnostic.criterionIds, ['git']);
  assert.equal(missing.diagnostic.userActionRequired, false); assert.equal(missing.diagnostic.retryable, false);
  assert.equal(JSON.stringify(input), before);
});
test('command criteria cannot be relabelled as read-only Git observations', () => {
  const result = evaluateDelegationCapabilities({ requiredCapabilities: ['local.git.query'], successCriteria: [
    { id: 'status', kind: 'command', description: 'git status', command: 'git status --porcelain' },
  ] }, ['local.git.query']);
  assert.deepEqual(result.diagnostic.missing, ['local.shell.exec']);
});
test('unknown inventory, declared unknown capability and invalid requirements are distinct', () => {
  const task = { requiredCapabilities: ['local.git.query'] };
  assert.equal(evaluateDelegationCapabilities(task, undefined).error, 'delegation_capability_unknown');
  assert.equal(evaluateDelegationCapabilities({ requiredCapabilities: ['local.missing.read'] }, []).error, 'delegation_capability_unavailable');
  for (const invalid of ['shell', ['bash'], ['local.git.query', 'local.git.query']]) assert.equal(validCapabilityRequirements(invalid), false);
});
test('admission errors do not claim OS failure or request elevated permission', () => {
  for (const stage of ['role', 'projection']) {
    const detail = capabilityDenial({ reason: 'project_agent_capability_denied', capabilityId: 'local.shell.exec', toolName: 'bash', stage, locale: 'zh-CN' });
    assert.equal(detail.diagnostic.stage, stage); assert.equal(detail.diagnostic.userActionRequired, false);
    assert.ok(detail.diagnostic.alternatives.includes('git_query'));
    assert.doesNotMatch(detail.message, /系统权限不足|机器没有|请.*授权/);
  }
});
test('mechanical task identity includes changed capability requirements', () => {
  const task = { readOnly: false, successCriteria: [{ kind: 'command', command: 'echo ok' }] };
  assert.notEqual(spawnIdentity('p', { ...task, requiredCapabilities: ['local.shell.exec'] }),
    spawnIdentity('p', { ...task, requiredCapabilities: ['local.shell.exec', 'local.git.query'] }));
});
