import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isPromptTooLongResponse,
  runCompactionCheck,
} from './compaction-coordinator.mjs';

describe('chat compaction coordinator', () => {
  it('detects provider prompt-too-long responses', () => {
    assert.equal(isPromptTooLongResponse(413, ''), true);
    assert.equal(isPromptTooLongResponse(400, 'context_length_exceeded'), true);
    assert.equal(isPromptTooLongResponse(400, 'Maximum context length exceeded'), true);
    assert.equal(isPromptTooLongResponse(500, 'temporary outage'), false);
  });

  it('does not emit compaction events when no context window is configured', async () => {
    const events = [];
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await runCompactionCheck({
      messages,
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false);
    assert.equal(result.messages, messages);
    assert.deepEqual(events, []);
  });

  it('settles the banner to idle when a started compaction does not compact', async () => {
    // emergency 强制发出 start；真·全量压缩（0011）下唯一的 compacted:false force 分支是
    // 「无任何非 system 消息」（convMsgs.length===0）。回归点：发过 start 后必须补发 idle，
    // 否则压缩横幅悬挂、界面卡在运行中。
    const events = [];
    const result = await runCompactionCheck({
      messages: [{ role: 'system', content: 'system' }],
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      emergency: true,
      force: true,
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false);
    const stages = events
      .filter((e) => e.channel === 'chat:compaction')
      .map((e) => e.payload.stage);
    assert.deepEqual(stages, ['start', 'idle']);
  });

  it('rethrows when a compacted persist fails and does not double-settle the banner', async () => {
    // 大量消息 + force 触发结构化压缩 (compacted:true);persistCompaction 抛错。
    // 回归点:错误必须向上抛出(交由 sendMessage 终态兜底),且 done 之后不再补发 idle。
    const events = [];
    const messages = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} ${'x'.repeat(200)}`,
    }));

    await assert.rejects(
      () =>
        runCompactionCheck({
          messages,
          systemPrompt: 'system',
          contextWindow: 0,
          providerConfig: null,
          signal: new AbortController().signal,
          persistCompaction: async () => {
            throw new Error('persist boom');
          },
          conversationId: 'c1',
          streamId: 's1',
          force: true,
          webContents: {
            send(channel, payload) {
              events.push({ channel, payload });
            },
          },
        }),
      /persist boom/,
    );

    const stages = events
      .filter((e) => e.channel === 'chat:compaction')
      .map((e) => e.payload.stage);
    // done 既是 start 的收尾,catch 分支不应再补发 idle。
    assert.equal(stages.includes('idle'), false);
  });
});
