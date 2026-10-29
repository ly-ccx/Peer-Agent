import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSessionConversationFacts } from './session-conversation-facts.mjs';
import { buildSessionReport } from './session-report.mjs';

test('compact facts preserve report/source identity while excluding thinking, tools and compaction', () => {
  const history = { createdAt: '2026-01-01', messages: [
    { id: 'question', role: 'user', answerTo: 'real-question', content: 'answer' },
    { id: 'worker', role: 'assistant', content: 'concatenated narration', segments: [
      { type: 'thinking', content: 'private thinking' }, { type: 'text', content: 'final actual finding' },
      { type: 'tool', tool: 'read_file', result: 'large raw result' }] },
    { id: 'thinking', role: 'assistant', segments: [{ type: 'thinking', content: 'private' }] },
    { id: 'compact', role: 'assistant', _compaction: true, content: 'continuity only' },
  ] };
  const compact = projectSessionConversationFacts(history);
  assert.deepEqual(buildSessionReport({ planId: 'p', tasks: [] }, { sessionId: 's', status: 'running' }, compact),
    buildSessionReport({ planId: 'p', tasks: [] }, { sessionId: 's', status: 'running' }, history));
  assert.deepEqual(compact.interventions, [{ id: 'question' }]);
  assert.ok(!JSON.stringify(compact).includes('private')); assert.ok(!JSON.stringify(compact).includes('raw result'));
});
