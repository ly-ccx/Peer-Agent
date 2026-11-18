// Real canonical writers/readers and old storage code, isolated from user data.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../../packages/runtime-node/node_modules/esbuild/lib/main.js';
import { createWorkCoordinationStore } from '../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { createCoordinationStorageV2 } from '../../packages/runtime-node/src/project-agent/coordination-storage-v2.mjs';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'peer-native-process-'));
const binary = resolve(process.argv[2] ?? 'target/debug/examples/coordination-conformance');
const contract = JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/native-process.json', import.meta.url)));
let cases = 0, serial = 0;
// Freeze the real <=12 storage implementation by immutable source identity.
// Its dependencies are current; assertions concern its own manifest/load/write
// admission before any reducer or worker can run, not an installed old app.
const previous = '8526db012a7f878abc699387a5707069dac12772';
const storagePath = 'packages/runtime-node/src/project-agent/coordination-storage-v2.mjs';
const source = execFileSync('git', ['show', `${previous}:${storagePath}`], { cwd: repository, maxBuffer: 1024 * 1024 });
const previousFile = join(root, 'previous-storage.mjs');
await build({ stdin: { contents: source.toString(), resolveDir: dirname(join(repository, storagePath)), sourcefile: 'coordination-v12.mjs' }, bundle: true, platform: 'node', format: 'esm', outfile: previousFile, logLevel: 'silent' });
// Load the actual <=13 storage before publishing the first Work Hook.
const previousHookReader = 'a2b99935714ff3970220b8094db767009dc89dd0';
const hookReaderSource = execFileSync('git', ['show', `${previousHookReader}:${storagePath}`],
  { cwd: repository, maxBuffer: 1024 * 1024 });
const previousHookFile = join(root, 'previous-hook-storage.mjs');
await build({ stdin: { contents: hookReaderSource.toString(), resolveDir: dirname(join(repository, storagePath)), sourcefile: 'coordination-v13.mjs' },
  bundle: true, platform: 'node', format: 'esm', outfile: previousHookFile, logLevel: 'silent' });
