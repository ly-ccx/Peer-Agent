import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSettingsStore } from './settings-store.mjs';

let tmpRoot;
let settingsFile;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'peer-settings-'));
  settingsFile = path.join(tmpRoot, 'settings.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('getAll returns {} when file is absent', () => {
  const store = createSettingsStore({ settingsFile });
  assert.deepEqual(store.getAll(), {});
});

test('runtime policy rereads external changes and admits neither identity nor credentials', () => {
  const store=createSettingsStore({settingsFile});
  writeFileSync(settingsFile,JSON.stringify({schemaVersion:3,workspaces:[{id:'private-id',path:'/private/path'}],remoteAccess:{token:'secret'},apiKey:'secret',
    projectAgent:{shell:'bots',concurrency:2,managedRoot:'/private',quietHours:{enabled:true,start:'23:00',end:'06:00',apiKey:'secret'}},memory:{enabled:true,learnPreferences:true,secret:'secret'}}));
  const first=store.getRuntimePolicy();assert.equal(first.projectAgent.shell,'bots');assert.equal(first.memory.enabled,true);
  assert.equal(JSON.stringify(first).includes('private'),false);assert.equal(JSON.stringify(first).includes('secret'),false);
  writeFileSync(settingsFile,JSON.stringify({schemaVersion:3,projectAgent:{shell:'classic',concurrency:1},memory:{enabled:false,learnPreferences:false}}));
  const next=store.getRuntimePolicy();assert.equal(next.projectAgent.shell,'classic');assert.equal(next.projectAgent.concurrency,1);assert.deepEqual(next.memory,{enabled:false,learnPreferences:false});
  assert.equal(first.projectAgent.shell,'bots');
});

test('200 migrated workspaces policy reads do not scan or repair Registry, while getAll still repairs identity', () => {
  mkdirSync(path.join(tmpRoot,'projects'));const registry=path.join(tmpRoot,'projects','registry.json');writeFileSync(registry,'{broken');
  writeFileSync(settingsFile,JSON.stringify({schemaVersion:3,workspaces:Array.from({length:200},(_,i)=>({path:path.join(tmpRoot,`project-${i}`)})),projectAgent:{shell:'bots'}}));
  const store=createSettingsStore({settingsFile});
  for(let i=0;i<200;i++) assert.equal(store.getRuntimePolicy().projectAgent.shell,'bots');
  assert.equal(readFileSync(registry,'utf8'),'{broken');assert.deepEqual(readdirSync(path.dirname(registry)),['registry.json']);
  assert.ok(store.getAll().workspaces.every(item=>typeof item.id==='string'));
  assert.equal(JSON.parse(readFileSync(registry,'utf8')).projects.length,200);
});

test('runtime policy upgrades an older schema through existing backup and atomic migration', () => {
  const store=createSettingsStore({settingsFile});const original=JSON.stringify({schemaVersion:1,memory:{enabled:false},workspaces:[{path:tmpRoot,name:'project'}]});
  writeFileSync(settingsFile,original);assert.equal(store.getRuntimePolicy().projectAgent.shell,'bots');
  const migrated=JSON.parse(readFileSync(settingsFile,'utf8'));assert.equal(migrated.schemaVersion,3);assert.ok(migrated.workspaces[0].id);
  const backup=readdirSync(tmpRoot).find(name=>name.startsWith('settings.json.bak-v1-'));assert.ok(backup);assert.equal(readFileSync(path.join(tmpRoot,backup),'utf8'),original);
  assert.equal(store.getRuntimePolicy().memory.enabled,false);
});

test('merge writes file and is shallow (only overrides given keys)', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appearance: { mode: 'dark', density: 'comfortable' } });
  store.merge({ appMode: 'work' });

  const all = store.getAll();
  assert.deepEqual(all.appearance, { mode: 'dark', density: 'comfortable' });
  assert.equal(all.appMode, 'work');
  assert.ok(existsSync(settingsFile));
});

test('merge overrides only the top-level key, leaves siblings intact', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appearance: { mode: 'light' }, appMode: 'thinking' });
  store.merge({ appearance: { mode: 'dark' } });

  const all = store.getAll();
  assert.deepEqual(all.appearance, { mode: 'dark' });
  assert.equal(all.appMode, 'thinking', 'sibling key preserved');
});

test('merge ignores non-object payloads', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appMode: 'work' });
  assert.deepEqual(store.merge(null), {
    appMode: 'work',
    schemaVersion: 3,
    projectAgent: { shell: 'bots' },
  });
  assert.deepEqual(store.merge('garbage'), {
    appMode: 'work',
    schemaVersion: 3,
    projectAgent: { shell: 'bots' },
  });
});

test('getAll tolerates corrupted file', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appMode: 'work' });
  // 手动写坏
  writeFileSync(settingsFile, '{ not json', 'utf8');
  assert.deepEqual(store.getAll(), {});
});
