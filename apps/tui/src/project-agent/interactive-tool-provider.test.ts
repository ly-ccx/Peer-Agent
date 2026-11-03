import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalPlanStore } from '@peer-agent/runtime-node/storage';
import { resolveWorkSessionProfile } from '@peer-agent/runtime-node/project-agent';
import { encodeProviderToolResult } from '@peer-agent/runtime-node/providers';
import { createInteractiveRuntime } from '@peer-agent/runtime-node/interactive-results';
import { createTuiHost, type TuiExecutionContext } from '../tui-host.ts';
import { createInteractiveToolProvider } from './interactive-tool-provider.ts';

test('TUI executes readOnly publication through real host authorization and retains canonical material in model results', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-tui-interactive-')));
  mkdirSync(path.join(root, 'projects/bot-a'), { recursive: true });
  writeFileSync(path.join(root, 'projects/bot-a/profile.json'), JSON.stringify({ workspaceId: 'bot-a', agentConversationId: 'parent-a', status: 'active', displayName: 'Test', avatar: { kind: 'generated' } }));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  const model = { providerId: 'test', modelId: 'test', modelProviderId: 'test', family: 'test' };
  const plan = plans.createPlan({ planId: 'plan-a', conversationId: 'child-a', title: 'Compare costs', tasks: [], delegationOrigin: {
    workspaceId: 'bot-a', parentConversationId: 'parent-a', sessionId: 'session-a', readOnly: true, phase: 'running',
    anchorMessageId: 'anchor-a', inputId: 'input-a', modelSelection: { worker: model, explorer: model, verifier: model,
      source: { worker: 'global' }, resolvedAt: '2026-11-03T00:00:00Z' } } });
  let leased = true;
  const interactive = createInteractiveRuntime({ rootDir: path.join(root, 'project-runtime'), goalPlanStore: plans,
    conversationStore: { getPersistedConversationHistory: () => ({ messages: [] }) }, getBotConversationId: () => 'parent-a',
    holdsLease: () => leased, enabled: () => true, classifyContext: () => 'D3_private' });
  const host = createTuiHost({ workspaceRoot: root, userDataPath: root, accessLevel: 'full_local', goalPlanStore: plans,
    providers: [createInteractiveToolProvider(interactive)], captureExecution: interactive.captureExecution });
  let forgedApprovals = 0;
  const context: TuiExecutionContext = { sessionId: 'session-a', conversationId: 'child-a', streamId: 'stream-a', turnId: 'turn-a', turnIndex: 0, mode: 'goal',
    project: { workspaceId: 'bot-a', planId: plan.planId, sessionId: 'session-a', readOnly: true, holdsLease: () => leased },
    toolContext: { workspacePath: root, turnProfile: resolveWorkSessionProfile({ plan, kind: 'worker' }) },
    requestPermission: async () => { forgedApprovals++; return { granted: false }; } };
  try {
    const rows = Array.from({ length: 200 }, (_, id) => ({ id, cost: id + 1 }));
    writeFileSync(path.join(root, 'facts.json'), JSON.stringify(rows));
    const read = await host.execute('local.file.read', { path: 'facts.json' }, { ...context, toolCallId: 'read-a' });
    expect(read.result.status).toBe('completed');
    const notice = (read as any).interactiveMaterial;
    expect(notice).toBeDefined();
    expect(JSON.parse(encodeProviderToolResult({ result: read.result, execution: read, conversationId: 'child-a', toolCallId: 'read-a' }).content).interactiveMaterial).toEqual(notice);
    writeFileSync(path.join(root, 'facts.json'), '[]');
    const published = await host.execute('local.interactive.publish', { publication: { kind: 'create' }, title: 'Original observations', textFallback: 'Fixed data, no source refresh.',
      program: 'root=Metric("Total",@Total(@Data("facts"),"cost"))',
      inputs: [{ bindingId: 'facts', source: notice.source, selector: { path: ['json'] } }],
    }, { ...context, toolCallId: 'publish-a' });
    expect(published.result.status).toBe('completed');
    expect(forgedApprovals).toBe(0);
    const ref = (published.result.output as any).reference;
    expect(interactive.resultStore.getVersion(ref).content.bindings.facts).toEqual(rows);
    expect((published.grant as any).scope.kind).toBe('interactive-result');
    expect((published.grant as any).policyRevision).toContain('bot:bot-a:parent-a:');
    expect(plans.findEvidenceIndexRecords([(published.result.output as any).artifactRef])[0]?.userArtifacts?.[0]?.kind).toBe('interactive');
    const encoded = JSON.parse(encodeProviderToolResult({ result: published.result, execution: published, conversationId: 'child-a', toolCallId: 'publish-a' }).content);
    expect(encoded.output.reference).toEqual(ref);
    const verifier = { ...context, toolContext: { ...context.toolContext, turnProfile: resolveWorkSessionProfile({ plan, kind: 'verifier' }) } };
    expect((await host.execute('local.interactive.publish', {}, { ...verifier, toolCallId: 'forbidden-publish' })).result.status).toBe('denied');
    const inspected = await host.execute('local.interactive.inspect', { target: { kind: 'result', reference: ref }, view: 'evaluate' }, { ...verifier, toolCallId: 'inspect-a' });
    expect(inspected.result.status).toBe('completed');
    expect((inspected.result.output as any).text).toContain('20100');
    expect((await host.execute('local.file.write', { path: 'forbidden.txt', content: 'no' }, { ...context, toolCallId: 'forbidden-write' })).result.status).toBe('denied');
    leased = false;
    expect((await host.execute('local.interactive.inspect', { target: { kind: 'result', reference: ref }, view: 'metadata' }, { ...context, toolCallId: 'stale-read' })).result.status).toBe('denied');
  } finally { await host.dispose(); interactive.close(); rmSync(root, { recursive: true, force: true }); }
});
