import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interactiveArtifactRef } from '@peer-agent/protocol';
import { createBotProfileStore } from '@peer-agent/runtime-node/project-agent';
import { createInteractiveResultStore, createInteractiveRetention, createInteractiveStateStore, INTERACTIVE_RETENTION_SOURCES,
  runInteractiveValidation } from '@peer-agent/runtime-node/interactive-results';

const entry = path.join(import.meta.dir, 'index.tsx');

test('headless fixed-result CLI preserves identity and verified cleaned summaries without executing a model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-result-cli-'));
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const resultStore = createInteractiveResultStore({ rootDir: path.join(root, 'project-runtime'), assertCompatibility: () => true });
  const stateStore = createInteractiveStateStore({ resultStore });
  const executable = process.env.PEER_TEST_STANDALONE_BINARY;
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(executable ? [executable, ...args] : [process.execPath, entry, ...args],
      { cwd: root, env: { ...process.env, PEER_AGENT_HOME: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  try {
    const profiles = createBotProfileStore({ rootDir: root } as never);
    expect(profiles.create({ ...owner, displayName: 'Local Bot', agentConversationId: owner.conversationId }).ok).toBe(true);
    const draft = { publication: { kind: 'create' as const }, title: 'Fixed CLI trial', textFallback: 'Unverified.\u001b[31m ' + 'sample '.repeat(1800),
      inputs: [], program: 'root=Text("Stored program that must not be exported")' };
    const content = await runInteractiveValidation({ operation: 'validate', draft });
    const source = { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' };
    const published = resultStore.commitPublication({ owner, source, draft, content, provenance: [], dataLevel: 'D3_private',
      grant: { toolCallId: source.toolCallId, grantId: 'fixture', granted: true } }, () => true);
    const ref = interactiveArtifactRef(published.reference);
    expect(run('--help').stdout).toContain('peer result');
    expect(run('--version').status).toBe(0);
    expect(run('result', '--help').stdout).toContain('--json');
    expect(run('result', 'some-local-file').status).toBe(2);
    expect(run('result', ref, '--json')).toEqual({ status: 1, stdout: '', stderr: 'peer result: publication_index_pending\n' });
    resultStore.markIndexed(published.callRef, published.indexEntry);
    const output = run('result', ref, '--json');
    expect(output.status).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain('Stored program');
    const fixed = JSON.parse(output.stdout);
    expect(fixed).toMatchObject({ ref, reference: published.reference, availability: 'available', summaryKind: 'saved-model-summary', schemaVersion: 1, contentSchemaVersion: 1,
      title: draft.title, truncated: true, source, dataLevel: 'D3_private' });
    expect(fixed.textFallback).not.toContain('\u001b');
    expect(run('result', ref).stdout).toContain('Saved model summary, unverified (truncated)');
    const wrong = interactiveArtifactRef({ ...published.reference, owner: { ...owner, conversationId: 'foreign' } });
    expect(run('result', wrong)).toEqual({ status: 3, stdout: '', stderr: 'peer result: interactive_scope_denied\n' });
    const retirement = createInteractiveRetention({ resultStore, stateStore, assertOwner: () => true,
      acquireRoots: () => ({ sources: Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source => [source, 'sha256:' + '0'.repeat(64)])),
        pins: [], followupIds: [], assertCurrent: () => true, release() {} }) });
    const preview = retirement.preview(published.reference);
    retirement.cleanup({ reference: published.reference, expectedDigest: preview.cleanupDigest, requestId: 'cli-cleanup' });
    const cleaned = run('result', ref, '--json');
    expect(cleaned.status).toBe(0);
    expect(JSON.parse(cleaned.stdout)).toMatchObject({ ref, reference: published.reference, availability: 'cleaned', summaryKind: 'saved-model-summary', truncated: true, source });
    expect(run('result', ref).stdout).toContain('Availability: cleaned');
  } finally { stateStore.close(); resultStore.close(); rmSync(root, { recursive: true, force: true }); }
});
