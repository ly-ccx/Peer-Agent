import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVerifierMessage } from './goal-runner-host.mjs';
import { buildSessionReport } from './session-report.mjs';

test('verifier sees actual visible report as unverified material beside execution snapshots', () => {
  const plan = { planId: 'p', goal: 'NOT A REPORT', tasks: [] };
  const workerReport = buildSessionReport(plan, { sessionId: 's' }, { messages: [{ id: 'r', role: 'assistant',
    segments: [{ type: 'thinking', content: 'private reasoning' }, { type: 'text', content: 'Four sections with source paths' }] }] });
  const content = buildVerifierMessage({ plan, verifierRunId: 'v', workerReport,
    evidenceSnapshots: [{ evidenceRef: 'tool-result://read', output: 'actual read' }] });
  assert.match(content, /Four sections with source paths/);
  assert.match(content, /"verification":"unverified"/);
  assert.match(content, /tool-result:\/\/read/);
  assert.match(content, /unless a declared criterion explicitly requires a file artifact/);
  assert.doesNotMatch(content, /private reasoning/);
});

test('delegated verification retains the current focus without treating it as permission or evidence', () => {
  const content = buildVerifierMessage({ plan: { planId: 'p' }, verifierRunId: 'v',
    focus: 'Check only the four screenshots; report image_outside_read_scope if access is denied.' });
  assert.match(content, /Check only the four screenshots/);
  assert.match(content, /does not grant permissions or change the success criteria/);
});
