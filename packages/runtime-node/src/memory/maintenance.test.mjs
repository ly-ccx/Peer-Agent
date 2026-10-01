import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMemoryStore } from './memory-store.mjs';
import { createMemoryMaintenance } from './maintenance.mjs';

test('daily pure maintenance expires old preferences and deadlines, protects pins/duties and marks changed anchors', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-memory-maintenance-'));
  let clock = new Date('2026-06-01T10:00:00Z'), hash = 'a';
  const store = createMemoryStore({ rootDir, now: () => clock });
  const stated = extra => store.rememberStated({ workspaceId: 'w', kind: 'fact', text: 'fact', anchorMessageId: 'u', messages: [{ id: 'u', role: 'user' }], ...extra }).item;
  try {
    const deadline = stated({ expiresAt: '2026-07-01T00:00:00Z' });
    const pinned = stated({ pinned: true, expiresAt: '2026-07-01T00:00:00Z' });
    const duty = stated({ kind: 'responsibility', expiresAt: '2026-07-01T00:00:00Z' });
    const pref = store.writeCurated({ kind: 'preference', trust: 'inferred', text: 'brief', confirmedCount: 3, sourceRefs: ['e1', 'e2', 'e3'] }).item;
    const fact = store.writeVerified({ workspaceId: 'w', kind: 'fact', text: 'file fact', sourceRefs: ['ev'], fileAnchors: [{ path: 'src/main.ts', contentHash: 'a', commit: 'c1' }] }).item;
    clock = new Date('2026-10-01T10:00:00Z');
    const maintenance = createMemoryMaintenance({ rootDir: path.join(rootDir, 'device'), store, readAnchor: () => ({ contentHash: hash, commit: 'c2' }) });
    hash = 'b';
    const first = maintenance.runDue({ workspaceId: 'w', at: clock, digestTime: '00:00' });
    assert.equal(first.changedIds.length, 3); assert.equal(store.get(deadline.id).status, 'expired');
    assert.equal(store.get(pref.id).status, 'expired'); assert.equal(store.get(pinned.id).status, 'active'); assert.equal(store.get(duty.id).status, 'active');
    assert.equal(store.get(fact.id).needsReverify, true);
    assert.equal(maintenance.runDue({ workspaceId: 'w', at: clock, digestTime: '00:00' }).skipped, 'already_ran');
    const restarted = createMemoryMaintenance({ rootDir: path.join(rootDir, 'device'), store, readAnchor: () => { throw Error('must not read'); } });
    assert.equal(restarted.runDue({ workspaceId: 'w', at: clock, digestTime: '00:00' }).skipped, 'already_ran');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('maintenance waits for local digest time, retries failed writes and respects recently used preferences', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'memory-retry-'));
  let clock = new Date('2026-06-01T10:00:00Z');
  const store = createMemoryStore({ rootDir, now: () => clock });
  try {
    const pref = store.writeCurated({ kind: 'preference', trust: 'inferred', text: 'short', confirmedCount: 3, sourceRefs: ['a','b','c'] }).item;
    clock = new Date('2026-09-30T10:00:00Z'); store.markUsed([pref.id]);
    const expired = store.writeVerified({ workspaceId:'w', kind:'fact', text:'deadline', sourceRefs:['ev'], expiresAt:'2026-09-01T00:00:00Z' }).item;
    let fail = true;
    const maintenance = createMemoryMaintenance({rootDir:path.join(rootDir,'device'),store:{...store,markMaintained(input){if(fail)throw Error('disk');return store.markMaintained(input);}}});
    const at = new Date(2026,9,1,10);
    assert.equal(maintenance.runDue({workspaceId:'w',at,digestTime:'11:00'}).skipped,'not_due');
    assert.equal(store.get(expired.id).status,'active');
    assert.throws(()=>maintenance.runDue({workspaceId:'w',at,digestTime:'09:00'}),/disk/);
    fail = false; assert.equal(maintenance.runDue({workspaceId:'w',at,digestTime:'09:00'}).ok,true);
    assert.equal(store.get(pref.id).status,'active'); assert.equal(store.get(expired.id).status,'expired');
    assert.equal(maintenance.runDue({workspaceId:'w',at:new Date(2026,9,2,10),digestTime:'09:00'}).ok,true);
  } finally {rmSync(rootDir,{recursive:true,force:true});}
});
