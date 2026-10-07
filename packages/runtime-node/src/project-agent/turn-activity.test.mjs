import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnActivity } from './turn-activity.mjs';

test('tool duration uses host timestamps even when both events reach activity together', () => {
  const a = createTurnActivity({ now: () => '2026-10-06T00:00:10Z' });
  a.begin({ turnId: 't', visible: true });
  a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: 'r', tool: 'read_file', startedAtMs: 1791244800000 });
  a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'r', startedAtMs: 1791244800000, endedAtMs: 1791244802250, result: { ok: true } });
  const step = a.snapshot().segments[0];
  assert.equal(Date.parse(step.finishedAt) - Date.parse(step.startedAt), 2250);
});
import { toolActivityPreview } from '@peer-agent/protocol';

test('real deltas arrive before completion, with bounded tools and no private reasoning', () => {
  const pushed = [];
  const activity = createTurnActivity({ workspaceId: 'w', conversationId: 'c', publish: value => pushed.push(value) });
  activity.begin({ turnId: 't', replyTo: ['input-i'], startedAt: '2026-10-04T00:00:00Z', visible: true });
  activity.round();
  activity.accept('chat:stream:thinking', { streamId: 't', content: 'private reasoning' });
  activity.accept('chat:stream:delta', { streamId: 't', content: 'Hello' });
  assert.equal(activity.snapshot().segments[0].text, 'Hello');
  activity.accept('chat:stream:delta', { streamId: 't', content: ' world' });
  activity.accept('chat:stream:tool-call', { streamId: 't', toolCallId: 'x', tool: 'read_file', args: { secret: 'private args' } });
  activity.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'x', result: '{"ok":true,"secret":"private result"}' });
  const snapshot = activity.snapshot();
  assert.equal(snapshot.segments[0].text, 'Hello world');
  assert.equal(snapshot.segments[1].status, 'done');
  assert.doesNotMatch(JSON.stringify(snapshot), /private/);
  activity.finish('done');
  assert.equal(pushed.at(-1).phase, 'done');
  assert.ok(pushed.at(-1).revision > pushed[0].revision);
  activity.dispose();
});

test('tool boundaries split public updates, token deltas append, failure keeps updates and recovery replaces them', () => {
  const a = createTurnActivity({ workspaceId: 'w', conversationId: 'c' });
  a.begin({ turnId: 't', visible: true }); a.round();
  const send = (channel, payload) => a.accept(channel, { streamId: 't', ...payload });
  send('chat:stream:thinking', { content: 'PRIVATE_THINKING' });
  send('chat:stream:delta', { content: '我先核对' });
  send('chat:stream:delta', { content: '说明。' });
  send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', args: { path: 'README.md' } });
  send('chat:stream:tool-result', { toolCallId: 'read', result: { ok: true } });
  send('chat:stream:delta', { content: '说明已经读取。' });
  const updates = a.snapshot().segments.filter(segment => segment.kind === 'text');
  assert.deepEqual(updates.map(({ id, text }) => ({ id, text })), [
    { id: 'text-1', text: '我先核对说明。' }, { id: 'text-2', text: '说明已经读取。' },
  ]);
  send('chat:stream:tool-progress', { tool: 'post_reply', toolCallId: 'reply', replyText: '未接受的结论' });
  a.finish('error');
  assert.equal(a.snapshot().replyText, '');
  assert.deepEqual(a.snapshot().segments.filter(segment => segment.kind === 'text'), updates);
  assert.doesNotMatch(JSON.stringify(a.snapshot()), /PRIVATE_THINKING/);
  a.begin({ turnId: 'r', visible: true }); a.round();
  a.accept('chat:stream:delta', { streamId: 'r', content: '废弃尝试' });
  a.accept('chat:stream:provider-recovery', { streamId: 'r', toProviderId: 'new' });
  a.accept('chat:stream:delta', { streamId: 'r', content: '重试后的公开说明' });
  assert.deepEqual(a.snapshot().segments.filter(segment => segment.kind === 'text').map(segment => segment.text), ['重试后的公开说明']);
  a.dispose();
});