const previousHookStorage = (await import(pathToFileURL(previousHookFile).href)).createCoordinationStorageV2;
const previousStorage = (await import(pathToFileURL(previousFile).href)).createCoordinationStorageV2;
function fixture(name) {
  const home = join(root, name); mkdirSync(home); writeFileSync(join(home, '.native-cli-fixture'), 'isolated');
  const directory = join(home, 'project-runtime/w');
  const options = { rootDir: join(home, 'project-runtime'), workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owned-fixture', formatVersion: 2, fenceLegacyWrites: true };
  return { home, directory, options, manifest: join(directory, 'coordination-v2/manifest.json'), head: join(directory, 'coordination-v2/head.json') };
}
const json = file => JSON.parse(readFileSync(file));
const put = (file, value) => writeFileSync(file, JSON.stringify(value));
function native(f, extra = {}) {
  const file = join(f.home, `native-${serial++}.json`), fd = openSync(file, 'wx', 0o600);
  let run;
  try { run = spawnSync(binary, [], { env: { PATH: '/nonexistent', PEER_NATIVE_CONFORMANCE_ROOT: f.home }, input: JSON.stringify(extra), timeout: 15000, stdio: ['pipe', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr?.toString()); return json(file);
}
async function store(f) { const s = createWorkCoordinationStore(f.options); await s.prepare(); return s; }
function floor(f, expected = 13) { assert.equal(json(f.manifest).minimumReaderVersion, expected); assert.equal(json(f.manifest).minimumWriterVersion, expected); assert.equal(json(f.head).minimumWriterVersion, expected); cases++; }
function segments(f) { const dir = join(f.directory, 'coordination-v2/segments'); return readdirSync(dir).sort().map(n => [n, readFileSync(join(dir, n)).toString('base64')]); }
for (const writer of ['typescript', 'native', 'native-interrupted']) {
  const f = fixture(writer); let s = await store(f); s.saveWork({ workId: 'existing', state: 'delivered', opaque: { evidence: 'preserved' } });
  const old = previousStorage({ directory: f.directory, legacyFile: join(f.directory, 'coordination.jsonl'), assertOwner() {} });
  assert.equal(old.readSnapshot().works.existing.state, 'delivered');
  s.close();
  const work = structuredClone(contract.cases.find(c => c.name === 'running').input);
  if (writer === 'typescript') { s = await store(f); s.saveWork(work); s.close(); }
  else {
    const response = native(f, { event: { kind: 'work', work }, interrupt: writer === 'native-interrupted' });
    assert.equal(writer === 'native-interrupted' ? response.code : response.ok, writer === 'native-interrupted' ? 'coordination_durable_pending_projection' : true, JSON.stringify(response));
  }
  floor(f);
  // A real old instance was loaded before publication, not just a cold validator.
  const before = segments(f);
  assert.throws(() => old.readSnapshot(), /coordination_schema_unsupported/);
  assert.throws(() => old.commitEntry({ kind: 'work', work: { workId: 'old-writer', state: 'queued' } }), /coordination_schema_unsupported/);
  assert.deepEqual(segments(f), before); old.close(); cases += 3;
  const read = native(f, writer === 'native-interrupted' ? { checkpoint: true } : {}); assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(read.state.works['native-child'].budget, work.budget); cases++;
  s = await store(f); const original = s.readWork('native-child');
  s.saveWork({ ...original, state: 'awaiting_outcome', opaque: { ...original.opaque, future: 'retained' } });
  const expected = s.read(); s.close();
  const again = native(f, { event: { kind: 'work', work: { ...expected.works['native-child'], state: 'blocked' } } });
  assert.equal(again.ok, true, JSON.stringify(again)); assert.deepEqual(again.state.works['native-child'].budget, work.budget); cases++;
  // Force the actual background rebuild path; neither its index nor cold reader
  // may forget floor13 or opaque child/source facts.
  rmSync(join(f.directory, '.read-models'), { recursive: true, force: true });
  s = await store(f); assert.deepEqual(s.read(), again.state); s.close(); floor(f); cases++;
}
for (const recovering of ['typescript', 'native']) {
  const f = fixture(`head-interrupted-${recovering}`); const s = await store(f); s.saveWork({ workId: 'original', state: 'delivered' }); const expected = s.read(); s.close();
  put(f.head, { ...json(f.head), minimumWriterVersion: 13 });
  assert.equal(native(f).code, 'coordination_schema_unsupported'); cases++;
  if (recovering === 'native') { const repaired = native(f, { recover: true }); assert.equal(repaired.ok, true, JSON.stringify(repaired)); assert.deepEqual(repaired.state, expected); }
  else { const repaired = await store(f); assert.deepEqual(repaired.read(), expected); repaired.close(); }
  floor(f); cases++;
}
const hookContract = JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/work-hook.json', import.meta.url)));
for (const writer of ['typescript', 'native-interrupted']) {
  const f = fixture(`hook-${writer}`);
  let s = await store(f);
  s.saveWork({ workId: 'existing', state: 'delivered' });
  s.close();
  const old = previousHookStorage({ directory: f.directory, legacyFile: join(f.directory, 'coordination.jsonl'), assertOwner() {} });
  assert.equal(old.readSnapshot().works.existing.state, 'delivered');
  const adopted = structuredClone(hookContract.cases.find(row => row.name === 'known Pre result').work);
  const work = { workId: 'native-hook', state: 'awaiting_outcome', budget: adopted.budget };
  const event = { kind: 'work', work };
  let original = work;
  if (writer === 'typescript') {
    s = await store(f);
    s.saveWork(work);
    original = s.readWork(work.workId);
    assert.equal(original.state, work.state);
    assert.deepEqual(original.budget, work.budget);
    s.close();
  } else {
    const response = native(f, { event, interrupt: true });
    assert.equal(response.code, 'coordination_durable_pending_projection', JSON.stringify(response));
  }
  floor(f, hookContract.semanticFloor);
  const before = segments(f);
  assert.throws(() => old.readSnapshot(), /coordination_schema_unsupported/);
  assert.throws(() => old.commitEntry({ kind: 'work', work: { workId: 'old', state: 'queued' } }), /coordination_schema_unsupported/);
  assert.deepEqual(segments(f), before);
  old.close();
  let current = native(f, writer === 'native-interrupted' ? { checkpoint: true } : {});
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.deepEqual(current.state.works[work.workId], original);
  s = await store(f);
  const remembered = s.readWork(work.workId);
  const dispatch = remembered.budget.attempts.attempt.pendingTools[0];
  s.saveWork({ ...remembered, budget: { attempts: {}, uncertainDispatches: [dispatch] } });
  s.close();
  current = native(f);
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.deepEqual(current.state.works[work.workId].budget.uncertainDispatches, [dispatch]);
  rmSync(join(f.directory, '.read-models'), { recursive: true, force: true });
  s = await store(f);
  assert.deepEqual(s.read(), current.state);
  s.close();
  floor(f, hookContract.semanticFloor);
  cases += 7;
}
// An unknown future floor must still refuse access.
const bad = fixture('future-floor'); const s = await store(bad); s.close();
put(bad.manifest, { ...json(bad.manifest), minimumReaderVersion: 15, minimumWriterVersion: 15 });
const unchanged = readFileSync(bad.manifest);
assert.equal(native(bad).code, 'coordination_schema_unsupported');
assert.throws(() => createCoordinationStorageV2({ directory: bad.directory, legacyFile: join(bad.directory, 'coordination.jsonl'), assertOwner() {} }).readSnapshot(), /coordination_schema_unsupported/);
assert.deepEqual(readFileSync(bad.manifest), unchanged); cases += 3;
console.log(JSON.stringify({ ok: true, cases, root, previous, previousHookReader, previousStorageSha256: createHash('sha256').update(source).digest('hex'), limits: 'Isolated actual storage implementations; no installed old-host drain or personal data.' }));
