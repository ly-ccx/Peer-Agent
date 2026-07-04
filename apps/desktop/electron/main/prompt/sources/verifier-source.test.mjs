import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerifierPromptSource } from './verifier-source.mjs';

const sampleContext = {
  verifierRunId: 'verifier-1',
  planId: 'plan-1',
  plan: {
    planId: 'plan-1',
    title: 'Ship verifier',
    goal: 'Add read-only verifier agent',
    successCriteria: [
      { id: 'c1', kind: 'test', description: 'goal runner tests pass' },
    ],
    criterionResults: [
      { criterionId: 'c1', passed: true, evidenceRef: 'tool-result://tests' },
    ],
  },
  tasks: [
    { taskId: 't1', title: 'implement verifier', status: 'completed', evidenceRefs: ['local-file://goal-runner'] },
  ],
  explorerReports: [
    { explorerId: 'exp-1', summary: 'verified prompt source', evidenceRefs: ['local-file://verifier-source'], confidence: 'high' },
  ],
};

test('non-explorer mode renders nothing', () => {
  const source = createVerifierPromptSource();
  const observation = source.observe({ mode: 'goal', verifierContext: sampleContext });
  assert.deepEqual(source.render(observation), []);
});

test('explorer mode without verifierContext renders nothing', () => {
  const source = createVerifierPromptSource();
  const observation = source.observe({ mode: 'explorer', verifierContext: null });
  assert.deepEqual(source.render(observation), []);
});

test('explorer mode renders verifier brief + readonly contract', () => {
  const source = createVerifierPromptSource();
  const observation = source.observe({ mode: 'explorer', verifierContext: sampleContext });
  const sections = source.render(observation);
  assert.equal(sections.length, 2);

  const brief = sections.find((s) => s.id === 'runtime.verifier.brief');
  const contract = sections.find((s) => s.id === 'runtime.verifier.contract');
  assert.ok(brief, 'brief present');
  assert.ok(contract, 'contract present');

  assert.equal(brief.layer, 'L7_CONTINUITY');
  assert.match(brief.content, /verifierRunId=verifier-1/);
  assert.match(brief.content, /t1 \[completed\]/);
  assert.match(brief.content, /c1 \(test\) passed=true evidenceRef=tool-result:\/\/tests/);
  assert.match(brief.content, /recent explorer reports:/);

  assert.equal(contract.layer, 'L6_MODE_REMINDER');
  assert.match(contract.content, /Verifier readonly contract/);
  assert.match(contract.content, /Do not modify files/);
  assert.match(contract.content, /do not update the goal plan/);
  assert.match(contract.content, /passed, failedCriteria/);
});
