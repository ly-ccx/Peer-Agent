import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDelegatedPlanCatalog } from './delegated-plan-catalog.mjs';
import { createSessionReadQuery } from './session-read-query.mjs';

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
