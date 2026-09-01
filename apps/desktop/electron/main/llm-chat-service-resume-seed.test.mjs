import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveResumeSeed } from './llm-chat-service.mjs';
import { mergeUsageAmounts } from './llm-chat-service.mjs';

function interruptedAssistantMessage() {
  return {
    id: 'a1',
    role: 'assistant',
    content: '已经生成了 6 分多钟的部分回复',
    segments: [
      { type: 'thinking', content: '先分析问题', kind: 'summary' },
      { type: 'text', content: '已经生成了 6 分多钟的部分回复' },
      { type: 'tool-call', tool: 'bash', displayName: 'bash', args: '{}', toolCallId: 'tc1', result: 'ok' },
    ],
    usage: { inputTokens: 100, outputTokens: 200 },
    timestamp: 1700000000000,
    interrupted: true,
  };
}

function fakeStore(messages) {
  return {
    getConversation(id) {
      return id === 'conv-1' ? { id, messages } : null;
    },
  };
}

describe('resolveResumeSeed（续写中断回复的种子解析）', () => {
  it('以既有 interrupted assistant 消息为种子：正文/segments/usage/时间戳齐全', () => {
    const store = fakeStore([
      { id: 'u1', role: 'user', content: '继续' },
      interruptedAssistantMessage(),
    ]);
    const seed = resolveResumeSeed('conv-1', 'a1', {
      resumeInterruptedReply: true,
      conversationStore: store,
    });
    assert.ok(seed);
    assert.equal(seed.messageId, 'a1');
    assert.equal(seed.content, '已经生成了 6 分多钟的部分回复');
    assert.equal(seed.segments.length, 3);
    assert.equal(seed.accumulatedThinking, '先分析问题');
    assert.deepEqual(seed.usage, { inputTokens: 100, outputTokens: 200 });
    assert.equal(seed.timestamp, 1700000000000);
  });

  it('非续写请求（普通发送 / regenerate）返回 null——从零开始的既有行为不变', () => {
    const store = fakeStore([
      { id: 'u1', role: 'user', content: 'hi' },
      interruptedAssistantMessage(),
    ]);
    assert.equal(resolveResumeSeed('conv-1', 'a1', {
      resumeInterruptedReply: false,
      conversationStore: store,
    }), null);
  });

  it('缺 conversationId / assistantMessageId / store 能力时返回 null（防御回退）', () => {
    assert.equal(resolveResumeSeed(null, 'a1', {
      resumeInterruptedReply: true,
      conversationStore: fakeStore([]),
    }), null);
    assert.equal(resolveResumeSeed('conv-1', null, {
      resumeInterruptedReply: true,
      conversationStore: fakeStore([]),
    }), null);
    assert.equal(resolveResumeSeed('conv-1', 'a1', {
      resumeInterruptedReply: true,
      conversationStore: null,
    }), null);
    assert.equal(resolveResumeSeed('conv-1', 'missing', {
      resumeInterruptedReply: true,
      conversationStore: fakeStore([]),
    }), null);
  });

  it('目标消息不是 assistant 时返回 null（防 renderer 传错 id）', () => {
    const store = fakeStore([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1700000000000 },
    ]);
    assert.equal(resolveResumeSeed('conv-1', 'u1', {
      resumeInterruptedReply: true,
      conversationStore: store,
    }), null);
  });

  it('thinking 种子按 segment join 规则重建：summary 间换行，非 summary 直接拼接', () => {
    const store = fakeStore([
      { id: 'u1', role: 'user', content: 'hi' },
      {
        ...interruptedAssistantMessage(),
        segments: [
          { type: 'thinking', content: '第一段总结', kind: 'summary' },
          { type: 'thinking', content: '第二段总结', kind: 'summary' },
          { type: 'thinking', content: '原始思考' },
        ],
      },
    ]);
    const seed = resolveResumeSeed('conv-1', 'a1', {
      resumeInterruptedReply: true,
      conversationStore: store,
    });
    assert.equal(seed.accumulatedThinking, '第一段总结\n第二段总结原始思考');
  });

  it('时间戳缺失/非法时回退 null（调用方回落 Date.now()）', () => {
    const store = fakeStore([
      { id: 'u1', role: 'user', content: 'hi' },
      { ...interruptedAssistantMessage(), timestamp: 'not-a-number' },
    ]);
    const seed = resolveResumeSeed('conv-1', 'a1', {
      resumeInterruptedReply: true,
      conversationStore: store,
    });
    assert.ok(seed);
    assert.equal(seed.timestamp, null);
  });
});

describe('mergeUsageAmounts（续写流的 usage 合并）', () => {
  it('中断前旧账 + 本轮增量按 token 字段相加', () => {
    assert.deepEqual(
      mergeUsageAmounts(
        { inputTokens: 100, outputTokens: 200, totalTokens: 300, cacheReadTokens: 10, cacheWriteTokens: 20 },
        { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 },
      ),
      { inputTokens: 101, outputTokens: 202, totalTokens: 303, cacheReadTokens: 14, cacheWriteTokens: 25 },
    );
  });

  it('非数值字段安全回退为 0 相加；turnUsage 的额外字段保留', () => {
    const merged = mergeUsageAmounts({ inputTokens: 50 }, { inputTokens: 5, requestIndex: 2 });
    assert.equal(merged.inputTokens, 55);
    assert.equal(merged.requestIndex, 2);
    assert.equal(merged.outputTokens, 0);
  });
});

describe('handleChatSend 续写跳过 goal 路由（契约级断言）', () => {
  // main.mjs 不导出 handleChatSend（进程内函数），这里用「源代码包含守卫」做契约
  // 回归：守卫一旦被误删，测试立刻红。比复制实现细节更稳。
  it('goal 路由块以 !resumeInterruptedReply 守卫', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
    assert.match(
      source,
      /if\s*\(\s*!resumeInterruptedReply\s*&&\s*\(mode === 'goal' \|\| mode === 'chat'\)/,
      'goal 路由块必须对续写请求跳过——否则「继续」会被当成新的用户回合',
    );
    assert.match(
      source,
      /if\s*\(!resumeInterruptedReply && \(mode === 'goal' \|\| mode === 'chat'\) && conversationId\)\s*\{\s*return Promise\.resolve\(outcomePromise\)/,
      'post-turn intake 收敛块必须对续写请求跳过',
    );
  });

  it('chat:send 透传 resumeInterruptedReply 并注入续写 runtimeReminder', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
    assert.match(source, /resumeInterruptedReply,/);
    assert.match(source, /id: 'resume-interrupted-reply'/);
  });
});
