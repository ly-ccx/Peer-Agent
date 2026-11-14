import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { strict as assert } from 'node:assert';

const root = mkdtempSync(join(tmpdir(), 'peer-native-store-conformance-'));
writeFileSync(join(root, '.native-cli-fixture'), 'synthetic fixture');
process.env.PEER_AGENT_HOME = root;
process.env.PEER_USER_DATA_PATH = root;
const binary = resolve(process.argv[2] ?? 'target/debug/examples/conformance');
const env = { ...process.env, PEER_NATIVE_CONFORMANCE_ROOT: root };
const { createConversationStore } = await import('../../packages/conversation-store/src/index.mjs');
const { createProjectRegistry } = await import('../../packages/runtime-node/src/project-registry.mjs');
const { createBotLifecycle } = await import('../../packages/runtime-node/src/project-agent/bot-lifecycle.mjs');
const { createBotAccessPolicyAuthority } = await import('../../packages/runtime-node/src/project-agent/bot-access-policy.mjs');

const native = (request: object) => {
  const child = spawnSync(binary, [], { env, input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  if (lines.length > 1) {
    assert.equal((request as {op:string}).op, 'lock');
    assert.deepEqual(lines.slice(0, -1), [{ phase: 'locked' }]);
  }
  return lines.at(-1);
};
const store = createConversationStore({ storeDir: join(root, 'conversations') });
const conversation = store.createConversation({ title: 'native conformance' });
store.appendMessage(conversation.id, { id: 'user', role: 'user', content: '中文', futureField: { retained: true } });
store.appendMessage(conversation.id, { id: 'active', role: 'assistant', content: 'provisional' });
store.appendMessage(conversation.id, { id: 'tail', role: 'assistant', content: 'excluded tail' });
let cases = 0;
function compareHistory() {
  const expected = store.getPersistedConversationHistory(conversation.id);
  assert.deepEqual(native({ op: 'history', id: conversation.id }), { ok: true, history: expected }); cases++;
}
compareHistory();
const sidecar = join(root, 'conversations', `${conversation.id}.stream.json`);
writeFileSync(sidecar, JSON.stringify({ version: 1, conversationId: conversation.id, messageId: 'active', patch: {} }));
compareHistory();
writeFileSync(sidecar, JSON.stringify({ version: 1, conversationId: conversation.id, messageId: 'missing', patch: {} }));
assert.throws(() => store.getPersistedConversationHistory(conversation.id), /BACKGROUND_STREAM_TARGET_MISSING/);
assert.equal(native({ op: 'history', id: conversation.id }).code, 'BACKGROUND_STREAM_TARGET_MISSING'); cases++;
writeFileSync(sidecar, 'corrupt');
assert.throws(() => store.getPersistedConversationHistory(conversation.id), /BACKGROUND_STREAM_STATE_INVALID/);
assert.equal(native({ op: 'history', id: conversation.id }).code, 'BACKGROUND_STREAM_STATE_INVALID'); cases++;
rmSync(sidecar);
const workspace = join(root, 'workspace'); mkdirSync(workspace);
const registry = createProjectRegistry({ filePath: join(root, 'projects/registry.json') });
const entry = registry.ensureForPath(workspace);
const created = createBotLifecycle({ rootDir: root, registry, conversationStore: store }).ensureBot(entry.workspaceId);
assert.equal(created.ok, true);
const now = () => '2026-11-14T00:00:00.000Z';
const authority = createBotAccessPolicyAuthority({ dataHome: root, now });
assert.equal(authority.initialize().ok, true);
const workspace_id = entry.workspaceId;
let expected = authority.read(workspace_id); assert.equal(expected.ok, true);
assert.deepEqual(native({ op: 'policy_read', workspace_id }), { ok: true, policy: expected.policy }); cases++;
expected = authority.update({ workspaceId: workspace_id, expectedRevision: expected.policy.revision, accessLevel: 'full_local' });
assert.equal(expected.ok, true);
assert.deepEqual(native({ op: 'policy_read', workspace_id }), { ok: true, policy: expected.policy }); cases++;
const written = native({ op: 'policy_update', workspace_id, expected_revision: expected.policy.revision, access_level: 'ask_before_local', updated_at: now() });
assert.equal(written.ok, true);
assert.deepEqual(authority.read(workspace_id).policy, written.policy); cases++;
assert.equal(authority.valid(expected.policy, { workspaceId: workspace_id, conversationId: created.profile.agentConversationId }), false); cases++;
const conflict = native({ op: 'policy_update', workspace_id, expected_revision: 1, access_level: 'full_local', updated_at: now() });
assert.deepEqual(conflict, { ok: false, code: 'POLICY_CONFLICT', policy: written.policy }); cases++;
const profilePath = join(root, 'projects', workspace_id, 'profile.json');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
writeFileSync(profilePath, JSON.stringify({ ...profile, agentConversationId: 'replacement' }));
assert.equal(native({ op: 'policy_read', workspace_id }).code, 'OUT_OF_SCOPE'); cases++;
writeFileSync(profilePath, JSON.stringify(profile));

// Two independent SQL engines compete for the same durable CAS revision.
const rival = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let rivalOutput = '';
rival.stdout.on('data', data => { rivalOutput += data.toString(); });
const rivalDone = new Promise<void>((yes, no) => { rival.once('error', no); rival.once('close', code => code === 0 ? yes() : no(Error(`native CAS exit ${code}`))); });
rival.stdin.end(JSON.stringify({ op: 'policy_update', workspace_id, expected_revision: written.policy.revision, access_level: 'restricted_local', updated_at: now() }));
const tsRace = authority.update({ workspaceId: workspace_id, expectedRevision: written.policy.revision, accessLevel: 'session_local' });
await rivalDone;
const rustRace = JSON.parse(rivalOutput.trim());
assert.equal([tsRace, rustRace].filter(result => result.ok).length, 1);
assert.equal([tsRace, rustRace].filter(result => result.code === 'POLICY_CONFLICT').length, 1);
assert.equal(authority.read(workspace_id).policy.revision, written.policy.revision + 1); cases++;

async function startHolder(command: string, args: string[], input?: object) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (input) child.stdin.end(JSON.stringify(input)); else child.stdin.end();
  let error = ''; child.stderr.on('data', data => { error += data.toString(); });
  const done = new Promise<void>((yes, no) => { child.once('error', no); child.once('close', code => code === 0 ? yes() : no(Error(error))); });
  const reader = createInterface({ input: child.stdout });
  await new Promise<void>((yes, no) => {
    const deadline = setTimeout(() => { child.kill(); no(Error('holder failed to acquire')); }, 3000);
    reader.once('line', line => { clearTimeout(deadline); JSON.parse(line).phase === 'locked' ? yes() : no(Error(line)); });
    child.once('error', no);
  });
  return { done };
}
const ts = await startHolder(process.execPath, ['scripts/native-cli/store-lock-holder.ts']);
assert.equal(native({ op: 'lock', hold_ms: 0, timeout_ms: 0 }).code, 'STORE_LOCK_BUSY'); cases++;
await ts.done;
assert.equal(native({ op: 'lock', hold_ms: 0, timeout_ms: 100 }).ok, true); cases++;
const rust = await startHolder(binary, [], { op: 'lock', hold_ms: 500, timeout_ms: 100 });
const tsWaiter = spawn(process.execPath, ['scripts/native-cli/store-lock-holder.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const waiterDone = new Promise<void>((yes, no) => { tsWaiter.once('error', no); tsWaiter.once('close', code => code === 0 ? yes() : no(Error(`TS lock waiter exit ${code}`))); });
await rust.done; await waiterDone; cases++;
authority.close();
process.stdout.write(`${JSON.stringify({ passed: cases, fixtureRoot: root, coverage: 'Real legacy Store / Bun SQLite / Rust SQLite / cross-process mkdir lock; no model or capability execution.' })}\n`);
