import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROJECT_AGENT_ALLOWED_CAPABILITIES,
  evaluateProjectAgentTurn,
  isProjectAgentCapabilityAllowed,
  isProjectAgentDeniedPermissionKind,
  isProjectAgentTurn,
} from './mode-policy.mjs';

test('project agent whitelist is the read capabilities plus delegation', () => {
  assert.deepEqual(PROJECT_AGENT_ALLOWED_CAPABILITIES, [
    'local.file.list',
    'local.file.read',
    'local.file.search',
    'local.search.aggregate',
    'local.delegation.spawn_session',
    'local.delegation.list_sessions',
    'local.delegation.get_session',
    'local.delegation.cancel_session',
    'local.delegation.message_session',
    'local.delegation.post_reply',
  ]);
  for (const capabilityId of PROJECT_AGENT_ALLOWED_CAPABILITIES) {
    assert.equal(isProjectAgentCapabilityAllowed(capabilityId), true);
  }
  assert.equal(isProjectAgentCapabilityAllowed('local.file.write'), false);
  assert.equal(isProjectAgentCapabilityAllowed('local.shell.exec'), false);
  assert.equal(isProjectAgentCapabilityAllowed('legacy.local.file.read'), false);
});

test('only an explicit project_agent mode or role enters the gate', () => {
  assert.equal(isProjectAgentTurn({ mode: 'project_agent' }), true);
  assert.equal(isProjectAgentTurn({ role: 'project_agent' }), true);
  assert.equal(isProjectAgentTurn({ mode: 'chat', role: 'goal_runner' }), false);
  assert.equal(isProjectAgentTurn({}), false);
});

test('chat, plan, and goal turns are not judged by the project agent whitelist', () => {
  for (const mode of ['chat', 'plan', 'goal', 'explorer']) {
    assert.deepEqual(
      evaluateProjectAgentTurn({ mode, capabilityId: 'local.file.write', permissionKind: 'file-write' }),
      { applies: false, allowed: true },
    );
  }
});

test('a project agent turn denies capabilities outside the whitelist', () => {
  const decision = evaluateProjectAgentTurn({
    mode: 'project_agent',
    capabilityId: 'local.file.write',
    permissionKind: 'file-write',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'project_agent_capability_denied');
  assert.equal(decision.accessLevel, 'restricted_local');
});

test('role project_agent denies writes even when the chat mode argument is unchanged', () => {
  const decision = evaluateProjectAgentTurn({
    mode: 'chat',
    role: 'project_agent',
    capabilityId: 'local.shell.exec',
    permissionKind: 'shell',
  });
  assert.equal(decision.applies, true);
  assert.equal(decision.reason, 'project_agent_capability_denied');
});

test('a whitelisted capability with a write, shell, or browser kind is still denied', () => {
  assert.equal(isProjectAgentDeniedPermissionKind('file-write'), true);
  assert.equal(isProjectAgentDeniedPermissionKind('shell'), true);
  assert.equal(isProjectAgentDeniedPermissionKind('browser-control'), true);
  assert.equal(isProjectAgentDeniedPermissionKind('browser-reveal'), true);
  assert.equal(isProjectAgentDeniedPermissionKind('file-read'), false);

  const decision = evaluateProjectAgentTurn({
    mode: 'project_agent',
    capabilityId: 'local.file.read',
    permissionKind: 'shell',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.detail, 'permission_kind');
  assert.equal(decision.reason, 'project_agent_capability_denied');
});

test('read capabilities are allowed at restricted_local', () => {
  for (const capabilityId of PROJECT_AGENT_ALLOWED_CAPABILITIES) {
    const decision = evaluateProjectAgentTurn({
      mode: 'project_agent',
      capabilityId,
      permissionKind: 'file-read',
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.accessLevel, 'restricted_local');
  }
});
