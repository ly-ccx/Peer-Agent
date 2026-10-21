import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotAccessPolicyState, type AccessControlSnapshot } from './botAccessPolicyState.ts';
import type { BotAccessPolicyResult } from '@peer-agent/protocol';

const view = (revision = 1, accessLevel: 'full_local' | 'ask_before_local' = 'ask_before_local'): BotAccessPolicyResult => ({ ok: true, inherited: false,
  policy: { workspaceId: 'a', conversationId: 'bot-a', revision, accessLevel, source: 'local_ui', updatedAt: '2026-10-21T00:00:00Z' } });

test('display changes only after the host saves; duplicate submits and failed optimistic Full are prevented', async () => {
  let snapshot: AccessControlSnapshot | undefined, finish!: (value: BotAccessPolicyResult) => void, writes = 0;
  const state = createBotAccessPolicyState({ request: { workspaceId: 'a' }, read: async () => view(),
    write: () => { writes++; return new Promise(resolve => { finish = resolve; }); }, publish: next => { snapshot = next; } });
  await state.refresh(); const saving = state.save('full_local'); await state.save('full_local');
  assert.equal(writes, 1); assert.equal(snapshot?.view?.policy?.accessLevel, 'ask_before_local'); assert.equal(snapshot?.busy, true);
  finish({ ok: false, code: 'POLICY_UNAVAILABLE' }); await saving;
  assert.equal(snapshot?.error, true); assert.equal(snapshot?.view?.policy?.accessLevel, 'ask_before_local');
});

test('CAS conflict displays current host policy and a later retry succeeds', async () => {
  let snapshot: AccessControlSnapshot | undefined, fail = true;
  const state = createBotAccessPolicyState({ request: { workspaceId: 'a' }, read: async () => view(),
    write: async () => fail ? { ok: false, code: 'POLICY_CONFLICT', policy: (view(2) as any).policy } : view(3, 'full_local'),
    publish: next => { snapshot = next; } });
  await state.refresh(); await state.save('full_local'); assert.equal(snapshot?.view?.policy?.revision, 2);
  fail = false; await state.save('full_local'); assert.equal(snapshot?.error, false); assert.equal(snapshot?.view?.policy?.revision, 3);
});

test('switching Bot ignores late reads and saves; inherited tasks cannot mutate policy', async () => {
  const updates: AccessControlSnapshot[] = [];
  let finish!: (value: BotAccessPolicyResult) => void, writes = 0;
  const old = createBotAccessPolicyState({ request: { workspaceId: 'a' }, read: () => new Promise(resolve => { finish = resolve; }), write: async () => { writes++; return view(); }, publish: state => updates.push(state) });
  const reading = old.refresh(); old.stop(); finish(view()); await reading; assert.equal(updates.length, 0);
  const child = createBotAccessPolicyState({ request: { conversationId: 'child' }, read: async () => ({ ...view(), inherited: true } as BotAccessPolicyResult), write: async () => { writes++; return view(); }, publish() {} });
  await child.refresh(); await child.save('full_local'); assert.equal(writes, 0);
});

test('a host change received during save is refreshed after an older write receipt arrives', async () => {
  let snapshot: AccessControlSnapshot | undefined, finish!: (value: BotAccessPolicyResult) => void;
  let latest = view();
  const state = createBotAccessPolicyState({ request: { workspaceId: 'a' }, read: async () => latest,
    write: () => new Promise(resolve => { finish = resolve; }), publish: next => { snapshot = next; } });
  await state.refresh();
  const saving = state.save('full_local');
  latest = view(3);
  await state.refresh();
  finish(view(2, 'full_local')); await saving;
  assert.equal(snapshot?.busy, false);
  assert.equal(snapshot?.view?.policy?.revision, 3);
  assert.equal(snapshot?.view?.policy?.accessLevel, 'ask_before_local');
});
