import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCoordinationSnapshot } from './coordination-snapshot.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE objects(bucket TEXT,id TEXT,value TEXT);CREATE TABLE meta(id TEXT,value TEXT);CREATE TABLE observations(workId TEXT,id TEXT)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('revision', '14');
  const insert = (bucket, id, value) => db.prepare('INSERT INTO objects VALUES (?,?,?)').run(bucket, id, JSON.stringify(value));
  insert('works', 'w', { state: 'blocked_system', stopScope: 'work', intentCoordination: { lifecycle: 'active' }, body: 'private body' });
  insert('mandates', 'w', { workId: 'w', sessionIds: ['s'] });
  insert('transitions', 't', { phase: 'awaiting_outcome' });
  insert('decisions', 'd', { operationId: 'd' });
  insert('sessionControlHeads', 's', { operationId: 'current' });
  insert('sessionControls', 'current', { phase: 'reconciling' });
  insert('sessionControls', 'older', { phase: 'settled' });
  return { db, port: createCoordinationSnapshot(db) };
}

test('lifecycle facts preserve current source fields and decode fresh work state without bodies', () => {
  const { port } = fixture();
  try {
    const first = port.readLifecycleFacts();
    assert.equal(first.revision, 14);
    assert.deepEqual(first.workStates.w, { state: 'blocked_system', stopScope: 'work', intentCoordination: { lifecycle: 'active' } });
    first.workStates.w.intentCoordination.lifecycle = 'changed';
    assert.equal(port.readLifecycleFacts().workStates.w.intentCoordination.lifecycle, 'active');
    assert.equal(JSON.stringify(first).includes('private body'), false);
  } finally { port.close(); }
});

test('receipt reads retain obligations and observation facts without aliasing the normal snapshot', () => {
  const { db, port } = fixture();
  db.prepare('INSERT INTO objects VALUES (?,?,?)').run('obligationHeads', 's', JSON.stringify('head'));
  db.prepare('INSERT INTO objects VALUES (?,?,?)').run('obligationDispositions', 'head', JSON.stringify({ phase: 'indexed' }));
  db.prepare('UPDATE objects SET value=? WHERE bucket=?').run(JSON.stringify({ state: 'blocked_system', budget: {} }), 'works');
  db.prepare('INSERT INTO observations VALUES (?,?)').run('w', 'observed');
  try {
    assert.equal(port.read().obligationDispositions[port.read().obligationHeads.s].phase, 'indexed');
    assert.equal(port.read().works.w.budget.observations.observed, true);
    assert.equal(port.readSnapshot().works.w.budget.observations, undefined);
    assert.equal(port.read(), port.read());
    assert.throws(() => { port.read().obligationHeads.s = 'changed'; }, TypeError);
  } finally { port.close(); }
});

test('control follows the explicit head and never infers settlement from an older receipt', () => {
  const { port } = fixture();
  try { assert.equal(port.readSessionControl('s').phase, 'reconciling'); assert.equal(port.readSessionControl('missing'), undefined); }
  finally { port.close(); }
});

test('cached snapshot is immutable and the read port has no writer authority', () => {
  const { port } = fixture();
  try {
    assert.throws(() => { port.readSnapshot().works.w.state = 'delivered'; }, TypeError);
    assert.equal(port.readSnapshot().works.w.state, 'blocked_system');
    assert.throws(() => port.assertOwner(), /no_writer_authority/);
  } finally { port.close(); }
});

test('damaged JSON is an explicit failure, not successful empty lifecycle facts', () => {
  const { db, port } = fixture();
  try { db.exec("UPDATE objects SET value='{' WHERE bucket='works'"); assert.throws(() => port.readLifecycleFacts(), SyntaxError); }
  finally { port.close(); }
});
