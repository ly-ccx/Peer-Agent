import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerifierPromptSource } from './sources/verifier-source.mjs';

test('verifier receives local plan approval history only as bounded factual context', () => {
  const source = createVerifierPromptSource();
  const render = approval => source.render(source.observe({ mode: 'explorer', verifierContext: {
    planId: 'p', verifierRunId: 'v', plan: { goal: 'Verify', approval },
  } }));
  const blocks = render({ decision: 'approve', confirmationId: 'plan:s', decidedBy: 'local_ui', decidedAt: '2026-10-02T04:00:00.000Z' });
  const brief = blocks.find(block => block.id === 'runtime.verifier.brief');
  assert.equal(brief.layer, 'L7_CONTINUITY');
  assert.match(brief.content, /plan approval.*decision=approve.*confirmationId=plan:s/);
  assert.match(brief.content, /decidedBy=local_ui.*2026-10-02T04:00:00.000Z/);
  assert.doesNotMatch(blocks.find(block => block.id === 'runtime.verifier.contract').content, /plan:s/);
  assert.match(render(undefined)[0].content, /plan approval.*unknown/);
  for (const invalid of [{ decision: 'claimed' }, { decision: 'approve', confirmationId: 'fake', decidedAt: 'invalid' }]) {
    assert.match(render(invalid)[0].content, /plan approval.*unknown/);
  }
  const classic = render({ decision: 'approve', confirmationId: 'classic-local-confirmation', decidedBy: 'user', decidedAt: '2026-10-02T04:00:00.000Z' });
  assert.match(classic[0].content, /confirmationId=classic-local-confirmation.*decidedBy=user/);
});

for (const stage of ['visual', 'evidence']) {
  for (const mode of ['explorer', 'chat']) {
    test(`${stage}/${mode}/verifier-context-source`, () => {
      const source = createVerifierPromptSource();
      const blocks = source.render(source.observe({ mode, verifierContext: { stage, planId: 'p', verifierRunId: 'v',
        plan: { goal: 'Inspect the current image', successCriteria: [] } } }));
      if (mode !== 'explorer') { assert.deepEqual(blocks, []); return; }
      const contract = blocks.find(block => block.id === 'runtime.verifier.contract');
      assert.equal(contract.layer, 'L6_MODE_REMINDER');
      if (stage === 'visual') {
        assert.match(contract.content, /ui_visual_judgment/);
        assert.match(contract.content, /No tools are available/);
        assert.match(contract.content, /inconclusive/);
        assert.match(contract.content, /clipped|truncated|overflow-hidden|unreadable/i);
        assert.match(contract.content, /failed/);
        assert.doesNotMatch(contract.content, /failedCriteria/);
      } else {
        assert.match(contract.content, /failedCriteria/);
        assert.doesNotMatch(contract.content, /ui_visual_judgment/);
      }
    });
  }
}

test('semantic criteria are assigned to this review, never presented as failed prerequisites', () => {
  const source = createVerifierPromptSource();
  const sections = source.render(source.observe({ mode: 'explorer', verifierContext: {
    planId: 'p', verifierRunId: 'v', plan: { successCriteria: [
      { id: 'semantic', kind: 'model_review', description: 'Facts have indexed evidence' },
      { id: 'human', kind: 'manual', description: 'User review' },
    ], criterionResults: [{ criterionId: 'semantic', passed: false }] },
  } }));
  const brief = sections.find(row => row.id === 'runtime.verifier.brief').content;
  assert.match(brief, /semantic \(model_review\) review=pending_this_verifier/);
  assert.doesNotMatch(brief, /semantic.*passed=false/);
  assert.match(brief, /human \(manual\) passed=false/);
  assert.match(sections.find(row => row.id === 'runtime.verifier.contract').content, /host records your version-bound judgment afterwards/);
});
