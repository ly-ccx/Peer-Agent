import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readModelConfigFile, replaceModelConfigFile, withModelConfigLock } from './model-config-file.mjs';

function fixture(action) {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-model-config-file-'));
  try { return action(path.join(root, 'llm-providers.json'), root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
test('conditional config replacement preserves unknowns, rejects stale snapshots and admits a later change', () => fixture(file => {
  const original = readModelConfigFile(file);
  const value = { ...original.value, future: { keep: ['yes'] } };
  const saved = replaceModelConfigFile(file, original.revision, value);
  assert.deepEqual(saved.value.future, value.future);
  assert.throws(() => replaceModelConfigFile(file, original.revision, original.value), /model_config_changed/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const next = replaceModelConfigFile(file, saved.revision, { ...saved.value, later: true });
  assert.equal(next.value.later, true);
}));
test('corruption, unknown versions, size/depth/node limits and symlinks cannot become empty configuration', () => fixture((file, root) => {
  for (const raw of ['{broken', '\uFEFF{"version":2,"channels":[],"models":[]}', '{"version":99,"channels":[],"models":[]}', '[]'.repeat(600000),
    `{"version":2,"channels":[],"models":[],${'"duplicate":0,'.repeat(16400)}"tail":0}`,
    JSON.stringify({ version: 2, channels: Array.from({length: 17000}, () => ({})), models: [] })]) {
    writeFileSync(file, raw);
    assert.throws(() => readModelConfigFile(file), /model_config_/);
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  writeFileSync(file, `{"version":2,"channels":[],"models":[],"deep":${'['.repeat(40)}0${']'.repeat(40)}}`);
  assert.throws(() => readModelConfigFile(file), /model_config_limit/);
  rmSync(file); const target = path.join(root, 'target'); writeFileSync(target, '{}'); symlinkSync(target, file);
  assert.throws(() => readModelConfigFile(file), /model_config_/);
  assert.equal(readFileSync(target, 'utf8'), '{}');
}));
test('nested ownership uses one lock; independent writers wait or reject and later acquire', () => fixture(file => {
  const script = `import {withModelConfigLock} from ${JSON.stringify(import.meta.resolve('./model-config-file.mjs'))};withModelConfigLock(${JSON.stringify(file)},()=>{}, {timeoutMs:0});`;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  withModelConfigLock(file, () => {
    withModelConfigLock(file, () => assert.ok(existsSync(`${file}.lock`)));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {env,encoding:'utf8',timeout:5000});
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0); assert.match(child.stderr, /model_config_lock_busy/);
  });
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script], {env,timeout:5000}).status, 0);
}));
test('replacement lock owner is preserved and a verified subsequent owner can proceed', () => fixture((file, root) => {
  const lock = `${file}.lock`, displaced = path.join(root, 'displaced');
  assert.throws(() => withModelConfigLock(file, () => { renameSync(lock, displaced); mkdirSync(lock); }), /model_config_lock_changed/);
  assert.ok(existsSync(displaced)); assert.ok(existsSync(lock));
  // Test owns both empty directories; this is not stale-lock reclamation.
  rmSync(lock, {recursive:true});rmSync(displaced,{recursive:true});
  withModelConfigLock(file, () => {});
}));

test('a lost owner after rename reports commit unknown and actual state reconciles without rolling back', () => fixture((file, root) => {
  const before=readModelConfigFile(file), displaced=path.join(root,'old-lock');
  assert.throws(()=>withModelConfigLock(file,()=>{
    replaceModelConfigFile(file,before.revision,{...before.value,committed:true});
    renameSync(`${file}.lock`,displaced);mkdirSync(`${file}.lock`);
  }),/model_config_commit_unknown/);
  assert.equal(readModelConfigFile(file).value.committed,true);
  assert.ok(existsSync(`${file}.lock`));
  rmSync(`${file}.lock`,{recursive:true});rmSync(displaced,{recursive:true});
  const current=readModelConfigFile(file);
  replaceModelConfigFile(file,current.revision,{...current.value,next:true});
  assert.equal(readModelConfigFile(file).value.next,true);
}));
