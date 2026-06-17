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
    assert.match(out, /not supported yet/);
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
  it('skips compaction messages and empty assistant messages', () => {
    const out = toApiMessages([
      msg({ role: 'user', content: 'q' }),
      msg({ role: 'assistant', content: '' }),
      msg({ role: 'assistant', content: 'a' }),
      msg({ role: 'assistant', content: 'ignored', compaction: { method: 'm', originalMessageCount: 1, beforeTokens: 1, afterTokens: 1 } }),
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });
});
