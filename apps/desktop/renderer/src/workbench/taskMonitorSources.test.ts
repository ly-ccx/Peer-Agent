import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMsg } from '../chat/state/types.ts';
import { projectMonitorSources } from './taskMonitorSources.ts';

for (const kind of ['file', 'attachment', 'tool', 'web'] as const) {
  for (const scope of ['current', 'other']) {
    for (const present of [false, true]) {
      test(`sources ${kind}/${scope}/${present ? 'present' : 'absent'}`, () => {
        const message = { id: 'message-1', role: 'assistant', content: 'skill__ignored' } as ChatMsg;
        if (present && (kind === 'file' || kind === 'attachment')) message.attachments = [{
          id: 'att-1', name: '资料.txt', kind: 'text', mimeType: 'text/plain', size: 10,
          ...(kind === 'file' ? { filePath: '/workspace/资料.txt' } : {}),
        }];
        if (present && kind === 'tool') message.segments = [{ type: 'tool-call', tool: 'skill__actual', toolCallId: 'call-1' }];
        const tabs = present && kind === 'web' ? [{ id: 'tab-1', url: 'https://example.com/doc' }] : [];
        const result = projectMonitorSources(scope === 'current' ? [message] : [], scope === 'current' ? tabs : []);
        assert.equal(result.length, scope === 'current' && present ? 1 : 0);
        if (result.length) {
          const source = result[0];
          assert.equal(source.kind, kind);
          if (source.kind === 'file') assert.equal(source.path, '/workspace/资料.txt');
          if (source.kind === 'attachment') assert.equal(source.attachmentId, 'att-1');
          if (source.kind === 'tool') assert.equal(source.toolCallId, 'call-1');
          if (source.kind === 'web') assert.equal(source.tabId, 'tab-1');
        }
      });
    }
  }
}

test('sources exclude synthetic calls and invalid pages, deduplicate URLs and target latest tool call', () => {
  const messages = [{ id: 'm1', role: 'assistant', segments: [
    { type: 'tool-call', tool: 'skill__actual', toolCallId: 'old' },
    { type: 'tool-call', tool: 'skill__synthetic', toolCallId: 'fake', synthetic: true },
  ] }, { id: 'm2', role: 'assistant', segments: [
    { type: 'tool-call', tool: 'skill__actual', toolCallId: 'new' },
  ] }] as ChatMsg[];
  const result = projectMonitorSources(messages, [
    { id: 'a', url: 'about:blank' }, { id: 'b', url: 'invalid' },
    { id: 'c', url: 'https://example.com' }, { id: 'd', url: 'https://example.com/' },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { kind: 'tool', id: 'tool:skill__actual', label: 'actual', messageId: 'm2', toolCallId: 'new' });
});
