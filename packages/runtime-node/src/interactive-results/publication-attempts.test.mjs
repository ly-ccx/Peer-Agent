import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createInteractiveResultStore } from './store.mjs';

test('fresh store instances retain preparation identity, active candidate and repair budget; corruption never resets them', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-interactive-attempts-'));
  const options = { rootDir: root, assertCompatibility: () => true };
  const first = createInteractiveResultStore(options), second = createInteractiveResultStore(options);
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const input = toolCallId => ({ callRef: { owner, conversationId: 'child-a', toolCallId },
    source: { conversationId: 'child-a', planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId },
    draft: { publication: { kind: 'create' }, title: 'Candidate', textFallback: 'Assumption', program: 'root=Unknown()', inputs: [] } });
  const a = input('attempt-a');
  first.beginAttempt(a, () => true);
  assert.equal(second.getAttempt(a.callRef).phase, 'prepared');
  assert.throws(() => second.beginAttempt(a, () => true), { code: 'publication_unknown' });
  assert.throws(() => second.beginAttempt(input('other-concurrent'), () => true), { code: 'publication_preparation_pending' });
  assert.throws(() => second.beginAttempt({ ...a, draft: { ...a.draft, title: 'changed' } }, () => true), { code: 'publication_parameter_conflict' });
  first.finishAttempt(a.callRef, { code: 'unsupported_node', contentFailure: true });
  for (const id of ['repair-one', 'repair-two']) {
    const current = input(id); second.beginAttempt(current, () => true);
    second.finishAttempt(current.callRef, { code: 'unsupported_node', contentFailure: true });
  }
  assert.throws(() => first.beginAttempt(input('repair-three'), () => true), { code: 'interactive_repair_limit' });
  const db = first.storage.connect(owner.workspaceId, true).db;
  db.prepare('UPDATE publication_candidates SET failures=?').run(999);
  assert.throws(() => second.beginAttempt(input('corrupt-budget'), () => true), { code: 'interactive_storage_corrupt' });
  const saved = first.getAttempt(a.callRef);
  db.prepare('UPDATE attempts SET body=? WHERE id=(SELECT id FROM attempts LIMIT 1)').run(JSON.stringify({ ...saved, callRef: { ...saved.callRef, conversationId: 'foreign' } }));
  assert.throws(() => second.getAttempt(a.callRef), { code: 'interactive_storage_corrupt' });
});
