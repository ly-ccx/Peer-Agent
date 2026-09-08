import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { GoalPlan, GoalExplorerStatus } from '@peer-agent/protocol';
import { goalInvestigation, investigationHidden } from './goalInvestigation.ts';
function plan(status: GoalExplorerStatus, batch = 'new', paused = false): GoalPlan {
  return { planId: 'p', status: paused ? 'paused' : 'executing', runner: { explorerBatch: { batchId: batch, total: 1, done: 1 }, explorers: [
    { explorerId: 'old', batchId: 'old', status: 'failed', request: { question: 'old' } },
    { explorerId: 'new', batchId: 'new', status, request: { question: '真实主题', reason: '原因' } },
  ] } } as GoalPlan;
}
for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
  for (const paused of [false, true]) {
    for (const batch of ['new', 'missing']) test(`${status} / paused=${paused} / batch=${batch}`, () => {
      const result = goalInvestigation(plan(status, batch, paused));
      assert.equal(result.items.length, batch === 'new' ? 1 : 0);
      if (batch === 'new') {
        assert.equal(result.items[0].question, '真实主题');
        assert.equal(result.items[0].status, paused && ['queued', 'running'].includes(status) ? 'paused' : status);
      }
      assert.equal(result.successful, status === 'completed' && batch === 'new');
      assert.equal(investigationHidden(result.key, result.successful, result.key), result.successful);
      assert.equal(investigationHidden(result.key, result.successful, 'previous-session'), false);
    });
  }
}
test('plan and batch identity isolate dismissal; no fabricated results from done counter', () => {
  const a = goalInvestigation(plan('running'));
  const b = goalInvestigation({ ...plan('running'), planId: 'other' });
  assert.notEqual(a.key, b.key);
  assert.equal(a.successful, false);
  assert.notEqual(a.key, goalInvestigation(plan('running', 'missing')).key);
});
test('attention items sort ahead of completed items; partial snapshots cannot close', () => {
  const p = plan('completed');
  const result = goalInvestigation({ ...p, runner: { ...p.runner!, explorerBatch: {batchId: 'new', total: 3, done: 3} } });
  assert.equal(result.successful, false);
  const mixed = goalInvestigation({ ...p, runner: { ...p.runner!, explorers: [...p.runner!.explorers!, { ...p.runner!.explorers![1], explorerId: 'failure', status: 'failed' }] } });
  assert.equal(mixed.items[0].status, 'failed');
  assert.equal(mixed.successful, false);
});
test('UI uses cancellable success-only timer, keyed conversation and reduced motion', () => {
  const component = readFileSync(new URL('./GoalInvestigationCards.tsx', import.meta.url), 'utf8');
  const parent = readFileSync(new URL('../GoalPlanPanel.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../styles/goal-investigation.css', import.meta.url), 'utf8');
  assert.match(component, /if \(!view.successful\) return/);
  assert.match(component, /clearTimeout\(timer\)/);
  assert.match(parent, /key=\{`\$\{conversationId\}:\$\{activePlan.planId\}`\}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none !important/);
  assert.match(css, /position: absolute/);
});
