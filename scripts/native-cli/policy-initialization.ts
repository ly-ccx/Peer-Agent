import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { createBotAccessPolicyAuthority } from '../../packages/runtime-node/src/project-agent/bot-access-policy.mjs';

const binary = resolve(process.argv[2] ?? 'target/debug/examples/conformance');
const at = '2026-11-14T00:00:00.000Z'; let cases = 0;
const root = mkdtempSync(join(tmpdir(), 'peer-native-policy-init-'));
function trial(name: string) {
  const path = join(root, name); mkdirSync(path); writeFileSync(join(path, '.native-cli-fixture'), 'synthetic'); return path;
}
function profile(path: string, id: string, complete = true) {
  mkdirSync(join(path, 'projects', id), { recursive: true });
  writeFileSync(join(path, 'projects', id, 'profile.json'), JSON.stringify({ workspaceId: id, agentConversationId: `bot-${id}`, status: 'active',
    ...(complete ? { displayName: 'Synthetic Bot', avatar: { kind: 'generated' } } : {}) }));
}
function native(path: string, request: object) {
  const result = spawnSync(binary, [], { env: { ...process.env, PEER_NATIVE_CONFORMANCE_ROOT: path }, input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const initialize = (path: string, level: string) => native(path, { op: 'policy_initialize', legacy_access_level: level, updated_at: at });
const read = (path: string, id: string) => native(path, { op: 'policy_read', workspace_id: id });
for (const first of ['native', 'typescript']) {
  const path = trial(first); profile(path, 'w');
  const ts = createBotAccessPolicyAuthority({ dataHome: path, legacyAccessLevel: 'full_local', now: () => at });
  if (first === 'native') assert.equal(initialize(path, 'full_local').ok, true); else assert.equal(ts.initialize().ok, true);
  const expected = ts.read('w'); assert.equal(expected.ok, true); assert.equal(expected.policy.accessLevel, 'full_local');
  assert.deepEqual(read(path, 'w'), { ok: true, policy: expected.policy }); cases++;
  assert.equal(initialize(path, 'ask_before_local').ok, true); assert.deepEqual(read(path, 'w'), { ok: true, policy: expected.policy }); cases++;
  profile(path, 'new');
  const registered = native(path, { op: 'policy_register', workspace_id: 'new', updated_at: at });
  assert.equal(registered.ok, true); assert.equal(registered.policy.source, 'new_bot'); assert.equal(registered.policy.accessLevel, 'ask_before_local');
  assert.deepEqual(ts.read('new').policy, registered.policy); cases++;
  ts.close();
}
const imported = trial('imported'); profile(imported, 'w'); mkdirSync(join(imported, 'project-runtime'));
writeFileSync(join(imported, 'project-runtime/bot-access-imported.json'), '{}');
assert.equal(initialize(imported, 'full_local').ok, true);
const importedTS = createBotAccessPolicyAuthority({ dataHome: imported, legacyAccessLevel: 'full_local', now: () => at });
assert.equal(importedTS.read('w').policy.accessLevel, 'ask_before_local'); assert.deepEqual(read(imported, 'w').policy, importedTS.read('w').policy); importedTS.close(); cases++;
const malformed = trial('malformed-profile'); profile(malformed, 'bad', false);
assert.equal(initialize(malformed, 'full_local').ok, true);
const malformedTS = createBotAccessPolicyAuthority({ dataHome: malformed, legacyAccessLevel: 'full_local', now: () => at });
assert.equal(malformedTS.read('bad').code, 'NOT_FOUND'); assert.equal(read(malformed, 'bad').code, 'NOT_FOUND'); malformedTS.close(); cases++;
// Unknown schema initialization preserves the source rather than reconstructing policy.
const dbPath = join(imported, 'project-runtime/bot-access.sqlite');
const { Database } = await import('bun:sqlite'); const db = new Database(dbPath); db.exec('PRAGMA user_version=2'); db.close();
const before = readFileSync(dbPath); assert.equal(initialize(imported, 'full_local').code, 'POLICY_UNAVAILABLE'); assert.deepEqual(readFileSync(dbPath), before); cases++;
const unclean = trial('unclean-wal'); profile(unclean, 'w'); assert.equal(initialize(unclean, 'full_local').ok, true);
const clean = new Database(join(unclean,'project-runtime/bot-access.sqlite')); clean.exec('PRAGMA wal_checkpoint(TRUNCATE)'); clean.close();
assert.equal(native(unclean, { op: 'policy_uncheckpointed_schema' }).simulatedUncleanExit, true);
const uncleanPath=join(unclean,'project-runtime/bot-access.sqlite');
const mainBefore=readFileSync(uncleanPath),walBefore=readFileSync(`${uncleanPath}-wal`);
assert.equal(mainBefore.readUInt32BE(60),1,'fixture must keep schema 2 in the committed WAL rather than the main file');
assert.equal(initialize(unclean,'full_local').code,'POLICY_UNAVAILABLE');
assert.deepEqual(readFileSync(uncleanPath),mainBefore,'rejecting the schema must not checkpoint the existing WAL');
assert.deepEqual(readFileSync(`${uncleanPath}-wal`),walBefore,'rejecting the schema must preserve the committed WAL');cases++;
for (const request of [
  { op:'policy_read',workspace_id:'w' },
  { op:'policy_register',workspace_id:'w',updated_at:at },
  { op:'policy_update',workspace_id:'w',expected_revision:1,access_level:'ask_before_local',updated_at:at },
]) {
  assert.equal(native(unclean,request).code,'POLICY_UNAVAILABLE');
  assert.deepEqual(readFileSync(uncleanPath),mainBefore,`${request.op} must preserve the unknown main database`);
  assert.deepEqual(readFileSync(`${uncleanPath}-wal`),walBefore,`${request.op} must preserve its committed WAL`);cases++;
}
process.stdout.write(`${JSON.stringify({ passed: cases, fixtureRoot: root, coverage: 'Native-first and Bun-first migration, new Bot Ask, imported marker, malformed profile and schema/WAL preservation; no personal policies.' })}\n`);
