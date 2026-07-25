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
  'runtime.workspace',
  'runtime.provider',
  'runtime.attachments',
  'project.instructions',
  'runtime.contextExtensions',
  'runtime.reminders',
  'runtime.goal-plan',
  'runtime.goal-runner',
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
