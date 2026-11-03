import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '@peer-agent/runtime-node/storage';
import { createInteractiveRuntime, appendInteractiveMaterialNotice } from '@peer-agent/runtime-node/interactive-results';
import { resolveWorkSessionProfile } from '@peer-agent/runtime-node/project-agent';
import { createRuntimeToolProjection } from '../tools/index.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { createLocalFileProvider } from '../runtime-gateway/local-file-provider.mjs';
import { installDesktopInteractiveRuntime, desktopInteractiveToolDefinitions, createDesktopInteractiveProvider,
  captureDesktopInteractiveExecution, interactiveMaterialCaptureEnabled } from './runtime-port.mjs';

test('Desktop projects only enabled role capabilities and returns real file observations through its Provider/SDK path', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-desktop-interactive-')));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const model = { providerId: 'test', modelId: 'test', modelProviderId: 'test', family: 'test' };
  const plan = plans.createPlan({ planId: 'plan-a', conversationId: 'child-a', title: 'Compare costs', tasks: [],
    delegationOrigin: { workspaceId: 'bot-a', parentConversationId: 'parent-a', sessionId: 'session-a', readOnly: true, phase: 'running',
      anchorMessageId: 'anchor-a', inputId: 'input-a', modelSelection: { worker: model, explorer: model, verifier: model,
        source: { worker: 'global' }, resolvedAt: '2026-11-03T00:00:00Z' } } });
  let enabled = true;
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans,
    conversationStore: { getPersistedConversationHistory: () => ({ messages: [] }) }, getBotConversationId: () => 'parent-a',
    holdsLease: () => true, enabled: () => enabled, classifyContext: () => 'D3_private' });
  const uninstall = installDesktopInteractiveRuntime({ runtime, enabled: () => enabled });
  t.after(() => { uninstall(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const profile = resolveWorkSessionProfile({ plan, kind: 'worker' });
  const capabilities = turnProfile => createRuntimeToolProjection({ projectionOptions: { mode: turnProfile.role === 'project_agent' ? 'project_agent' : 'goal',
    turnProfile, readOnlyWorkSession: true } }).projection.capabilities.map(tool => tool.capabilityId).filter(id => id.startsWith('local.interactive.'));
  assert.deepEqual(capabilities(profile), ['local.interactive.publish', 'local.interactive.inspect']);
  assert.deepEqual(capabilities({ role: 'project_agent', workspaceId: 'bot-a' }), ['local.interactive.inspect']);
  assert.deepEqual(capabilities({ ...profile, agentKind: 'explorer' }), []);
  assert.deepEqual(capabilities({ ...profile, agentKind: 'verifier' }), ['local.interactive.inspect']);
  const incomplete = createRuntimeToolProjection({ projectionOptions: { mode: 'goal', turnProfile: profile,
    excludeCapabilityPrefixes: ['local.interactive.inspect'] } });
  assert.equal(incomplete.projection.capabilities.some(tool => tool.capabilityId === 'local.interactive.publish'), false);
  assert.deepEqual(desktopInteractiveToolDefinitions(null), []);
  const toolContext = { conversationId: 'child-a', workspaceId: 'bot-a', turnProfile: profile };
  assert.equal(interactiveMaterialCaptureEnabled(toolContext), true);
  const host = createLocalToolHost({ workspaceRoot: root, userDataPath: root, sessionStore: { getSession: () => ({ locale: 'en-US' }) },
    providers: [createLocalFileProvider({ workspaceRoot: root }), createDesktopInteractiveProvider()], hookRunner: null });
  const rows = Array.from({ length: 200 }, (_, id) => ({ id, cost: id + 1 }));
  writeFileSync(path.join(root, 'facts.json'), JSON.stringify(rows));
  const readCall = { toolCallId: 'read-a', capabilityId: 'local.file.read', arguments: { path: 'facts.json' } };
  const actual = await host.execute({ call: readCall, sessionId: 'session-a' }, { toolContext: { ...toolContext, interactiveMaterialsEnabled: true } });
  const captured = captureDesktopInteractiveExecution({ ...actual, call: readCall }, toolContext);
  assert.ok(captured.interactiveMaterial, JSON.stringify(captured));
  assert.equal(Object.keys(captured.result).includes('materialObservation'), false);
  assert.ok(JSON.parse(appendInteractiveMaterialNotice('{}', captured)).interactiveMaterial);
  writeFileSync(path.join(root, 'facts.json'), '[]');
  let approvals = 0;
  const published = await host.execute({ sessionId: 'session-a', call: { toolCallId: 'publish-a', capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Observed costs', textFallback: 'Fixed original observations.',
    program: 'root=Metric("Total",@Total(@Data("facts"),"cost"))',
    inputs: [{ bindingId: 'facts', source: captured.interactiveMaterial.source, selector: { path: ['json'] } }],
  } } }, { toolContext, requestPermission: async request => { approvals++; assert.equal(request.scope.kind, 'interactive-result'); return { granted: true }; } });
  assert.equal(published.result.status, 'success', JSON.stringify(published.result.outputPreview));
  assert.equal(approvals, 1); assert.equal(published.grant.granted, true);
  assert.deepEqual(runtime.resultStore.getVersion(published.result.outputPreview.reference).content.bindings.facts, rows);
  assert.equal(plans.listEvidenceIndex()[0].userArtifacts[0].kind, 'interactive');
  enabled = false;
  assert.deepEqual(capabilities(profile), []);
  assert.equal(interactiveMaterialCaptureEnabled(toolContext), false);
});
