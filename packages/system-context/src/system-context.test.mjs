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
  'agent.construction-falsification',
  'agent.diagnosis-gate',
  'runtime.workspace',
  'runtime.provider',
  'runtime.attachments',
  'project.instructions',
  'runtime.contextExtensions',
  'runtime.reminders',
  'runtime.web-entry',
  'automation.intent-policy',
  'runtime.goal-plan',
  'runtime.goal-runner',
  'runtime.goal-checkpoint',
  'runtime.task-acceptance',
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

test('web task default entry is assembled as an L5 tool rule', () => {
  const assembled = assembleSystemContext({ mode: 'chat' });
  const section = assembled.sections.find((item) => item.id === 'runtime.web-entry');
  assert.ok(section);
  assert.equal(section.layer, 'L5_TOOL_RULES');
  assert.match(section.content, /browser_\*/);
  assert.match(section.content, /browser_external_\*/);
  assert.match(section.content, /Do not open Playwright/);
});

test('automation intent policy classifies ordinary chat without leaking into non-chat modes', () => {
  const chat = assembleSystemContext({ mode: 'chat' });
  const policy = chat.sections.find((section) => section.id === 'automation.intent-policy');
  assert.ok(policy);
  assert.equal(policy.layer, 'L5_TOOL_RULES');
  assert.match(policy.content, /High confidence:/);
  assert.match(policy.content, /Medium confidence:/);
  assert.match(policy.content, /Low confidence:/);
  assert.match(policy.content, /never creates an Automation/i);
  assert.match(policy.content, /Never ask the user for a workspace path or timezone/);
  assert.equal(chat.sections.some((section) => section.id === 'runtime.automation-create-state'), false);

  const goal = assembleSystemContext({
    mode: 'goal',
    automationCreateContext: {
      kind: 'automation_create',
      source: 'automation_center',
      status: 'collecting',
    },
  });
  assert.equal(goal.sections.some((section) => section.id === 'automation.intent-policy'), false);
  assert.equal(goal.sections.some((section) => section.id === 'runtime.automation-create-state'), false);
});

test('automation center entry and proposal lifecycle render from trusted conversation metadata', () => {
  const collecting = assembleSystemContext({
    mode: 'chat',
    automationCreateContext: {
      kind: 'automation_create',
      source: 'automation_center',
      status: 'collecting',
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
  });
  const entryState = collecting.sections.find((section) => section.id === 'runtime.automation-create-state');
  assert.ok(entryState);
  assert.equal(entryState.layer, 'L7_CONTINUITY');
  assert.match(entryState.content, /strong Automation Center entry/);
  assert.match(entryState.content, /Do not ask whether they want automation/);
  assert.equal(entryState.source.contextSource, 'automation_center');
  assert.equal(entryState.source.status, 'collecting');

  const proposed = assembleSystemContext({
    mode: 'chat',
    automationCreateContext: {
      kind: 'automation_create',
      source: 'chat',
      status: 'proposed',
      activeProposal: {
        proposalId: 'proposal-1',
        status: 'proposed',
      },
    },
  });
  const proposalState = proposed.sections.find((section) => section.id === 'runtime.automation-create-state');
  assert.ok(proposalState);
  assert.match(proposalState.content, /already awaiting user action/);
  assert.match(proposalState.content, /complete revised task and schedule/);
  assert.equal(proposalState.source.proposalId, 'proposal-1');
  assert.equal(proposalState.source.proposalStatus, 'proposed');
});

test('terminal automation creation states suppress unprompted replay', () => {
  const expectations = new Map([
    ['created', /Do not propose it again unless the user explicitly starts a new automation request/],
    ['cancelled', /Do not recreate the same proposal unless the user explicitly asks/],
    ['failed', /Do not claim success or retry unprompted/],
  ]);

  for (const [status, pattern] of expectations) {
    const context = assembleSystemContext({
      mode: 'chat',
      automationCreateContext: {
        kind: 'automation_create',
        source: 'chat',
        status,
      },
    });
    const state = context.sections.find((section) => section.id === 'runtime.automation-create-state');
    assert.ok(state);
    assert.match(state.content, pattern);
  }
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

test('chat and goal inject construction falsification between adaptive planning and diagnosis', () => {
  for (const mode of ['chat', 'goal']) {
    const context = assembleSystemContext({ mode });
    const ids = context.sections.map((section) => section.id);
    assert.ok(ids.includes('agent.construction-falsification'));
    assert.ok(
      ids.indexOf('agent.adaptive-planning')
        < ids.indexOf('agent.construction-falsification'),
    );
    assert.ok(
      ids.indexOf('agent.construction-falsification')
        < ids.indexOf('agent.diagnosis-gate'),
    );
    assert.match(context.rendered, /cross-product matrix/);
    assert.match(context.rendered, /single-axis suite is not completion/);
    assert.match(context.rendered, /File count is not the depth signal/);
  }

  const plan = assembleSystemContext({ mode: 'plan' });
  assert.equal(plan.sections.some((section) => section.id === 'agent.construction-falsification'), false);
});

test('task acceptance stays dark unless the host pins the original brief', () => {
  const bare = assembleSystemContext({ mode: 'chat' });
  assert.equal(bare.sections.some((section) => section.id === 'runtime.task-acceptance'), false);

  const pinned = assembleSystemContext({
    mode: 'chat',
    taskAcceptance: [
      'IMPORTANT: flatten_rename keys must be field names, not serialized aliases.',
      'Also, serialize_by_alias on a child must keep their own alias for unmapped fields.',
    ].join('\n'),
  });
  const section = pinned.sections.find((item) => item.id === 'runtime.task-acceptance');
  assert.ok(section);
  assert.equal(section.layer, 'L7_CONTINUITY');
  assert.match(section.content, /Host-pinned original task/);
  assert.match(section.content, /flatten_rename/);
  assert.match(section.content, /serialize_by_alias/);
});

