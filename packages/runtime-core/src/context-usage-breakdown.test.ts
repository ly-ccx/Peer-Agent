import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeContextUsageBreakdown,
  composeContextUsageBreakdownFromRequest,
} from './context-usage-breakdown.ts';

test('classifies system, tools, skills, MCP, summary, and conversation', () => {
  const breakdown = composeContextUsageBreakdown({
    systemPrompt: 'You are Peer Agent. '.repeat(40),
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a local file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'skill__weather',
          description: 'Load weather skill instructions',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'mcp__docs__search',
          description: 'Search docs through MCP',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ],
    messages: [
      { role: 'system', content: 'Workspace reminder' },
      { role: 'user', content: 'hello '.repeat(80), _compaction: { method: 'llm' } },
      { role: 'user', content: 'continue the previous task with more detail '.repeat(40) },
    ],
  });

  assert.ok(breakdown);
  assert.equal(breakdown?.quality, 'projected');
  const ids = breakdown?.categories.map((row) => row.id) ?? [];
  assert.deepEqual(ids, [
    'system_prompt',
    'tool_definitions',
    'skills',
    'mcp_tools',
    'summarized_conversation',
    'conversation',
  ]);
  assert.equal(
    breakdown?.estimatedTokens,
    breakdown?.categories.reduce((sum, row) => sum + row.tokens, 0),
  );
});

test('uses system sections instead of the rendered prompt string', () => {
  const breakdown = composeContextUsageBreakdown({
    systemPrompt: 'should not be counted when sections exist',
    systemSections: [
      { id: 'core.identity', layer: 'L0_CORE', content: 'core identity '.repeat(20) },
      { id: 'project.instructions', layer: 'L3_INSTRUCTIONS', content: 'repo rules '.repeat(20) },
      { id: 'runtime.continuity', layer: 'L7_CONTINUITY', content: 'handoff summary '.repeat(20) },
    ],
    messages: [{ role: 'user', content: 'next step' }],
  });

  assert.ok(breakdown);
  const ids = breakdown?.categories.map((row) => row.id) ?? [];
  assert.ok(ids.includes('system_prompt'));
  assert.ok(ids.includes('rules'));
  assert.ok(ids.includes('summarized_conversation'));
  assert.ok(ids.includes('conversation'));
});

test('scales category estimates to the authoritative total', () => {
  const breakdown = composeContextUsageBreakdown({
    systemPrompt: 'short system',
    messages: [{ role: 'user', content: 'a much longer conversation that dominates occupancy '.repeat(30) }],
    authoritativeTokens: 1_000,
  });

  assert.ok(breakdown);
  assert.equal(breakdown?.quality, 'scaled');
  assert.equal(breakdown?.estimatedTokens, 1_000);
  assert.equal(
    breakdown?.categories.reduce((sum, row) => sum + row.tokens, 0),
    1_000,
  );
});

test('reads Anthropic canonical requests that store the prompt on system', () => {
  const breakdown = composeContextUsageBreakdownFromRequest({
    model: 'claude',
    system: 'You are Peer Agent with evidence discipline.',
    messages: [{ role: 'user', content: 'hello there' }],
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }],
  });

  assert.ok(breakdown);
  assert.ok(breakdown?.categories.some((row) => row.id === 'system_prompt'));
  assert.ok(breakdown?.categories.some((row) => row.id === 'conversation'));
});

test('reads the shared canonical request shape used by Desktop and TUI', () => {
  const breakdown = composeContextUsageBreakdownFromRequest({
    model: 'test-model',
    systemPrompt: 'You are Peer Agent.',
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hello there' }],
  }, 400);

  assert.ok(breakdown);
  assert.equal(breakdown?.quality, 'scaled');
  assert.equal(breakdown?.estimatedTokens, 400);
  assert.ok(breakdown?.categories.some((row) => row.id === 'system_prompt'));
  assert.ok(breakdown?.categories.some((row) => row.id === 'tool_definitions'));
  assert.ok(breakdown?.categories.some((row) => row.id === 'conversation'));
});

test('ignores non-message request payloads instead of inventing occupancy', () => {
  assert.equal(
    composeContextUsageBreakdownFromRequest({ messages: ['large history'] }),
    null,
  );
  assert.equal(composeContextUsageBreakdownFromRequest(null), null);
});