test('post_reply preview is withdrawn on rejection or suppression; wake text stays private', () => {
  const activity = createTurnActivity({ workspaceId: 'w', conversationId: 'c' });
  activity.begin({ turnId: 't', replyTo: ['u'], visible: true });
  activity.accept('chat:stream:tool-progress', { streamId: 't', tool: 'post_reply', toolCallId: 'r', replyText: 'Draft' });
  assert.equal(activity.snapshot().replyText, 'Draft');
  activity.accept('chat:stream:tool-call', { streamId: 't', tool: 'post_reply', toolCallId: 'r', args: { text: 'Draft' } });
  activity.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'r', result: JSON.stringify({ ok: false, error: 'denied' }) });
  assert.equal(activity.snapshot().replyText, '');
  activity.accept('chat:stream:tool-progress', { streamId: 'old', tool: 'post_reply', replyText: 'stale' });
  assert.equal(activity.snapshot().replyText, '');
  activity.begin({ turnId: 'wake', replyTo: [], visible: false });
  activity.accept('chat:stream:delta', { streamId: 'wake', content: 'quiet text' });
  activity.accept('chat:stream:tool-progress', { streamId: 'wake', tool: 'post_reply', replyText: 'quiet draft' });
  assert.equal(activity.snapshot(), null);
  activity.dispose();
});


test('nested denied, suppressed, and quiet replies withdraw a draft; total text is bounded', () => {
  const a = createTurnActivity({ workspaceId: 'w', conversationId: 'c' });
  a.begin({ turnId: 't', visible: true });
  for (const result of [
    { status: 'denied' },
    { ok: true, outputPreview: { legacyResult: { ok: true, output: { suppressed: true } } } },
    { ok: true, output: { ok: true, surfacing: 'digest' } },
    { ok: true, output: { ok: true, meta: { surfacing: 'silent' } } },
  ]) {
    a.accept('chat:stream:tool-progress', { streamId: 't', tool: 'post_reply', toolCallId: 'r', replyText: 'private draft' });
    a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'r', result: JSON.stringify(result) });
    assert.equal(a.snapshot().replyText, '');
  }
  for (let i = 0; i < 10; i++) {
    a.round(); a.accept('chat:stream:delta', { streamId: 't', content: 'x'.repeat(10000) });
  }
  assert.equal(a.snapshot().segments.reduce((n, item) => n + (item.text?.length || 0), 0), 32000);
  a.finish('stopped');
  a.accept('chat:stream:delta', { streamId: 't', content: 'late' });
  assert.doesNotMatch(JSON.stringify(a.snapshot()), /late/);
  a.dispose();
});


test('tool results with textual output end normally; nested denial is never shown as completion', () => {
  const a = createTurnActivity(); a.begin({ turnId: 't', visible: true });
  for (const [id, result, status] of [['read', { ok: true, output: 'file text' }, 'done'], ['denied', { ok: true, outputPreview: { legacyResult: { status: 'denied' } } }, 'error']]) {
    a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: id, tool: 'read_file' });
    a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: id, result: JSON.stringify(result) });
    assert.equal(a.snapshot().segments.find(segment => segment.id === id).status, status);
  }
  a.dispose();
});


test('active model is a copied turn snapshot and follows provider recovery', () => {
  const activity = createTurnActivity({ workspaceId: 'w', conversationId: 'c' });
  const selection = { modelProviderId: 'm', reasoningEffort: 'high' };
  activity.begin({ turnId: 't', modelSelection: selection, visible: true });
  selection.modelProviderId = 'next';
  const snapshot = activity.snapshot();
  assert.equal(snapshot.modelSelection.modelProviderId, 'm');
  snapshot.modelSelection.reasoningEffort = 'low';
  assert.equal(activity.snapshot().modelSelection.reasoningEffort, 'high');
  activity.accept('chat:stream:provider-recovery', { streamId: 't', toProviderId: 'fallback' });
  assert.equal(activity.snapshot().modelSelection.modelProviderId, 'fallback');
  activity.dispose();
});

