import test from 'node:test';
import assert from 'node:assert/strict';
import { botResourceReferences } from '@peer-agent/protocol';
import { projectBotConversationHistory } from './bot-conversation-history.mjs';
const call = path => ({ name: 'read_file', result: JSON.stringify({ kind: 'local_file_ref', tool: 'read_file', path, preview: 'private body' }) });

test('R2 projects bounded exact file-result targets without body or write replay', () => {
  const refs = botResourceReferences([{ toolCalls: [call('/a/f.md'), call('/a/f.md'), call('relative.md'),
    { name: 'shell', result: 'a filename.md' }, { name: 'read_file', input: { path: '/guessed.md' }, result: { success: false, output: call('/denied.md').result } }] }]);
  assert.deepEqual(refs, [{ path: '/a/f.md', tool: 'read_file' }]);
  assert.equal(JSON.stringify(refs).includes('private body'), false);
  assert.equal(botResourceReferences([{ toolCalls: Array.from({ length: 300 }, (_, i) => call(`/a/${i}.md`)) }]).length, 256);
});

test('R2 display projection associates out-of-order replies only through explicit turn identity', () => {
  const original = { messages: [{ id: 'reply', kind: 'agent_reply', turnId: 'turn-b', content: 'f.md' },
    { id: 'turn-a', kind: 'agent_turn', rounds: [{ toolCalls: [call('/a/f.md')] }] },
    { id: 'turn-b', kind: 'agent_turn', rounds: [{ toolCalls: [call('/b/f.md')] }] },
    { id: 'old', kind: 'agent_reply', content: 'f.md', resourceReferences: [{ path: '/forged' }] }] };
  const rows = projectBotConversationHistory(original);
  assert.equal(rows[0].resourceReferences[0].path, '/b/f.md');
  assert.equal(rows[3].resourceReferences, undefined);
  assert.equal(rows[1].rounds, undefined);
  assert.ok(original.messages[1].rounds);
  assert.equal(JSON.stringify(rows).includes('private body'), false);
});
