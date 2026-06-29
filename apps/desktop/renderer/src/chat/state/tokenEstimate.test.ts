import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateAttachmentTokens,
  estimateConversationTokens,
} from './tokenEstimate.ts';
import type { ChatAttachment, ChatMsg } from './types.ts';

function img(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: 'a', name: '', mimeType: 'image/png', size: 0, kind: 'image', ...over };
}
function txt(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: 'a', name: '', mimeType: 'text/plain', size: 0, kind: 'text', ...over };
}
function msg(over: Partial<ChatMsg> = {}): ChatMsg {
  return { id: 'm', role: 'user', content: '', ...over };
}

describe('estimateTextTokens', () => {
  it('treats nullish as empty (0 tokens)', () => {
    assert.equal(estimateTextTokens(undefined), 0);
    assert.equal(estimateTextTokens(null), 0);
    assert.equal(estimateTextTokens(''), 0);
  });
  it('ceils length/4', () => {
    assert.equal(estimateTextTokens('a'), 1); // ceil(1/4)=1
    assert.equal(estimateTextTokens('abcd'), 1); // ceil(4/4)=1
    assert.equal(estimateTextTokens('abcde'), 2); // ceil(5/4)=2
  });
  it('stringifies non-strings', () => {
    assert.equal(estimateTextTokens(1234), 1); // "1234" => ceil(4/4)=1
  });
  it('counts CJK with higher weight than latin (~1.7 chars/token)', () => {
    // 17 个中文字符：按 /1.7 ≈ 10 token，明显高于旧的 /4 ≈ 5 token。
    const tokens = estimateTextTokens('中'.repeat(17));
    assert.ok(tokens >= 9 && tokens <= 11, `expected ~10 tokens, got ${tokens}`);
    assert.ok(tokens > Math.ceil(17 / 4), 'CJK must not be undercounted as /4');
  });
  it('adds CJK and latin segments additively', () => {
    // 17 中文(~10) + 40 latin(10) ≈ 20
    const tokens = estimateTextTokens(`${'中'.repeat(17)}${'a'.repeat(40)}`);
    assert.ok(tokens >= 19 && tokens <= 21, `expected ~20 tokens, got ${tokens}`);
  });
});

describe('estimateMessageTokens', () => {
  it('applies base overhead of 10 for an empty message', () => {
    assert.equal(estimateMessageTokens(msg()), 10);
  });
  it('adds content tokens', () => {
    assert.equal(estimateMessageTokens(msg({ content: 'abcd' })), 11); // 10 + 1
  });
  it('adds image attachment weight (800) plus name/text', () => {
    const m = msg({ attachments: [img({ name: 'abcd' })] });
    assert.equal(estimateMessageTokens(m), 10 + 1 + 0 + 800);
  });
  it('adds tool-call segment tokens (tool + args json + result)', () => {
    const m = msg({
      segments: [{ type: 'tool-call', tool: 'abcd', args: {}, result: 'abcd' }],
    });
    // 10 base + tool(1) + JSON.stringify({})="{}" => ceil(2/4)=1 + result(1)
    assert.equal(estimateMessageTokens(m), 10 + 1 + 1 + 1);
  });
  it('adds text segment tokens', () => {
    const m = msg({ segments: [{ type: 'text', content: 'abcd' }] });
    assert.equal(estimateMessageTokens(m), 10 + 1);
  });
});

describe('estimateAttachmentTokens', () => {
  it('returns 0 for empty list', () => {
    assert.equal(estimateAttachmentTokens([]), 0);
  });
  it('weights image at 800 and counts text/name', () => {
    assert.equal(estimateAttachmentTokens([img({ name: 'abcd' })]), 1 + 800);
    assert.equal(estimateAttachmentTokens([txt({ text: 'abcd' })]), 1);
  });
});

describe('estimateConversationTokens', () => {
  it('sums messages + draft + draft attachments, clamped to >= 0', () => {
    const total = estimateConversationTokens([msg({ content: 'abcd' })], 'abcd', [txt({ text: 'abcd' })]);
    // message: 10+1=11 ; draft: 1 ; draft attachment: 1
    assert.equal(total, 13);
  });
  it('is 0 for empty conversation', () => {
    assert.equal(estimateConversationTokens([], '', []), 0);
  });
});
