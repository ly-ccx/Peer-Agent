import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalStore, digestApprovalArgs } from './approval-store.mjs';
import { createImageReadAuthority, resolvePermissionPrincipal } from './permission-inheritance.mjs';
import { createOneTimeApprovalBook } from './one-time-approval.mjs';

test('one-time grants for two workspaces coexist, are isolated, consumed once and expire', () => {
  const book = createOneTimeApprovalBook({ ttlMs: 10 });
  const common = { capabilityId: 'local.file.read', argsDigest: digestApprovalArgs({ path: 'x' }), sessionId: 'same', at: 0 };
  for (const workspaceId of ['a', 'b']) book.remember({ ...common, workspaceId });
  assert.equal(book.match({ ...common, workspaceId: 'other', at: 1 }), false);
  for (const workspaceId of ['a', 'b']) assert.equal(book.match({ ...common, workspaceId, at: 1 }), true);
  assert.equal(book.match({ ...common, workspaceId: 'a', at: 1 }), false);
  book.remember({ ...common, workspaceId: 'a' });
  assert.equal(book.match({ ...common, workspaceId: 'a', at: 10 }), false);
});

test('old approval history, agent text and malformed resource records do not become image authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'image-grant-record-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createApprovalStore({ rootDir: root, compactBytes: 1 });
  const principal = { workspaceId: 'w', conversationId: 'bot' };
  const scope = { capabilityId: 'local.image.read', path: '/outside/a.png', workspacePath: '/repo', action: 'read_image_for_model',
    fileIdentity: { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 } };
  const record = { approvalId: 'a', workspaceId: 'w', conversationId: 'bot', capabilityId: 'local.image.read',
    state: 'approved', decidedBy: 'local_ui', decidedAt: new Date().toISOString() };
  store.append(record);
  const authority = createImageReadAuthority({ approvalStore: store });
  assert.equal(authority.match({ principal, scope, toolCallId: 'c' }), null);
  assert.equal(authority.remember({ principal, scope, record: { ...record, decidedBy: 'agent' } }), null);
  assert.equal(authority.remember({ principal, scope: { ...scope, fileIdentity: null }, record }), null);
  const grant = authority.remember({ principal, scope, record }); assert.ok(grant);
  assert.equal(createImageReadAuthority({ approvalStore: store }).match({ principal, scope, toolCallId: 'restart' }).grant.grantId, grant.grantId);
  assert.equal(authority.match({ principal, scope: { ...scope, action: 'write' }, toolCallId: 'c' }), null);
  authority.revokeAll();
  assert.equal(createImageReadAuthority({ approvalStore: store }).match({ principal, scope, toolCallId: 'restart' }), null);
});

test('delegated principals require intact ancestry, session identity and current host plan facts', () => {
  const plans = new Map([
    ['leaf', { status: 'running', conversationId: 'leaf-chat', delegationOrigin: { workspaceId: 'w', sessionId: 'leaf', parentConversationId: 'parent-chat' } }],
    ['parent', { status: 'running', conversationId: 'parent-chat', delegationOrigin: { workspaceId: 'w', sessionId: 'parent', parentConversationId: 'bot' } }],
  ]);
  const goalPlanStore = { getPlan: id => plans.get(id), getActivePlanByConversation: id => [...plans.values()].find(p => p.conversationId === id) };
  const input = { workspaceId: 'w', conversationId: 'leaf-chat', sessionId: 'leaf', planId: 'leaf', goalPlanStore };
  assert.deepEqual(resolvePermissionPrincipal(input), { workspaceId: 'w', conversationId: 'bot' });
  assert.equal(resolvePermissionPrincipal({ ...input, conversationId: 'other' }), null);
  assert.equal(resolvePermissionPrincipal({ ...input, sessionId: 'other' }), null);
  plans.get('parent').status = 'paused'; assert.equal(resolvePermissionPrincipal(input), null);
  plans.clear(); assert.equal(resolvePermissionPrincipal(input), null);
});

test('ordinary Goal authority stays in its host-owned conversation without delegated identity', () => {
  const goalPlanStore = { getPlan: () => ({ status: 'running', conversationId: 'goal-chat' }) };
  const input = { workspaceId: 'w', conversationId: 'goal-chat', planId: 'goal', goalPlanStore };
  assert.deepEqual(resolvePermissionPrincipal(input), { workspaceId: 'w', conversationId: 'goal-chat' });
  assert.equal(resolvePermissionPrincipal({ ...input, conversationId: 'other' }), null);
  assert.equal(resolvePermissionPrincipal({ ...input, conversationId: null }), null);
});
