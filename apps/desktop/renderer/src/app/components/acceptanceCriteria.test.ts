import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import {
  acceptancePageMeta,
  formatEvidenceRef,
  pairAcceptanceCriteria,
  resolveEvidenceLabel,
} from './acceptanceCriteria.ts';

test('pairs success criteria with criterion results by id', () => {
  const rows = pairAcceptanceCriteria({
    successCriteria: [
      { id: 'c1', kind: 'manual', description: '有对照证据' },
      { id: 'c2', kind: 'manual', description: '尚未对照' },
    ],
    criterionResults: [
      { criterionId: 'c1', passed: true, evidenceRef: 'ev-1', detail: '已核对' },
    ],
  } as GoalPlan);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.result?.passed, true);
  assert.equal(rows[0]?.result?.evidenceRef, 'ev-1');
  assert.equal(rows[1]?.result, null);
});

test('returns empty when the plan has no criteria', () => {
  assert.deepEqual(pairAcceptanceCriteria(null), []);
  assert.deepEqual(pairAcceptanceCriteria({ successCriteria: [], criterionResults: [] } as unknown as GoalPlan), []);
});

test('never shows raw shell artifact URIs as evidence labels', () => {
  assert.equal(
    formatEvidenceRef('local-shell-artifact://shell_43c45df8-a7ba-4412-a6b6-d3a8f9d14866/stdout'),
    '命令输出',
  );
  assert.equal(formatEvidenceRef('tool-result://call-1'), '工具结果');
  assert.equal(formatEvidenceRef('file:///work/src/app.ts'), 'app.ts');
  assert.equal(
    resolveEvidenceLabel(
      'local-shell-artifact://shell-1/stdout',
      [{ ref: 'local-shell-artifact://shell-1/stdout', label: '统计条截图对照' }],
    ),
    '统计条截图对照',
  );
});

test('acceptance page meta keeps workspace and handoff, not a route dump', () => {
  assert.deepEqual(
    acceptancePageMeta({
      workspaceLabel: 'peer_agent',
      deliveryHandoffLabel: '正在合进源头',
    }),
    ['peer_agent', '正在合进源头'],
  );
  assert.deepEqual(acceptancePageMeta({ workspaceLabel: '  ', deliveryHandoffLabel: null }), []);
});
