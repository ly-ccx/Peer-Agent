import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceDeliveryProjection } from './evidence-deliveries.mjs';
import { createEvidenceReader } from './evidence-reader.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
const evidenceRef = 'tool-result://delivery';
const task = { sessionId: 'session', planId: 'plan' };
const record = { evidenceRef, conversationId: 'bot-chat', userArtifacts: [{ kind: 'code-change', ref: 'file:///project/changed.ts', label: 'changed.ts', preview: { kind: 'code', diffLines: ['-old', '+saved'] } }] };
const projection = (extra = {}) => createEvidenceDeliveryProjection({ getConversationId: id => id === 'bot' ? 'bot-chat' : 'other-chat',
  getPlan: () => ({ planId: 'plan', delegationOrigin: { workspaceId: 'bot', sessionId: 'session' } }),
  getSession: () => ({ sessionId: 'session', workspaceId: 'bot', report: { planId: 'plan' } }), ...extra });
test('only canonical UserArtifact metadata is projected, bounded, with no present-day filesystem or text inference', () => {
  const result = projection()(record, { workspaceId: 'bot' });
  assert.equal(result.deliveryStatus, 'available'); assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].reference.path, '/project/changed.ts');
  assert.equal(result.deliveries[0].savedPreview.text, '-old\n+saved'); assert.equal(result.deliveries[0].savedPreview.truncated, true);
  assert.deepEqual(projection()({ ...record, userArtifacts: undefined, artifactRefs: ['file:///project/a'], summary: 'created a' }, { workspaceId: 'bot' }).deliveries, []);
  const many = { ...record, userArtifacts: Array.from({ length: 20 }, (_, i) => ({ ...record.userArtifacts[0], ref: 'file:///project/' + i })) };
  assert.equal(projection()(many, { workspaceId: 'bot' }).deliveries.length, 8);
});
test('task provenance requires exact plan, session, workspace and report; no Bot fallback', () => {
  const planned = { ...record, planId: 'plan' };
  assert.deepEqual(projection()(planned, { workspaceId: 'bot' }).deliveries[0].reference.task, task);
  for (const context of [{ workspaceId: 'other' }, { workspaceId: 'bot', task: { sessionId: 'foreign', planId: 'plan' } }, { workspaceId: 'bot', task: null }]) {
    assert.equal(projection()(planned, context).deliveryStatus, 'scope_denied');
  }
  assert.equal(projection({ getSession: () => ({ sessionId: 'session', workspaceId: 'bot' }) })(planned, { workspaceId: 'bot' }).deliveryStatus, 'scope_denied');
  assert.equal(projection()(record, { workspaceId: 'bot', task }).deliveryStatus, 'scope_denied');
});
test('denial happens before history/artifact/external reads and legacy requests do not acquire delivery metadata', () => {
  let bodyReads = 0, externalReads = 0;
  const read = createEvidenceReader({ findRecords: refs => refs[0] === evidenceRef ? [{ ...record, artifactRefs: ['local-shell-artifact://fixture/stdout'] }] : [], projectDeliveries: projection(),
    readMessages: () => { bodyReads++; return []; }, readArtifact: () => { bodyReads++; return 'today'; }, readExternal: () => { externalReads++; } });
  assert.equal(read(evidenceRef, { context: { workspaceId: 'other' } }).deliveryStatus, 'scope_denied'); assert.equal(bodyReads, 0);
  assert.equal(read('tool-result://missing', { context: { workspaceId: 'bot' } }).availability, 'not_found'); assert.equal(externalReads, 0);
  assert.equal(read(evidenceRef).deliveries, undefined);
  const app = createProjectAgentApplicationService({ enabled: () => true, readEvidenceBody: read });
  assert.equal(app.readEvidence({ evidenceRef, context: { workspaceId: 'bot' } }).deliveries[0].artifactRef, record.userArtifacts[0].ref);
  assert.equal(app.readEvidence({ evidenceRef, context: { workspaceId: 'other' } }).code, 'SCOPE_DENIED');
});
test('unsafe/oversized image metadata stays unavailable instead of fetching a replacement', () => {
  for (const dataUrl of ['https://example.invalid/a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(300000)]) {
    const result = projection()({ ...record, userArtifacts: [{ kind: 'image', ref: 'image-id', label: 'Image', preview: { kind: 'image', dataUrl, width: 16, height: 16 } }] }, { workspaceId: 'bot' });
    assert.equal(result.deliveries[0].savedPreview, undefined); assert.equal(result.deliveries[0].previewUnavailable, true); assert.equal(result.deliveries[0].reference, undefined);
  }
});

test('existing Watch evidence remains readable only for its actual Bot, without being reclassified as a delivery', async () => {
  const { createScopedExternalEvidenceReader } = await import('./evidence-deliveries.mjs');
  let bodyReads = 0;
  const scoped = createScopedExternalEvidenceReader({ findWatch: ref => ref === 'watch-evidence://saved' ? { evidenceRef: ref, workspaceId: 'bot' } : null,
    readWatchBody: () => { bodyReads++; return { text: 'saved observation' }; } });
  assert.equal(scoped('watch-evidence://saved', { workspaceId: 'other' }).deliveryStatus, 'scope_denied');
  assert.equal(scoped('watch-evidence://saved', { workspaceId: 'bot', task }).deliveryStatus, 'scope_denied'); assert.equal(bodyReads, 0);
  const read = createEvidenceReader({ findRecords: () => [], readScopedExternal: scoped, readExternal: () => { throw Error('legacy fallback prohibited'); } });
  const result = read('watch-evidence://saved', { context: { workspaceId: 'bot' } }); assert.equal(result.text, 'saved observation'); assert.deepEqual(result.deliveries, []);
  assert.equal(read('watch-evidence://missing', { context: { workspaceId: 'bot' } }).availability, 'not_found');
});

test('path-like owner and plan IDs are rejected before reaching registry getters', () => {
  const forbidden = () => { throw Error('invalid IDs must not reach stores'); };
  const project = projection({ getConversationId: forbidden, getPlan: forbidden, getSession: forbidden });
  assert.equal(project(record, { workspaceId: '../other' }).deliveryStatus, 'scope_denied');
  assert.equal(project({ ...record, planId: '../plan' }, { workspaceId: 'bot' }).deliveryStatus, 'scope_denied');
  assert.equal(project(record, { workspaceId: 'bot', task: { sessionId: '../session', planId: 'plan' } }).deliveryStatus, 'scope_denied');
});
