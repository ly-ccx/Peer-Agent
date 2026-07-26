import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExplorerPromptSource } from '@peer-agent/system-context';

const sampleContext = {
  explorerId: 'exp-1',
  planId: 'plan-1',
  planTitle: 'Ship goal runner',
  request: {
    question: 'Where is the chat runtime entry?',
    reason: 'Runner needs evidence before editing.',
    scope: { include: ['apps/desktop/electron/main'], exclude: ['dist'] },
    budget: { maxToolCalls: 6 },
    exitCriteria: ['found entry file'],
  },
};

test('non-explorer mode renders nothing', () => {
  const source = createExplorerPromptSource();
  const observation = source.observe({ mode: 'goal', explorerContext: sampleContext });
  assert.deepEqual(source.render(observation), []);
});

test('explorer mode without context renders nothing', () => {
  const source = createExplorerPromptSource();
  const observation = source.observe({ mode: 'explorer', explorerContext: null });
  assert.deepEqual(source.render(observation), []);
});

test('explorer mode renders brief + contract', () => {
  const source = createExplorerPromptSource();
  const observation = source.observe({ mode: 'explorer', explorerContext: sampleContext });
  const sections = source.render(observation);
  assert.equal(sections.length, 2);

  const brief = sections.find((s) => s.id === 'runtime.explorer.brief');
  const contract = sections.find((s) => s.id === 'runtime.explorer.contract');
  assert.ok(brief, 'brief present');
  assert.ok(contract, 'contract present');

  assert.equal(brief.layer, 'L7_CONTINUITY');
  assert.match(brief.content, /exp-1/);
  assert.match(brief.content, /Where is the chat runtime entry/);
  assert.match(brief.content, /scope include:/);
  assert.match(brief.content, /scope exclude:/);
  assert.match(brief.content, /maxToolCalls=6/);

  assert.equal(contract.layer, 'L6_MODE_REMINDER');
  assert.match(contract.content, /readonly_explorer/);
  assert.match(contract.content, /Do not modify files/);
  assert.match(contract.content, /Use only evidenceRefs shown in tool results/);
  assert.match(contract.content, /summary, findings/);
});

test('budget defaults to 4 tool calls when unspecified', () => {
  const source = createExplorerPromptSource();
  const observation = source.observe({
    mode: 'explorer',
    explorerContext: { explorerId: 'exp-2', request: { question: 'q' } },
  });
  const sections = source.render(observation);
  const brief = sections.find((s) => s.id === 'runtime.explorer.brief');
  assert.match(brief.content, /maxToolCalls=4/);
});
