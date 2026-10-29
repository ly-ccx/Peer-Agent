import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDelegatedPlanCatalog } from './delegated-plan-catalog.mjs';
import { createSessionReadQuery } from './session-read-query.mjs';
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createGoalPlanStore } from '../goal-plan-store.mjs';

function incrementalFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-plan-incremental-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plan = (id, delegated) => writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ planId: id,
    ...(delegated ? { delegationOrigin: { sessionId: id } } : {}) }));
  const journal = path.join(directory, '.changes.jsonl'), index = path.join(directory, 'index.jsonl');
  writeFileSync(journal, ''); writeFileSync(index, '');
  const catalog = createDelegatedPlanCatalog({ directory: () => directory, incremental: true, ...options,
    readPlan: id => JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')) });
  const changed = id => { appendFileSync(index, JSON.stringify({ planId: id }) + '\n'); appendFileSync(journal, JSON.stringify({ planId: id }) + '\n'); };
  return { directory, plan, journal, index, catalog, changed };
}

test('incremental discovery does not stat 1100 unchanged files and always reloads current candidates', t => {
  const f = incrementalFixture(t);
  for (let i = 0; i < 1100; i++) f.plan(String(i), i < 8);
  assert.equal(f.catalog.read().length, 8);
  let planStats = 0; const original = fs.statSync;
  t.mock.method(fs, 'statSync', (...args) => { if (String(args[0]).endsWith('.json')) planStats++; return original(...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let i = 0; i < 5; i++) assert.equal(f.catalog.read().length, 8);
  assert.equal(planStats, 0, 'warm discovery may not repeat the full filesystem inventory');
  f.plan('0', false); // Current known candidates still use getPlan, even without an invalidation hint.
  assert.equal(f.catalog.read().length, 7);
  f.plan('1099', true); f.changed('1099');
  assert.equal(f.catalog.read().length, 8);
  assert.ok(planStats <= 2, 'a valid journal append invalidates only the changed candidate');
});

test('incremental discovery falls back for an index update without a journal event', t => {
  const f = incrementalFixture(t); f.plan('a', false); assert.equal(f.catalog.read().length, 0);
  f.plan('a', true); appendFileSync(f.index, '{}\n');
  assert.equal(f.catalog.read().length, 1);
});

for (const mode of ['truncated', 'replaced', 'malformed', 'partial', 'oversized']) {
  test(`incremental discovery fully rechecks after a ${mode} change journal`, t => {
    const f = incrementalFixture(t); f.plan('a', false); f.changed('a'); assert.equal(f.catalog.read().length, 0);
    f.plan('a', true);
    if (mode === 'truncated') writeFileSync(f.journal, '');
    if (mode === 'replaced') { writeFileSync(path.join(f.directory, 'replacement'), '{}\n'); renameSync(path.join(f.directory, 'replacement'), f.journal); }
    if (mode === 'malformed') appendFileSync(f.journal, '{broken}\n');
    if (mode === 'partial') appendFileSync(f.journal, '{"planId":"a"');
    if (mode === 'oversized') appendFileSync(f.journal, ' '.repeat(1024 * 1024 + 1) + '\n');
    assert.equal(f.catalog.read().length, 1);
  });
}

test('legacy unjournaled edits are rechecked within five seconds; membership and roots are immediate', t => {
  let time = 0; const f = incrementalFixture(t, { now: () => time });
  f.plan('a', false); assert.equal(f.catalog.read().length, 0);
  f.plan('a', true); time = 5000; assert.equal(f.catalog.read().length, 1);
  f.plan('b', true); assert.equal(f.catalog.read().length, 2);
  rmSync(path.join(f.directory, 'b.json')); assert.equal(f.catalog.read().length, 1);
  const g = incrementalFixture(t); g.plan('other', true);
  let root = f.directory;
  const catalog = createDelegatedPlanCatalog({ directory: () => root, incremental: true,
    readPlan: id => JSON.parse(fs.readFileSync(path.join(root, id + '.json'), 'utf8')) });
  assert.deepEqual(catalog.read().map(p => p.planId), ['a']); root = g.directory;
  assert.deepEqual(catalog.read().map(p => p.planId), ['other']);
});

test('incremental discovery observes governed changes from another real store immediately', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-plan-stores-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const one = createGoalPlanStore({ storeDir: directory }), two = createGoalPlanStore({ storeDir: directory });
  const plan = one.createPlan({ title: 'ordinary', goal: 'ordinary' });
  const catalog = createDelegatedPlanCatalog({ directory: () => directory, incremental: true, readPlan: id => one.getPlan(id) });
  assert.equal(catalog.read().length, 0);
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'mp', family: 'f' };
  two.revisePlan(plan.planId, { delegationOrigin: { sessionId: 'new', workspaceId: 'w', parentConversationId: 'p', anchorMessageId: 'u', inputId: 'i',
    modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() }, phase: 'queued' } });
  assert.equal(catalog.read()[0]?.delegationOrigin.sessionId, 'new');
  two.deletePlan(plan.planId); assert.equal(catalog.read().length, 0);
});

