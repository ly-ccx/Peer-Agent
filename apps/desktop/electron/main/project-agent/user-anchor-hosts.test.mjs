import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDelegationProvider } from '../runtime-gateway/local-delegation-provider.mjs';
import { createDesktopReplyComposer } from './reply-composer-port.mjs';
import { createProjectToolProvider } from '../../../../tui/src/project-agent/project-tool-provider.ts';

for (const host of ['desktop', 'tui']) test(`A12 ${host} preserves anchor provenance and still denies an ordinary wake`, async t => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-anchor-host-')); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let spawned = 0;
  const options = { rootDir, supervisor: { spawn: () => { spawned++; return { sessionId: 'actual', status: 'queued' }; } },
    objectives: {}, replyComposer: createDesktopReplyComposer(), verification: {}, proactivity: {}, checkModel: () => ({ ok: true }), memoryEnabled: () => false };
  const provider = host === 'desktop' ? createLocalDelegationProvider(options) : createProjectToolProvider(options);
  t.after(() => provider.dispose?.());
  const run = (name, args, ctx) => host === 'desktop' ? provider.executeCapability({ call: { toolCallId: `host-${name}`, capabilityId: `local.delegation.${name}`, arguments: args } }, ctx)
    : provider.execute(`local.delegation.${name}`, args, { ...ctx, sessionId: 'agent', toolCallId: `host-${name}` });
  const ctx = { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', conversationId: 'parent', turnId: 'turn', toolCallOrdinal: 1,
    currentInputAnchors: ['input-raw'], messages: [{ id: 'input-raw', inputId: 'raw', role: 'user', kind: 'user_input', content: '移除导航项' }] };
  const task = { anchorMessageIds: ['raw'], title: '导航', brief: '测试夹具', kind: 'docs', readOnly: false, requiredCapabilities: [], successCriteria: [{ kind: 'model_review', description: 'fixture' }] };
  const dispatched = await run('spawn_session', task, ctx);
  assert.equal(dispatched.result.status, 'success'); assert.equal(spawned, 1);
  assert.equal(dispatched.call.arguments.anchorMessageIds[0], 'raw');
  assert.equal(dispatched.result.output.anchorResolutions[0].messageId, 'input-raw');
  assert.equal(dispatched.result.evidence.toolCallId, 'host-spawn_session');
  const reply = await run('post_reply', { text: '已安排', replyTo: ['raw'] }, { ...ctx, toolCallOrdinal: 2 });
  assert.equal(reply.result.status, 'success'); assert.deepEqual(reply.result.output.message.replyTo, ['input-raw']);
  const denied = await run('spawn_session', task, { ...ctx, currentInputAnchors: [], turnId: 'wake' });
  assert.equal(denied.result.output.error, 'current_user_required'); assert.equal(spawned, 1);
});
