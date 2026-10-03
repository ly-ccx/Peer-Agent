import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnActivity } from './turn-activity.mjs';

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