test('live tools expose actual targets and bounded parameters before results, with independent snapshots', () => {
  let clock = '2026-10-05T00:00:01Z';
  const a = createTurnActivity({ now: () => clock }); a.begin({ turnId: 't', visible: true });
  a.accept('chat:stream:tool-progress', { streamId: 't', toolCallId: 'r', tool: 'read_file', path: 'README.md', receivedChars: 25 });
  assert.equal(a.snapshot().segments[0].status, 'preparing');
  assert.equal(a.snapshot().segments[0].input, undefined);
  clock = '2026-10-05T00:00:02Z';
  a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: 'r', tool: 'read_file', args: { path: 'README.md', token: 'secret-value' } });
  const snapshot = a.snapshot(), step = snapshot.segments[0];
  assert.equal(step.status, 'running'); assert.equal(step.startedAt, clock);
  assert.equal(step.summary, 'README.md'); assert.equal(step.result, undefined);
  assert.equal(JSON.parse(step.input.text).path, 'README.md'); assert.equal(step.input.redacted, true);
  step.input.text = 'mutated'; assert.notEqual(a.snapshot().segments[0].input.text, 'mutated');
  clock = '2026-10-05T00:00:05Z';
  a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'r', result: { ok: true, output: 'file content' } });
  assert.equal(a.snapshot().segments[0].finishedAt, clock);
  assert.match(a.snapshot().segments[0].result.text, /file content/);
  a.dispose();
});

test('display redaction handles nested credentials, textual tokens, reasoning, deep and large results', () => {
  const value = { nested: { authorization: 'private', content: 'Bearer abcdefgh123 sk-abcdefghijklmnop12345 password=hidden' }, thinking: 'private thoughts', apiKey: 'key', data: 'x'.repeat(10000) };
  const preview = toolActivityPreview(value, 4000);
  assert.equal(preview.redacted, true); assert.equal(preview.truncated, true);
  assert.ok(preview.text.length <= 4000); assert.doesNotMatch(preview.text, /private|hidden|abcdefgh123|abcdefghijklmnop12345/);
  const cyclic = {}; cyclic.next = cyclic;
  assert.equal(toolActivityPreview(cyclic, 2000).truncated, true);
  assert.deepEqual(toolActivityPreview(JSON.stringify({ reasoning: 'x'.repeat(100000) }), 4000), { text: '', truncated: true, redacted: true });
  const a = createTurnActivity(); a.begin({ turnId: 't', visible: true });
  for (let i = 0; i < 110; i++) {
    a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: String(i), tool: 'read_file', args: { path: 'file', content: 'x'.repeat(3000) } });
    a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: String(i), result: { output: 'y'.repeat(5000) } });
  }
  assert.equal(a.snapshot().segments.length, 100);
  assert.equal(a.snapshot().segments.reduce((n, s) => n + s.input.text.length + s.result.text.length, 0), 32000);
  assert.equal(a.snapshot().segments.at(-1).result.truncated, true);
  a.dispose();
});

test('stop and failure retain actual tool steps, end running states and reject late/stale events; recovery resets', () => {
  for (const [phase, status] of [['stopped', 'stopped'], ['error', 'error']]) {
    const a = createTurnActivity(); a.begin({ turnId: 't', visible: true });
    a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: 'r', tool: 'read_file', args: { path: 'file' } });
    a.finish(phase);
    assert.equal(a.snapshot().segments[0].status, status);
    a.accept('chat:stream:tool-result', { streamId: 't', toolCallId: 'r', result: { output: 'late' } });
    assert.equal(a.snapshot().segments[0].result, undefined);
    a.begin({ turnId: 'new', visible: true });
    a.accept('chat:stream:tool-call', { streamId: 't', toolCallId: 'r', tool: 'read_file' });
    assert.equal(a.snapshot().segments.length, 0);
    a.accept('chat:stream:tool-call', { streamId: 'new', toolCallId: 'r', tool: 'read_file' });
    a.accept('chat:stream:connection-recovery', { streamId: 'new' });
    assert.equal(a.snapshot().segments.length, 0);
    a.dispose(); assert.equal(a.snapshot(), null);
  }
});
