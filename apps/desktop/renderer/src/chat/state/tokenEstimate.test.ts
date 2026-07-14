import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateAttachmentTokens,
  estimateConversationHistoryTokens,
  estimateConversationHistoryTokensIncremental,
  estimateConversationTokens,
  estimateDraftTokens,
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
  it('splits history from the frequently changing draft while preserving the total', () => {
    const messages = [msg({ content: 'abcd' })];
    const draftAttachments = [txt({ text: 'abcd' })];
    const history = estimateConversationHistoryTokens(messages);
    const draft = estimateDraftTokens('abcd', draftAttachments);

    // history=10+1, draft text=1, attachment text=1 => 13
    assert.equal(history, 11);
    assert.equal(draft, 2);
    assert.equal(estimateConversationTokens(messages, 'abcd', draftAttachments), history + draft);
  });
  it('is 0 for empty conversation', () => {
    assert.equal(estimateConversationTokens([], '', []), 0);
  });

  it('reuses unchanged message estimates during streaming tail updates', () => {
    const stableUser = msg({ id: 'user', role: 'user', content: 'question' });
    const firstTail = msg({ id: 'assistant', role: 'assistant', content: 'a' });
    const first = estimateConversationHistoryTokensIncremental([stableUser, firstTail]);
    const nextTail = { ...firstTail, content: 'abcd' };
    const next = estimateConversationHistoryTokensIncremental([stableUser, nextTail], first, true);

    assert.equal(next.messageCount, 2);
    assert.equal(next.totalTokens, estimateConversationHistoryTokens([stableUser, nextTail]));
  });

  // 压缩感知：与 toApiMessages 同口径——只统计最后一条 compaction 之后的活跃消息 + 各 compaction 摘要。
  const compaction = (summary?: string) => ({
    method: 'rolling',
    originalMessageCount: 3,
    beforeTokens: 100,
    afterTokens: 20,
    ...(summary === undefined ? {} : { summary }),
  });

  it('counts only active messages after the last compaction boundary (pre-boundary originals excluded)', () => {
    const total = estimateConversationTokens([
      msg({ content: 'abcd' }), // 压缩点之前的原文：不计入
      msg({ content: 'summary', compaction: compaction() }), // compaction 本体跳过，摘要按 content 回退计入 ceil(7/4)=2
      msg({ content: 'abcd' }), // 活跃消息：10+1=11
    ], '', []);
    assert.equal(total, 11 + 2);
  });

  it('counts the compaction summary (prefers summary over content)', () => {
    const total = estimateConversationTokens([
      msg({ content: 'this-original-must-be-ignored' }), // 压缩点之前的原文：不计入
      msg({ content: 'xxxx', compaction: compaction('abcd') }), // 摘要 'abcd' => 1（优先于 content）
    ], '', []);
    assert.equal(total, 1);
  });

  it('matches the original full-sum behavior when there is no compaction', () => {
    const messages = [msg({ content: 'abcd' }), msg({ content: 'abcd' })];
    // 无 compaction：退化为全部消息求和 = 11 + 11
    assert.equal(estimateConversationTokens(messages, '', []), 22);
  });

  it('counts all compaction summaries but only originals after the last boundary', () => {
    const total = estimateConversationTokens([
      msg({ content: 'abcd' }), // 第一个压缩点之前：不计入
      msg({ content: 'x', compaction: compaction('ab') }), // 摘要 'ab' => 1
      msg({ content: 'abcd' }), // 两个压缩点之间：不计入
      msg({ content: 'x', compaction: compaction('abcdefgh') }), // 摘要 8 字符 => 2
      msg({ content: 'abcd' }), // 最后一条压缩之后的活跃消息：11
    ], '', []);
    assert.equal(total, 11 + 1 + 2);
  });
});
