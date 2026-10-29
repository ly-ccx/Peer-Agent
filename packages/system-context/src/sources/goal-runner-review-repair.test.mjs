import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalRunnerPromptSource } from './goal-runner-source.mjs';

test('repair context distinguishes host review from human confirmation and admits bounded failure facts', () => {
  const source = createGoalRunnerPromptSource();
  const plan = { planId: 'p', status: 'executing', goal: 'Inspect project',
    successCriteria: [{ id: 'c1', kind: 'model_review', description: 'Report explains repository identity' },
      { id: 'human', kind: 'manual', description: 'User approves release' }],
    runner: { status: 'running', phase: 'repair', intent: 'execute', verifierRuns: [{ verifierRunId: 'v1',
      status: 'failed', summary: 'Verifier found issues', report: {
        failedCriteria: [{ criterionId: 'c1', reason: 'Repository identity missing', evidenceRefs: ['tool-result://read'] }],
        missingEvidence: [{ taskId: 'read', reason: 'Recent commits were not inspected' }],
        recommendedNextAction: 'Read the Git metadata and update the report',
      } }] } };
  const facts = source.render(source.observe({ mode: 'goal', goalPlanStore: { getActivePlanByConversation: () => plan } }))
    .find(section => section.id.endsWith('.facts'));
  assert.match(facts.content, /\[host_review\] \(model_review\)/);
  assert.match(facts.content, /\[manual\] \(manual\)/);
  assert.match(facts.content, /Repository identity missing/);
  assert.match(facts.content, /Recent commits were not inspected/);
  assert.match(facts.content, /tool-result:\/\/read/);
  assert.match(facts.content, /Read the Git metadata and update the report/);
  assert.equal(facts.layer, 'L7_CONTINUITY');
  assert.doesNotMatch(facts.content, /\(manual\).*Report explains repository identity/);
  plan.runner.verifierRuns[0].report.failedCriteria = Array.from({ length: 100 }, () => ({ reason: 'x'.repeat(10000) }));
  const bounded = source.render(source.observe({ goalPlanStore: { getActivePlanByConversation: () => plan } }));
  assert.ok(bounded[0].content.length < 5000);
});
