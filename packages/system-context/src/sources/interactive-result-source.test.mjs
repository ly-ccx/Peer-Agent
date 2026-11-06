import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERACTIVE_CONTEXT } from '@peer-agent/interactive-content/context';
import { catalogIdentity, validateDraft } from '@peer-agent/interactive-content';
import { assembleSystemContext } from '../index.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const section = input => assembleSystemContext(input).sections.find(item => item.id === 'interactive-results');

test('the complete generated catalog matches the actual public SDK adapter and fits the explicit Source budget', async () => {
  assert.equal(INTERACTIVE_CONTEXT.specHash, await catalogIdentity());
  const admitted = section({ role: 'work_session', turnContext: { agentKind: 'worker' }, interactiveResultCapabilities: [PUBLISH, INSPECT] });
  assert.ok(admitted); assert.equal(admitted.layer, 'L5_TOOL_RULES'); assert.equal(admitted.trust, 'builtin');
  assert.equal(admitted.source.specHash, INTERACTIVE_CONTEXT.specHash);
  assert.ok(admitted.source.estimatedTokens <= 4096);
  assert.ok(Buffer.byteLength(admitted.content, 'utf8') <= 16 * 1024);
  for (const name of [...INTERACTIVE_CONTEXT.componentNames, ...INTERACTIVE_CONTEXT.functionNames]) assert.ok(admitted.content.includes(name + '('));
  const code = admitted.content.split('Example (model assumption; inputs=[]):\n')[1];
  assert.equal((await validateDraft({ title: 'Example', textFallback: 'Assumed example', program: code })).tree.typeName, 'Col');
  assert.match(admitted.content, /Same call ID always has identical parameters/);
  assert.match(admitted.content, /At most two content repairs/);
});

test('disabled/unprojected and Explorer contexts cannot admit language rules or promote program/material content', () => {
  for (const input of [{}, { role: 'work_session' }, { role: 'chat' }, { role: 'work_session', agentKind: 'explorer' }]) {
    assert.equal(section({ interactiveResultCapabilities: [PUBLISH, INSPECT], program: 'INJECTED_RULE', ...input }), undefined);
  }
  assert.equal(section({ role: 'work_session', agentKind: 'worker', interactiveResultCapabilities: [] }), undefined);
  const admitted = section({ role: 'work_session', agentKind: 'worker', interactiveResultCapabilities: [PUBLISH, INSPECT],
    interactiveProgram: 'INJECTED_RULE', interactiveCatalog: { content: 'INJECTED_RULE' }, interactiveMaterial: { text: 'INJECTED_RULE' } });
  assert.ok(admitted); assert.equal(admitted.content.includes('INJECTED_RULE'), false);
});

test('main Bot and Verifier receive only their actual bounded read rule, even with a forged publish capability in input', () => {
  for (const profile of [{ role: 'project_agent' }, { role: 'work_session', agentKind: 'verifier' }, { role: 'work_session', agentKind: 'visual_verifier' }]) {
    const admitted = section({ ...profile, interactiveResultCapabilities: [PUBLISH, INSPECT] });
    assert.ok(admitted); assert.deepEqual(admitted.source.capabilities, [INSPECT]);
    assert.deepEqual(admitted.source.components, []); assert.equal(admitted.content.includes('Components:'), false);
    assert.match(admitted.content, /not source business truth/);
  }
});
