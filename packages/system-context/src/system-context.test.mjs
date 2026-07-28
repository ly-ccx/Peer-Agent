import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assembleSystemContext,
  createDefaultPromptSourceRegistry,
} from './index.mjs';
import {
  assembleSystemContext as assembleDesktopSystemContext,
  createDefaultPromptSourceRegistry as createDesktopRegistry,
} from '../../../apps/desktop/electron/main/prompt/index.mjs';

const DEFAULT_SOURCE_IDS = [
  'core.identity',
  'agent.brainstorming',
  'agent.adaptive-planning',
  'agent.diagnosis-gate',
  'runtime.workspace',
  'runtime.provider',
  'runtime.attachments',
  'project.instructions',
  'runtime.contextExtensions',
  'runtime.reminders',
  'runtime.goal-plan',
  'runtime.goal-runner',
  'runtime.goal-checkpoint',
  'agent.mcp-host',
  'runtime.explorer',
  'runtime.verifier',
  'runtime.continuity',
];

test('Desktop adapter exposes the canonical default Source registry', () => {
  assert.deepEqual(createDefaultPromptSourceRegistry().listSourceIds(), DEFAULT_SOURCE_IDS);
  assert.deepEqual(createDesktopRegistry().listSourceIds(), DEFAULT_SOURCE_IDS);
  assert.equal(assembleDesktopSystemContext, assembleSystemContext);
});

test('same runtime facts produce stable sections, checksums, and rendered hash', () => {
  const input = {
    workspacePath: '/tmp/peer-system-context',
    conversationId: 'conversation-1',
    provider: 'openai',
    model: 'gpt-test',
    mode: 'goal',
    effort: 'high',
    configInstructions: [{ id: 'language', content: 'Always reply in English.' }],
    continuityContext: [{ id: 'compact-1', method: 'structural', content: 'Continue the migration.' }],
  };
  const first = assembleSystemContext(input);
  const second = assembleSystemContext(input);

  assert.deepEqual(
    first.sections.map(({ id, layer, checksum }) => ({ id, layer, checksum })),
    second.sections.map(({ id, layer, checksum }) => ({ id, layer, checksum })),
  );
  assert.equal(first.rendered, second.rendered);
  assert.equal(first.snapshot.renderedHash, second.snapshot.renderedHash);
  assert.equal(first.snapshot.id, second.snapshot.id);
});

test('continuity injection keeps full summary body without fixed 12k truncation', () => {
  const longSummary = [
    'Current Work: restore unfinished continuity details.',
    `Pending Tasks:\n- last unfinished action marker ${'y'.repeat(13_500)}`,
    'Optional Next Step: continue the last unfinished action without asking the user to restate it.',
  ].join('\n\n');
  assert.ok(longSummary.length > 12_000);

  const context = assembleSystemContext({
    workspacePath: '/tmp/peer-system-context',
    continuityContext: [{
      id: 'compact-long',
      method: 'llm',
      originalMessageCount: 64,
      beforeTokens: 150000,
      afterTokens: 28000,
      summary: longSummary,
    }],
  });

  const continuity = context.sections.find((section) => section.id === 'runtime.continuity');
  assert.ok(continuity);
  assert.match(continuity.content, /integrity priority/);
  assert.doesNotMatch(continuity.content, /\[continuity summary truncated\]/);
  assert.ok(continuity.content.includes(longSummary));
  assert.equal(continuity.source.integrityFirst, true);
  assert.equal(continuity.source.summaries[0].summaryChars, longSummary.length);
  assert.match(context.rendered, /last unfinished action marker/);
});

test('goal-checkpoint source injects committed checkpoint facts', async () => {
  const { createGoalCheckpointPromptSource } = await import('./sources/goal-checkpoint-source.mjs');
  const { normalizeGoalCheckpoint } = await import('../../runtime-core/dist/index.js');
  const checkpoint = normalizeGoalCheckpoint({
    planId: 'plan-cp',
    runId: 'run-cp',
    status: 'committed',
    currentTaskId: 'task-2',
    objectiveNow: 'Resume after compaction',
    currentWork: 'Continue task-2',
    mostImportantFact: 'Do not restart completed work',
    handoffNote: 'Execute firstAction next',
    firstAction: {
      kind: 'edit',
      instruction: 'Continue task-2 implementation',
      successCheck: 'evidence written for task-2',
      requiredEvidenceRefs: [],
    },
    progress: {
      total: 2,
      completed: 1,
      failed: 0,
      blocked: 0,
      percent: 50,
      nextRunnableTaskIds: ['task-2'],
    },
  });
  const store = {
    getActivePlanByConversation() {
      return {
        planId: 'plan-cp',
        status: 'executing',
        runner: {
          enabled: true,
          status: 'resuming_after_compaction',
          runId: 'run-cp',
          contextCheckpoint: checkpoint,
          lastConsumedCheckpointSequence: 0,
        },
      };
    },
  };
  const source = createGoalCheckpointPromptSource();
  const observation = source.observe({ mode: 'goal', conversationId: 'c1', goalPlanStore: store });
  const sections = source.render(observation);
  assert.equal(sections.length, 1);
  assert.match(sections[0].content, /Active Goal execution checkpoint/);
  assert.match(sections[0].content, /Continue task-2 implementation/);
  assert.equal(sections[0].source.checkpointId, checkpoint.checkpointId);
});

test('goal-checkpoint source ignores non-committed checkpoints', async () => {
  const { createGoalCheckpointPromptSource } = await import('./sources/goal-checkpoint-source.mjs');
  const { normalizeGoalCheckpoint } = await import('../../runtime-core/dist/index.js');
  const checkpoint = normalizeGoalCheckpoint({
    planId: 'plan-cp',
    runId: 'run-cp',
    status: 'preparing',
    objectiveNow: 'x',
    currentWork: 'y',
    mostImportantFact: 'z',
    handoffNote: 'h',
    firstAction: {
      kind: 'inspect',
      instruction: 'continue',
      successCheck: 'ok',
      requiredEvidenceRefs: [],
    },
  });
  const store = {
    getActivePlanByConversation() {
      return {
        planId: 'plan-cp',
        status: 'executing',
        runner: {
          enabled: true,
          status: 'compacting_context',
          runId: 'run-cp',
          contextCheckpoint: checkpoint,
        },
      };
    },
  };
  const source = createGoalCheckpointPromptSource();
  const observation = source.observe({ mode: 'goal', conversationId: 'c1', goalPlanStore: store });
  assert.equal(observation.checkpoint, null);
  assert.deepEqual(source.render(observation), []);
});