test('incremental discovery with eviction still finds every current candidate', t => {
  const f = incrementalFixture(t, { maxEntries: 1 }); f.plan('a', true); f.plan('b', true);
  for (let i = 0; i < 3; i++) assert.equal(f.catalog.read().length, 2);
  f.plan('a', false); f.changed('a'); assert.deepEqual(f.catalog.read().map(p => p.planId), ['b']);
});

test('1100 historical plans hydrate only delegated candidates per synchronous query', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-plan-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let i = 0; i < 1100; i++) writeFileSync(path.join(directory, `${i}.json`), JSON.stringify({ planId: `${i}`,
    ...(i < 8 ? { delegationOrigin: { sessionId: `s${i}` } } : {}), tasks: [] }));
  let hydrated = 0, scans = 0;
  const catalog = createDelegatedPlanCatalog({ directory: () => directory,
    readPlan: id => { hydrated++; return { planId: id, delegationOrigin: { sessionId: `s${id}` }, runner: { turnCount: hydrated } }; } });
  const query = createSessionReadQuery();
  const read = () => query.memo('catalog', () => { scans++; return catalog.read(); });
  query.run(() => { for (let i = 0; i < 25; i++) assert.equal(read().length, 8); });
  assert.equal(hydrated, 8); assert.equal(scans, 1);
  const previous = query.run(read);
  previous[0].delegationOrigin.sessionId = 'caller mutation';
  const next = query.run(read);
  assert.equal(hydrated, 24);
  assert.notEqual(next[0].delegationOrigin.sessionId, 'caller mutation');
  assert.notEqual(next[0].runner.turnCount, previous[0].runner.turnCount, 'overlay and guards remain current');
});

test('catalog invalidates rewrite, replacement, deletion, corruption and bounded eviction', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-plan-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'a.json');
  const write = delegated => writeFileSync(target, JSON.stringify({ delegationOrigin: { sessionId: delegated ? 'yes' : '' } }));
  const catalog = createDelegatedPlanCatalog({ directory: () => directory, maxEntries: 1,
    readPlan: id => ({ planId: id, delegationOrigin: { sessionId: id } }) });
  write(false); assert.equal(catalog.read().length, 0);
  const info = statSync(target); write(true); utimesSync(target, info.atime, info.mtime);
  assert.equal(catalog.read().length, 1);
  writeFileSync(path.join(directory, 'replacement'), '{}'); renameSync(path.join(directory, 'replacement'), target);
  assert.equal(catalog.read().length, 0);
  write(true); writeFileSync(path.join(directory, 'b.json'), '{}'); assert.equal(catalog.read().length, 1);
  writeFileSync(target, '{broken'); assert.equal(catalog.read().length, 0);
  rmSync(target); assert.equal(catalog.read().length, 0);
  write(true); assert.equal(catalog.read().length, 1);
});

test('query releases observations after errors and shares nested synchronous reads only', () => {
  const query = createSessionReadQuery(); let loads = 0;
  const read = () => query.memo('value', () => ++loads);
  assert.equal(query.run(() => { assert.equal(read(), 1); return query.run(read); }), 1);
  assert.throws(() => query.run(() => { read(); throw Error('read failed'); }), /read failed/);
  assert.equal(query.run(read), 3);
  assert.throws(() => query.run(() => Promise.resolve()), /must_be_synchronous/);
  assert.equal(read(), 4, 'outside a query never retains a previous observation');
});
