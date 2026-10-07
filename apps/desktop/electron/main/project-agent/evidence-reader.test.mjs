import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceReader } from './evidence-reader.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';

const ref = 'tool-result://query';
const source = { evidenceRef: ref, conversationId: 'conversation', streamId: 'turn',
  toolName: 'get_session', capabilityId: 'local.delegation.get_session', createdAt: '2026-10-07T03:12:39.953Z' };
const history = [{ kind: 'agent_turn', turnId: 'turn', content: 'untrusted narration', rounds: [{ toolCalls: [
  { name: 'get_session', result: { ok: true, title: '熟悉项目', statusLabel: '执行受阻',
    evidenceRefs: [ref], origin: { modelSelection: 'internal' }, secret: 'never render' } },
] }] }];

function reader(overrides = {}) {
  return createEvidenceReader({ findRecords: refs => refs.includes(ref) ? [source] : [],
    readMessages: () => history, readArtifact: () => { throw Error('must not read workspace files'); }, ...overrides });
}

test('registered query recovers only the exact saved result, never narration, identifiers or current state', () => {
  const read = reader();
  assert.equal(read(ref).availability, 'available');
  assert.equal(read(ref).text, '熟悉项目\n执行受阻');
  assert.equal(read(ref).kind, 'observation');
  for (const record of [{ ...source, streamId: 'other' }, { ...source, toolName: 'cancel_session', capabilityId: 'local.delegation.cancel_session' },
    { ...source, capabilityId: 'forged' }]) {
    assert.equal(reader({ findRecords: () => [record] })(ref).availability, 'metadata_only');
  }
  const foreign = structuredClone(history);
  foreign[0].rounds[0].toolCalls[0].result.evidenceRefs = ['tool-result://foreign'];
  assert.equal(reader({ readMessages: () => foreign })(ref).availability, 'metadata_only');
  const failed = structuredClone(history);
  failed[0].rounds[0].toolCalls[0].result.ok = false;
  assert.equal(reader({ readMessages: () => failed })(ref).availability, 'metadata_only');
});

test('source exists without a body, unknown reference and IO failure stay distinct', () => {
  assert.equal(reader({ readMessages: () => [] })(ref).availability, 'metadata_only');
  assert.equal(reader()('tool-result://unknown'), null);
  assert.equal(reader({ readMessages: () => { throw Error('read failed'); } })(ref).availability, 'unavailable');
  const saved = reader({ findRecords: () => [{ ...source, bodyPreview: { kind: 'file', text: 'original snapshot' } }],
    readMessages: () => { throw Error('snapshot must not reread history'); } })(ref);
  assert.equal(saved.text, 'original snapshot');
  assert.equal(reader({findRecords:()=>[{...source,bodyPreview:{kind:'file',text:''}}]})(ref).availability,'available');
  assert.equal(reader({findRecords:()=>[{...source,artifactRefs:['artifact://missing']}],readArtifact:()=>'',readMessages:()=>[]})(ref).availability,'unavailable');
  assert.equal(reader({findRecords:()=>{throw Error('index IO');}})(ref).availability,'unavailable');
});

test('source-only batches are bounded and perform no history or artifact reads', () => {
  const read = reader({ readMessages: () => { throw Error('metadata only'); } });
  const app = createProjectAgentApplicationService({ enabled: () => true, readEvidenceBody: read });
  const batch = app.readEvidence({ evidenceRefs: [ref, ref, 'tool-result://missing'] });
  assert.equal(batch.ok, true);
  assert.deepEqual(batch.items, [{ evidenceRef: ref, toolName: 'get_session', createdAt: source.createdAt }, { evidenceRef: 'tool-result://missing' }]);
  assert.equal(app.readEvidence({ evidenceRefs: Array(101).fill(ref) }).ok, false);
  assert.equal(app.readEvidence({ evidenceRefs: ['../secret'] }).ok, false);
  const missing = createProjectAgentApplicationService({ enabled: () => true, readEvidenceBody: reader({ readMessages: () => [] }) }).readEvidence({ evidenceRef: ref });
  assert.equal(missing.code, 'BODY_NOT_SAVED');
  assert.equal(missing.availability, 'metadata_only');
  assert.equal(app.readEvidence({ evidenceRef: 'tool-result://missing' }).availability, 'not_found');
  const broken = createProjectAgentApplicationService({ enabled: () => true, readEvidenceBody: () => { throw Error('IO'); } });
  assert.equal(broken.readEvidence({ evidenceRef: ref }).code, 'READ_FAILED');
  assert.equal(createProjectAgentApplicationService({ enabled: () => false, readEvidenceBody: () => { throw Error('disabled'); } }).readEvidence({ evidenceRefs: [ref] }).code, 'PROJECT_AGENT_DISABLED');
});

test('historical text is bounded and redacted', () => {
  const rows = structuredClone(history);
  rows[0].rounds[0].toolCalls[0].result.title = 'Bearer secret-value\n' + '完整结论'.repeat(3000);
  const result = reader({ readMessages: () => rows })(ref);
  assert.ok(result.text.length <= 4000);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /secret-value/);
});
