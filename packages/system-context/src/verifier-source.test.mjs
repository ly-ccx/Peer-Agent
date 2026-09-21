import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerifierPromptSource } from './sources/verifier-source.mjs';

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
