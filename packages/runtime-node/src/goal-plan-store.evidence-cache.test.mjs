import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function fixture(t, withUi = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-evidence-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let valid = true;
  let authorityReads = 0;
  const identity = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
  const readUiDelivery = () => {
    authorityReads++;
    return { required: true, requirements: [identity],
      observations: [{ ...identity, requirementId: 'panel', artifactHash: 'hash', evidenceRef: 'image', admittedToRunId: 'review' }],
      judgments: valid ? [{ requirementId: 'panel', observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: 'passed' }] : [] };
  };
  const store = createGoalPlanStore({ storeDir: root, ...(withUi ? { readUiDelivery } : {}) });
  const file = path.join(root, 'evidence-index.jsonl');
  let id;
  if (withUi) {
    const plan = store.createGoalContract({ conversationId: 'c', goal: 'Inspect panel', tasks: [{ taskId: 'observe', title: 'Inspect panel' }] });
    id = plan.planId;
    store.setPlanStatus(id, 'executing');
    store.recordEvidenceRefs({ planId: id, conversationId: 'c', evidenceRefs: ['image', 'judgment'] });
    store.recordTaskEvidence(id, 'observe', { status: 'completed', evidenceRefs: ['image'] });
    assert.equal(store.getPlan(id).status, 'completed');
  }
  return { store, file, id, readUiDelivery, root, setValid: value => { valid = value; }, reads: () => authorityReads };
}
const line = evidenceRef => JSON.stringify({ evidenceRef, createdAt: '2026-09-21T00:00:00Z' }) + '\n';

test('unchanged Evidence JSONL is parsed once; every public result has independent nested objects', t => {
  const f = fixture(t);
  const record = { evidenceRef: 'cache-probe', createdAt: '2026-09-21T00:00:00Z', artifactRefs: ['artifact'], userArtifacts: [
    { kind: 'code-change', ref: 'code', label: 'code', preview: { kind: 'code', additions: 1, deletions: 0, diffLines: ['+original'] } },
    { kind: 'image', ref: 'image', label: 'image', preview: { kind: 'image', dataUrl: 'data:image/png;base64,YQ==', width: 1, height: 1 } },
  ] };
  writeFileSync(f.file, JSON.stringify(record) + '\n');
  const originalParse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', function (text, ...args) {
    if (String(text).includes('cache-probe')) parses++;
    return originalParse(text, ...args);
  });
  const first = f.store.listEvidenceIndex();
  first[0].evidenceRef = 'forged';
  first[0].artifactRefs.push('forged');
  first[0].userArtifacts[0].preview.diffLines[0] = '+forged';
  first[0].userArtifacts[1].preview.dataUrl = 'forged';
  first.push({ evidenceRef: 'forged' });
  assert.deepEqual(f.store.listEvidenceIndex(), [record]);
  assert.deepEqual(f.store.listEvidenceIndex(), [record]);
  assert.equal(parses, 1, 'unchanged index must not be reparsed on each overview read');
});

const changes = {
  append(f) { appendFileSync(f.file, line('added')); return true; },
  'same-size-restored-mtime'(f) {
    const before = statSync(f.file);
    const text = readFileSync(f.file, 'utf8');
    writeFileSync(f.file, text.replaceAll('"judgment"', '"revoked!"'));
    utimesSync(f.file, before.atime, before.mtime);
    assert.equal(statSync(f.file).size, before.size);
    return false;
  },
  'atomic-replacement'(f) {
    const before = statSync(f.file);
    writeFileSync(f.file + '.next', readFileSync(f.file, 'utf8').replaceAll('"judgment"', '"revoked!"'));
    utimesSync(f.file + '.next', before.atime, before.mtime);
    renameSync(f.file + '.next', f.file);
    return false;
  },
  delete(f) { unlinkSync(f.file); return false; },
  truncate(f) { writeFileSync(f.file, ''); return false; },
  corrupt(f) { writeFileSync(f.file, '{broken\n' + line('unrelated')); return false; },
  'other-plan'(f) { writeFileSync(f.file, ['image', 'judgment'].map(evidenceRef => JSON.stringify({ evidenceRef, planId: 'other', conversationId: 'c' }) + '\n').join('')); return false; },
  'other-conversation'(f) { writeFileSync(f.file, ['image', 'judgment'].map(evidenceRef => JSON.stringify({ evidenceRef, conversationId: 'other' }) + '\n').join('')); return false; },
};

// File change × live authority × cold/warm read. Neither a cached index nor a
// previously completed disk plan may override revocation or Evidence scope.
for (const [change, mutate] of Object.entries(changes)) {
  for (const valid of [true, false]) {
    for (const cache of ['cold', 'warm']) {
      test(`${change}/${valid ? 'valid' : 'revoked'}/${cache}/Evidence-remains-live`, t => {
        const f = fixture(t, true);
        const reader = createGoalPlanStore({ storeDir: f.root, readUiDelivery: f.readUiDelivery });
        if (cache === 'warm') assert.equal(reader.getPlan(f.id).status, 'completed');
        const remainsIndexed = mutate(f);
        f.setValid(valid);
        const before = f.reads();
        for (let i = 0; i < 2; i++) {
          assert.equal(reader.getPlan(f.id).status, valid && remainsIndexed ? 'completed' : 'executing');
        }
        assert.equal(f.reads(), before + 2, 'authority is called even when the index is unchanged');
        // Restoring valid evidence must recover without recreating the reader.
        writeFileSync(f.file, ['image', 'judgment'].map(evidenceRef => JSON.stringify({ evidenceRef, planId: f.id, conversationId: 'c' }) + '\n').join(''));
        f.setValid(true);
        assert.equal(reader.getPlan(f.id).status, 'completed');
        assert.equal(JSON.parse(readFileSync(path.join(f.root, `${f.id}.json`), 'utf8')).status, 'completed', 'read projections never rewrite history');
      });
    }
  }
}

test('same-process append and another store append are visible on the next read', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.listEvidenceIndex(), []);
  f.store.recordEvidenceRefs({ evidenceRefs: ['first'] });
  assert.deepEqual(f.store.listEvidenceIndex().map(r => r.evidenceRef), ['first']);
  f.store.recordEvidenceRefs({ evidenceRefs: ['second'] });
  const other = createGoalPlanStore({ storeDir: f.root });
  other.recordEvidenceRefs({ evidenceRefs: ['third'] });
  assert.deepEqual(f.store.listEvidenceIndex().map(r => r.evidenceRef), ['first', 'second', 'third']);
});
