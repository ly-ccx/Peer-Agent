import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConstructionFalsificationPromptSource,
  renderConstructionFalsificationPrompt,
} from './construction-falsification-source.mjs';

test('construction falsification is injected only for self-driven modes', () => {
  const source = createConstructionFalsificationPromptSource();
  assert.equal(source.id, 'agent.construction-falsification');
  assert.equal(source.layer, 'L1_AGENT');

  for (const mode of ['chat', 'goal', undefined]) {
    const observation = source.observe(mode ? { mode } : {});
    assert.equal(observation.available, true);
    const sections = source.render(observation);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].id, 'agent.construction-falsification');
  }

  for (const mode of ['plan', 'explorer', 'compact']) {
    const observation = source.observe({ mode });
    assert.equal(observation.available, false);
    assert.deepEqual(source.render(observation), []);
  }
});

test('construction falsification requires a cross-axis matrix instead of a generic test reminder', () => {
  const content = renderConstructionFalsificationPrompt();
  assert.match(content, /cross-product matrix/);
  assert.match(content, /single-axis suite is not completion/);
  assert.match(content, /Unattended hosts/);
  assert.match(content, /Do not pad the suite with generic coverage/);
  assert.doesNotMatch(content, /please verify|test thoroughly/i);
});
