import assert from 'node:assert/strict';
import test from 'node:test';

import { EVIDENCE_EXPORT_KIND } from '@peer-agent/runtime-core';
import { buildPlanEvidenceExport, serializeEvidenceExportDocument } from './goal-evidence-export.mjs';

function plan(overrides = {}) {
  return {
    planId: 'plan-export-1',
    conversationId: 'conv-export-1',
    title: 'Ship the close gate',
    status: 'completed',
    approval: {
      decision: 'approve',
      confirmationId: 'c1',
      decidedAt: '2026-08-22T08:00:00.000Z',
    },
    evidenceRefs: ['tool-result://call-1'],
    runTrace: {
      events: [{
        id: 'start-1',
        goalPlanId: 'plan-export-1',
        type: 'action_started',
        summary: 'Goal Runner started',
        evidenceRefs: [],
        createdAt: '2026-08-22T08:10:00.000Z',
      }],
    },
    resultAcceptance: {
      acceptedBy: 'user',
      acceptedAt: '2026-08-22T09:00:00.000Z',
    },
    ...overrides,
  };
}

test('export packs held refs and authorization, not invented model claims', () => {
  const document = buildPlanEvidenceExport(plan({
    criterionResults: [{
      criterionId: 'c1',
      passed: true,
      evidenceRef: 'model-said://done',
    }],
  }), {
    now: () => '2026-08-22T10:00:00.000Z',
    findIndexRecords: (refs) => refs.map((evidenceRef) => ({
      evidenceRef,
      createdAt: '2026-08-22T08:30:00.000Z',
    })),
  });

  assert.equal(document.kind, EVIDENCE_EXPORT_KIND);
  assert.equal(document.exportedAt, '2026-08-22T10:00:00.000Z');
  assert.equal(document.source.planId, 'plan-export-1');
  assert.equal(document.summary, 'Ship the close gate');
  assert.deepEqual(document.refs, ['tool-result://call-1']);
  assert.equal(document.metadata.authorization.planApproved, true);
  assert.equal(document.metadata.events, undefined);
  assert.equal(document.metadata.resultAcceptance.acceptedBy, 'user');
  assert.deepEqual(document.metadata.indexRecords, [{
    evidenceRef: 'tool-result://call-1',
    createdAt: '2026-08-22T08:30:00.000Z',
  }]);
  assert.doesNotMatch(JSON.stringify(document.refs), /model-said/);
  assert.doesNotMatch(serializeEvidenceExportDocument(document), /assistant text|I completed/i);
  assert.doesNotMatch(serializeEvidenceExportDocument(document), /Goal Runner|<html|依据时间线/i);
});

test('export returns null for a missing plan', () => {
  assert.equal(buildPlanEvidenceExport(null), null);
});
