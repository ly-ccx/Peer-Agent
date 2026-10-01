import assert from 'node:assert/strict';
import test from 'node:test';
import { verifierEvidenceSnapshots } from './verifier-evidence.mjs';

test('verifier snapshots require referenced, project-scoped indexed bodies and share a total budget', () => {
  const refs = ['a', 'b', 'c', 'd'];
  const plan = { planId: 'p1', conversationId: 'c1', tasks: [{ subtasks: [{ evidenceRefs: refs }] }] };
  const record = (ref, extra = {}) => ({ evidenceRef: ref, planId: 'p1', toolName: 'read_file',
    bodyPreview: { kind: 'file', text: ref.repeat(4000), truncated: false }, ...extra });
  const snapshots = verifierEvidenceSnapshots(plan, [record('a'), record('b'), record('c'), record('d'),
    record('unreferenced'), record('a', { planId: 'foreign', conversationId: 'foreign' })]);
  assert.deepEqual(snapshots.map(row => row.evidenceRef), ['a', 'b', 'c']);
  assert.equal(snapshots.reduce((sum, row) => sum + row.text.length, 0), 12000);
  assert.equal(verifierEvidenceSnapshots(plan, [record('a', { bodyPreview: undefined })]).length, 0);
  assert.equal(verifierEvidenceSnapshots(plan, [record('a', { bodyPreview: { kind: 'file', text: 'short', truncated: true } })])[0].truncated, true);
});
