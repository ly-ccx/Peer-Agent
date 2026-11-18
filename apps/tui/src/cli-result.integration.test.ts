import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interactiveArtifactRef } from '@peer-agent/protocol';
import { createBotProfileStore } from '@peer-agent/runtime-node/project-agent';
import { createInteractiveResultStore, createInteractiveRetention, createInteractiveStateStore, INTERACTIVE_RETENTION_SOURCES,
  runInteractiveValidation } from '@peer-agent/runtime-node/interactive-results';

const entry = path.join(import.meta.dir, 'index.tsx');
const nativeResult = process.env.PEER_TEST_NATIVE_RESULT_BINARY;
async function withPublication(check: (fixture: Awaited<ReturnType<typeof publication>>) => void | Promise<void>, fallback?: string, program?: string) {
  const fixture = await publication(fallback, program);
  try { await check(fixture); }
  finally { fixture.stateStore.close(); fixture.resultStore.close(); rmSync(fixture.root, { recursive: true, force: true }); }
}
async function publication(fallback = 'Unverified.\u001b[31m ' + 'sample '.repeat(1800), program = 'root=Text("Stored program that must not be exported")') {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-result-cli-'));
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const resultStore = createInteractiveResultStore({ rootDir: path.join(root, 'project-runtime'), assertCompatibility: () => true });
  const stateStore = createInteractiveStateStore({ resultStore });
  try {
    const profiles = createBotProfileStore({ rootDir: root } as never);
    expect(profiles.create({ ...owner, displayName: 'Local Bot', agentConversationId: owner.conversationId }).ok).toBe(true);
    const draft = { publication: { kind: 'create' as const }, title: 'Fixed CLI trial', textFallback: fallback,
      inputs: [], program };
    const content = await runInteractiveValidation({ operation: 'validate', draft });
    const source = { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' };
    const published = resultStore.commitPublication({ owner, source, draft, content, provenance: [], dataLevel: 'D3_private',
      grant: { toolCallId: source.toolCallId, grantId: 'fixture', granted: true } }, () => true);
    const ref = interactiveArtifactRef(published.reference);
    const executable = process.env.PEER_TEST_STANDALONE_BINARY;
    const runWithInput = (input: string | undefined, ...args: string[]) => {
      const result = Bun.spawnSync(executable ? [executable, ...args] : [process.execPath, entry, ...args],
        { cwd: root, env: { ...process.env, PEER_AGENT_HOME: root }, stdin: input === undefined ? 'ignore' : Buffer.from(input), stdout: 'pipe', stderr: 'pipe' });
      return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    };
    const database = path.join(root, 'project-runtime', owner.workspaceId, 'interactive-results');
    const readDbFiles = () => Object.fromEntries(readdirSync(database).sort().map(name => [name, readFileSync(path.join(database, name))]));
    const run = (...args: string[]) => {
      const legacy = runWithInput(undefined, ...args);
      if (!nativeResult || args[0] !== 'result') return legacy;
      const before = readDbFiles();
      const result = Bun.spawnSync([nativeResult, ...args], {
        cwd: root, env: { HOME: root, PEER_AGENT_HOME: root, PATH: '/nonexistent' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      expect(readDbFiles()).toEqual(before);
      expect(result.exitCode).toBe(legacy.status);
      expect(result.stderr.toString()).toBe(legacy.stderr);
      if (legacy.status === 0 && args.includes('--json')) {
        expect(JSON.parse(result.stdout.toString())).toEqual(JSON.parse(legacy.stdout));
      } else if (args[1] === '--help') {
        expect(result.stdout.toString()).toContain('Read a fixed result summary from the local Bot.');
      } else {
        expect(result.stdout.toString()).toBe(legacy.stdout);
      }
      return legacy;
    };
    const markIndexed = () => resultStore.markIndexed(published.callRef, published.indexEntry);
    const retirement = createInteractiveRetention({ resultStore, stateStore, assertOwner: () => true,
      acquireRoots: () => ({ sources: Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source => [source, 'sha256:' + '0'.repeat(64)])),
        pins: [], followupIds: [], assertCurrent: () => true, release() {},
        materialResponsibility: () => ({ digest: 'sha256:' + '0'.repeat(64), blocked: false, assertCurrent: () => true, release() {} }),
      }) });
    const request = () => ({ op: 'receipt', kind: 'result', target: published.reference,
      expectedDigest: retirement.preview(published.reference).cleanupDigest, requestId: 'cli-cleanup' });
    const readReceipt = (input: unknown = request()) => {
      const encoded = JSON.stringify(input);
      const legacy = runWithInput(encoded, 'result-cleanup-receipt');
      if (!nativeResult) return legacy;
      const before = readDbFiles();
      const result = Bun.spawnSync([nativeResult, 'result-cleanup-receipt'], {
        cwd: root, env: { HOME: root, PEER_AGENT_HOME: root, PATH: '/nonexistent' }, stdin: Buffer.from(encoded), stdout: 'pipe', stderr: 'pipe',
      });
      expect(readDbFiles()).toEqual(before);
      expect(result.exitCode).toBe(legacy.status);
      expect(result.stderr.toString()).toBe(legacy.stderr);
      const stdout = result.stdout.toString();
      if (legacy.status === 0) {
        expect(JSON.parse(stdout)).toEqual(JSON.parse(legacy.stdout));
        expect(stdout.trim()).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      } else {
        expect(stdout).toBe('');
      }
      return legacy;
    };
    const cleanup = () => retirement.cleanup({ reference: published.reference, expectedDigest: request().expectedDigest, requestId: 'cli-cleanup' });
    return { root, owner, source, draft, published, ref, resultStore, stateStore, run, runWithInput, markIndexed, request, readReceipt, cleanup, retirement };
  } catch (error) {
    stateStore.close(); resultStore.close(); rmSync(root, { recursive: true, force: true }); throw error;
  }
}

// Each independent command/transition keeps Bun's normal per-test deadline.
// A single implicit 5s budget must not accumulate every cold CLI startup.
for (const [args, expected] of [[['--help'], 'peer result'], [['result', '--help'], '--json']] as const) {
  test('fixed-result CLI help: ' + args.join(' '), () => withPublication(({ run }) => expect(run(...args).stdout).toContain(expected)));
}
test('fixed-result CLI version needs no model', () => withPublication(({ run }) => expect(run('--version').status).toBe(0)));
test('fixed-result CLI refuses a local path in place of a publication reference', () => withPublication(({ run }) => expect(run('result', 'some-local-file').status).toBe(2)));

test('fixed-result CLI gates the publication index, then returns the same cleaned summary', () => withPublication(f => {
  expect(f.run('result', f.ref, '--json')).toEqual({ status: 1, stdout: '', stderr: 'peer result: publication_index_pending\n' });
  f.markIndexed();
  const output = f.run('result', f.ref, '--json');
  expect(output.status).toBe(0); expect(output.stderr).toBe(''); expect(output.stdout).not.toContain('Stored program');
  const fixed = JSON.parse(output.stdout);
  expect(fixed).toMatchObject({ ref: f.ref, reference: f.published.reference, availability: 'available', summaryKind: 'saved-model-summary', schemaVersion: 1, contentSchemaVersion: 1,
    title: f.draft.title, truncated: true, source: f.source, dataLevel: 'D3_private' });
  expect(fixed.textFallback).not.toContain('\u001b');
}));
test('fixed-result CLI plain output labels the saved summary unverified and truncated', () => withPublication(f => {
  f.markIndexed(); expect(f.run('result', f.ref).stdout).toContain('Saved model summary, unverified (truncated)');
}));
test('fixed-result CLI refuses another owner conversation', () => withPublication(f => {
  f.markIndexed();
  const wrong = interactiveArtifactRef({ ...f.published.reference, owner: { ...f.owner, conversationId: 'foreign' } });
  expect(f.run('result', wrong)).toEqual({ status: 3, stdout: '', stderr: 'peer result: interactive_scope_denied\n' });
}));
test('fixed-result CLI cleanup receipt is read-only and private maintenance cannot be invoked directly', () => withPublication(f => {
  f.markIndexed(); const request = f.request();
  expect(f.readReceipt(request)).toEqual({ status: 0, stdout: 'null\n', stderr: '' });
  expect(f.readReceipt({ ...request, op: 'cleanup' })).toMatchObject({ status: 2, stdout: '' });
  expect(f.readReceipt({ ...request, op: 'preview' })).toMatchObject({ status: 2, stdout: '' });
  expect(f.readReceipt({ ...request, requestId: 'long'.repeat(2048) })).toMatchObject({ status: 2, stdout: '' });
  expect(f.runWithInput(JSON.stringify({ ...request, op: 'cleanup' }), '__interactive-maintenance', '3', '4'))
    .toMatchObject({ status: 3, stdout: '', stderr: 'peer interactive maintenance: interactive_retention_unavailable\n' });
}));
test('fixed-result CLI cleanup receipt preserves the actual committed identity', () => withPublication(f => {
  f.markIndexed(); const request = f.request(); const receipt = f.cleanup();
  expect(JSON.parse(f.readReceipt(request).stdout)).toEqual(receipt);
  expect(f.readReceipt({ ...request, requestId: 'another-request' })).toMatchObject({ status: 1, stdout: '',
    stderr: 'peer interactive maintenance: interactive_cleanup_parameter_conflict\n' });
}));
test('fixed-result CLI cleanup receipt rejects a corrupted persisted digest', () => withPublication(f => {
  f.markIndexed();
  const request = f.request();
  const saved = f.cleanup();
  f.resultStore.storage.connect(f.owner.workspaceId).db
    .prepare("UPDATE presentation SET body=? WHERE category='interactive-cleanup' AND id=?")
    .run(JSON.stringify({ ...saved, receiptDigest: 'sha256:' + '0'.repeat(64) }), f.published.reference.resultId);
  expect(f.readReceipt(request)).toEqual({ status: 1, stdout: '',
    stderr: 'peer interactive maintenance: interactive_cleanup_corrupt\n' });
}));
test('fixed-result CLI cleanup receipt refuses another owner', () => withPublication(f => {
  f.markIndexed(); const request = f.request(); f.cleanup();
  expect(f.readReceipt({ ...request, target: { ...f.published.reference, owner: { ...f.owner, conversationId: 'foreign' } } }))
    .toMatchObject({ status: 3, stdout: '' });
}));
test('fixed-result CLI reads the retired followup and scopes it to the current Bot', () => withPublication(async f => {
  f.markIndexed();
  const reference = f.published.reference;
  const identity = { viewId: 'view-a', windowId: 'window-a', generation: 'view-generation' };
  const current = () => true;
  const writer = f.stateStore.acquire({ reference, identity, expectedRevision: 0 }, current);
  const state = f.stateStore.read(reference, current);
  const snapshot = await f.stateStore.prepareFollowup({ reference, identity, writer, stateRevision: 0,
    stateDigest: state.stateDigest, fields: ['$budget'], requestId: 'freeze-retire' }, current);
  f.stateStore.release({ reference, identity, writer }, current);
  const target = { owner: f.owner, followupId: snapshot.followupId };
  const expectedDigest = f.retirement.previewFollowup(target).cleanupDigest;
  const request = { op: 'receipt', kind: 'followup', target, expectedDigest, requestId: 'forget-followup' };
  expect(f.readReceipt(request)).toEqual({ status: 0, stdout: 'null\n', stderr: '' });
  const receipt = f.retirement.cleanupFollowup({ ...target, expectedDigest, requestId: request.requestId });
  expect(JSON.parse(f.readReceipt(request).stdout)).toEqual(receipt);
  expect(f.readReceipt({ ...request, target: { ...target, followupId: 'missing' } })).toMatchObject({ status: 1, stdout: '',
    stderr: 'peer interactive maintenance: interactive_followup_unavailable\n' });
}, 'Safe fixture fallback', '$budget=100\nroot=NumberInput("budget","Budget",$budget,0,1000,1)'));

test('fixed-result CLI reads the retired material and checks the exact source version', () => withPublication(f => {
  f.markIndexed();
  const source = f.resultStore.recordMaterial({ owner: f.owner,
    source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-mat-a' },
    value: { text: 'canonical material' }, dataLevel: 'D3_private', observedAt: '2026-11-04T00:00:00.000Z',
    truncated: false, redacted: false, evidenceRefs: ['tool-result://read-mat-a'] }, () => true);
  const target = { owner: f.owner, source };
  const expectedDigest = f.retirement.previewMaterial(target).cleanupDigest;
  const request = { op: 'receipt', kind: 'material', target, expectedDigest, requestId: 'forget-material' };
  expect(f.readReceipt(request)).toEqual({ status: 0, stdout: 'null\n', stderr: '' });
  const receipt = f.retirement.cleanupMaterial({ ...target, expectedDigest, requestId: request.requestId });
  expect(JSON.parse(f.readReceipt(request).stdout)).toEqual(receipt);
  expect(f.readReceipt({ ...request, target: { ...target, source: { ...source, expectedContentVersion: 'sha256:' + '0'.repeat(64) } } }))
    .toMatchObject({ status: 3, stdout: '', stderr: 'peer interactive maintenance: interactive_retention_unavailable\n' });
}));
test('fixed-result CLI retains the same reference and source before and after cleanup', () => withPublication(f => {
  f.markIndexed();
  expect(JSON.parse(f.run('result', f.ref, '--json').stdout)).toMatchObject({ reference: f.published.reference, source: f.source, availability: 'available' });
  f.cleanup(); const cleaned = f.run('result', f.ref, '--json');
  expect(cleaned.status).toBe(0);
  expect(JSON.parse(cleaned.stdout)).toMatchObject({ ref: f.ref, reference: f.published.reference, availability: 'cleaned', summaryKind: 'saved-model-summary', truncated: true, source: f.source });
}));
test('fixed-result CLI plain output retains cleaned availability', () => withPublication(f => {
  f.markIndexed(); f.cleanup(); expect(f.run('result', f.ref).stdout).toContain('Availability: cleaned');
}));
test('fixed-result CLI preserves the UTF-16 cutoff of a saved available summary', () => withPublication(f => {
  f.markIndexed();
  expect(JSON.parse(f.run('result', f.ref, '--json').stdout).textFallback).toBe('a'.repeat(8191) + '\ud83d');
  expect(f.run('result', f.ref).stdout.endsWith('\ufffd\n')).toBe(true);
}, 'a'.repeat(8191) + '😀 trailing'));
test('fixed-result CLI preserves the UTF-16 cutoff stored in an authentic cleanup receipt', () => withPublication(f => {
  f.markIndexed(); const request = f.request(); f.cleanup();
  expect(JSON.parse(f.readReceipt(request).stdout).versions[0].textFallback).toBe('a'.repeat(255) + '\ud83d');
  expect(JSON.parse(f.run('result', f.ref, '--json').stdout).textFallback).toBe('a'.repeat(255) + '\ud83d');
  expect(f.run('result', f.ref).stdout.endsWith('\ufffd\n')).toBe(true);
}, 'a'.repeat(255) + '😀 trailing'));
if (nativeResult) {
  for (const cleaned of [false, true]) test(`native fixed-result CLI reads a committed ${cleaned ? 'cleanup' : 'publication'} WAL`, () => withPublication(f => {
    f.markIndexed();
    const request = f.request();
    const receipt = cleaned ? f.cleanup() : null;
    const home = mkdtempSync(path.join(tmpdir(), 'peer-result-cold-wal-'));
    try {
      cpSync(f.root, home, { recursive: true, filter: source => !source.endsWith('store.sqlite-shm') });
      const database = path.join(home, 'project-runtime', f.owner.workspaceId, 'interactive-results', 'store.sqlite');
      const databaseBytes = readFileSync(database);
      const walBytes = readFileSync(`${database}-wal`);
      expect(walBytes.length).toBeGreaterThan(0);
      if (cleaned) {
        const read = Bun.spawnSync([nativeResult, 'result-cleanup-receipt'], {
          cwd: home, env: { HOME: home, PEER_AGENT_HOME: home, PATH: '/nonexistent' },
          stdin: Buffer.from(JSON.stringify(request)), stdout: 'pipe', stderr: 'pipe',
        });
        expect(read.exitCode).toBe(0);
        expect(read.stderr.toString()).toBe('');
        expect(JSON.parse(read.stdout.toString())).toEqual(receipt);
      }
      const result = Bun.spawnSync([nativeResult, 'result', f.ref, '--json'], {
        cwd: home, env: { HOME: home, PEER_AGENT_HOME: home, PATH: '/nonexistent' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ ref: f.ref, availability: cleaned ? 'cleaned' : 'available', source: f.source });
      expect(readFileSync(database)).toEqual(databaseBytes);
      expect(readFileSync(`${database}-wal`)).toEqual(walBytes);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }));
}
