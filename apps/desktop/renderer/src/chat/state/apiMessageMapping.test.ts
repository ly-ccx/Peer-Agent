import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getApiContent,
  buildAttachmentText,
  getApiMessageContent,
  hasApiMessageContent,
  toApiMessages,
} from './apiMessageMapping.ts';
import type { ChatApiContentPart, ChatAttachment, ChatMsg } from './types.ts';

function msg(over: Partial<ChatMsg> = {}): ChatMsg {
  return { id: 'm', role: 'user', content: '', ...over };
}
function textAtt(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: 'a', name: 'n.txt', mimeType: 'text/plain', size: 4, kind: 'text', text: 'hi', ...over };
}
function imgAtt(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: 'i', name: 'p.png', mimeType: 'image/png', size: 10, kind: 'image', dataUrl: 'data:image/png;base64,xxx', ...over };
}

describe('getApiContent', () => {
  it('returns raw content for a user message without segments', () => {
    assert.equal(getApiContent(msg({ role: 'user', content: 'hello' })), 'hello');
  });
  it('drops thinking segments and joins text segments', () => {
    const out = getApiContent(msg({
      role: 'user',
      segments: [{ type: 'thinking', content: 'secret' }, { type: 'text', content: 'a' }, { type: 'text', content: 'b' }],
    }));
    assert.equal(out, 'a\n\nb');
  });
});

describe('buildAttachmentText', () => {
  it('renders a fenced block for text attachments', () => {
    const out = buildAttachmentText([textAtt({ name: 'f.txt', text: 'BODY' })]);
    assert.match(out, /Attached file: f\.txt/);
    assert.match(out, /BODY/);
    assert.match(out, /```/);
  });
  it('notes unsupported attachments without content', () => {
    const out = buildAttachmentText([textAtt({ kind: 'unsupported', name: 'x.bin', text: undefined })]);
    assert.match(out, /not inlined/);
  });
  it('pins workspace file mentions as a path, not inlined content', () => {
    const out = buildAttachmentText([textAtt({
      kind: 'unsupported',
      name: 'types.ts',
      sourceKind: 'workspace_file',
      workspaceRelPath: 'apps/desktop/renderer/src/chat/state/types.ts',
      text: undefined,
    })]);
    assert.match(out, /Workspace file mention: @apps\/desktop\/renderer\/src\/chat\/state\/types\.ts/);
    assert.doesNotMatch(out, /```/);
  });
  it('ignores image attachments (handled as parts)', () => {
    assert.equal(buildAttachmentText([imgAtt()]), '');
  });
});

describe('getApiMessageContent', () => {
  it('returns plain string when no attachments', () => {
    assert.equal(getApiMessageContent(msg({ content: 'hi' })), 'hi');
  });
  it('returns multimodal parts when image attachment present', () => {
    const content = getApiMessageContent(msg({ content: 'look', attachments: [imgAtt()] }));
    assert.ok(Array.isArray(content));
    const parts = content as ChatApiContentPart[];
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
  });
});

describe('hasApiMessageContent', () => {
  it('true for non-empty string, false for blank', () => {
    assert.equal(hasApiMessageContent('x'), true);
    assert.equal(hasApiMessageContent('   '), false);
  });
  it('true when a part has text or image url', () => {
    assert.equal(hasApiMessageContent([{ type: 'image_url', image_url: { url: 'u' } }]), true);
    assert.equal(hasApiMessageContent([{ type: 'text', text: ' ' }]), false);
  });
});

describe('toApiMessages', () => {
  it('skips empty assistant messages when there is no compaction boundary', () => {
    const out = toApiMessages([
      msg({ role: 'user', content: 'q' }),
      msg({ role: 'assistant', content: '' }),
      msg({ role: 'assistant', content: 'a' }),
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('sends only messages after the last compaction boundary', () => {
    const out = toApiMessages([
      msg({ role: 'user', content: 'old q' }),
      msg({ role: 'assistant', content: 'old a' }),
      msg({ role: 'assistant', content: 'summary 1', compaction: { method: 'm1', originalMessageCount: 2, beforeTokens: 10, afterTokens: 3 } }),
      msg({ role: 'user', content: 'middle q' }),
      msg({ role: 'assistant', content: 'summary 2', compaction: { method: 'm2', originalMessageCount: 3, beforeTokens: 20, afterTokens: 4 } }),
      msg({ role: 'assistant', content: '' }),
      msg({ role: 'user', content: 'new q' }),
      msg({ role: 'assistant', content: 'new a' }),
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'new q' },
      { role: 'assistant', content: 'new a' },
    ]);
  });

  it('replays completed assistant tool-call segments as structured tool pairs', () => {
    const out = toApiMessages([
      msg({
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        segments: [
          { type: 'text', content: 'I need to inspect.' },
          {
            type: 'tool-call',
            tool: 'bash',
            args: { command: 'pwd' },
            result: '/tmp/project',
            toolCallId: 'tool_call_1',
          },
          { type: 'text', content: 'Done.' },
        ],
      }),
    ]);

    assert.deepEqual(out, [
      { role: 'assistant', content: 'I need to inspect.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tool_call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"pwd"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'tool_call_1', name: 'bash', content: '/tmp/project' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('synthesizes a stable id for completed historical tool pairs without toolCallId', () => {
    const out = toApiMessages([
      msg({
        id: 'assistant:old',
        role: 'assistant',
        content: '',
        segments: [
          { type: 'tool-call', tool: 'read_file', args: { path: 'a.ts' }, result: 'content' },
        ],
      }),
    ]);

    assert.equal(out.length, 2);
    assert.equal(out[0].tool_calls?.[0]?.id, 'tool_call_assistant_old_0');
    assert.equal(out[1].tool_call_id, 'tool_call_assistant_old_0');
    assert.equal(out[1].name, 'read_file');
  });

  it('does not emit orphan structured tool calls for pending tool segments', () => {
    const out = toApiMessages([
      msg({
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        segments: [
          { type: 'text', content: 'About to inspect.' },
          { type: 'tool-call', tool: 'bash', args: { command: 'pwd' }, toolCallId: 'tool_call_pending' },
        ],
      }),
    ]);

    assert.equal(out.some((message) => Boolean(message.tool_calls?.length)), false);
    assert.equal(out.some((message) => message.role === 'tool'), false);
    assert.equal(out.length, 1);
    assert.match(String(out[0].content), /About to inspect/);
    assert.match(String(out[0].content), /Historical local capability record/);
  });
});
