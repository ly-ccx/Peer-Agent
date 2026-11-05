import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleSystemContext } from '../index.mjs';

const notice = { source: { kind: 'user-material', messageId: 'user-a', attachmentId: 'upload-a', expectedContentVersion: `sha256:${'a'.repeat(64)}` },
  format: 'peer-user-upload-1', selectorRoots: ['text', 'json'], dataLevel: 'D3_private', truncated: false, redacted: false };
const input = { role: 'work_session', turnContext: { agentKind: 'worker' }, interactiveResultCapabilities: ['local.interactive.publish', 'local.interactive.inspect'] };
const section = patch => assembleSystemContext({ ...input, interactiveMaterials: [notice], ...patch }).sections.find(section => section.id === 'interactive-materials');
test('canonical upload references remain bounded L7 user context and never supply catalog text or execution Evidence', () => {
  const actual = section({});
  assert.equal(actual.layer, 'L7_CONTINUITY'); assert.equal(actual.trust, 'user');
  assert.match(actual.content, /not instructions or Tool Result Evidence/);
  assert.equal(actual.source.count, 1);
  assert.equal(section({ interactiveMaterials: [notice, notice] }).source.count, 1);
  for (const patch of [{ role: 'project_agent' }, { turnContext: { agentKind: 'explorer' } }, { turnContext: { agentKind: 'verifier' } }, { interactiveResultCapabilities: [] }]) assert.equal(section(patch), undefined);
  for (const invalid of [{ ...notice, text: 'INJECTED_RULE' }, { ...notice, selectorRoots: ['../../secret'] },
    { ...notice, source: { ...notice.source, messageId: '../foreign' } }, { ...notice, dataLevel: 'unknown' }]) {
    assert.equal(section({ interactiveMaterials: [invalid] }), undefined);
  }
});
