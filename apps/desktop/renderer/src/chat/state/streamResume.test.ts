import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMsg } from './types.ts';
import {
  canShowStreamResume,
  formatStreamErrorLabel,
  isRetryableStreamError,
  resolveStreamResumeTarget,
  restoreStreamErrorFromInterrupted,
  RESTORED_INTERRUPTED_STREAM_ERROR,
} from './streamResume.ts';

function message(
  id: string,
  role: ChatMsg['role'],
  content: string,
  extra: Partial<ChatMsg> = {},
): ChatMsg {
  return { id, role, content, timestamp: 1, ...extra };
}

describe('isRetryableStreamError', () => {
  it('treats network and transport failures as resumeable', () => {
    assert.equal(isRetryableStreamError('net::ERR_NETWORK_CHANGED'), true);
    assert.equal(isRetryableStreamError('fetch failed'), true);
    assert.equal(isRetryableStreamError('ECONNRESET'), true);
    assert.equal(isRetryableStreamError('empty_visible_model_response: 模型已结束'), true);
    assert.equal(isRetryableStreamError('repetition_detected'), true);
  });

  it('does not treat unrelated credential errors as transport failures', () => {
    assert.equal(isRetryableStreamError('invalid api key'), false);
    assert.equal(isRetryableStreamError(null), false);
    assert.equal(isRetryableStreamError(''), false);
  });
});

describe('resolveStreamResumeTarget', () => {
  it('regenerates the last interrupted assistant turn', () => {
    const messages = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'partial', { interrupted: true }),
    ];
    assert.deepEqual(resolveStreamResumeTarget(messages), {
      kind: 'regenerate',
      assistantIndex: 1,
    });
  });

  it('skips an empty assistant placeholder and retries the last user turn', () => {
    const messages = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', ''),
    ];
    assert.deepEqual(resolveStreamResumeTarget(messages), {
      kind: 'retry-user',
      userIndex: 0,
    });
  });

  it('retries the last user when the assistant placeholder was already stripped', () => {
    const messages = [message('u1', 'user', 'hello')];
    assert.deepEqual(resolveStreamResumeTarget(messages), {
      kind: 'retry-user',
      userIndex: 0,
    });
  });

  it('returns null when there is no user or assistant turn to continue', () => {
    assert.equal(resolveStreamResumeTarget([]), null);
    assert.equal(resolveStreamResumeTarget([message('s1', 'system', 'note')]), null);
  });
});

describe('canShowStreamResume', () => {
  const messages = [
    message('u1', 'user', 'hello'),
    message('a1', 'assistant', 'partial', { interrupted: true }),
  ];

  it('shows Resume for a retryable stream error on the current turn', () => {
    assert.equal(canShowStreamResume('net::ERR_NETWORK_CHANGED', messages, false), true);
  });

  it('hides Resume while streaming or when there is no error', () => {
    assert.equal(canShowStreamResume('net::ERR_NETWORK_CHANGED', messages, true), false);
    assert.equal(canShowStreamResume(null, messages, false), false);
  });

  it('still offers Resume for a non-transport error when a turn can continue', () => {
    assert.equal(canShowStreamResume('invalid api key', messages, false), true);
  });
});

describe('formatStreamErrorLabel', () => {
  it('keeps the repetition copy and humanizes common network interruptions', () => {
    assert.match(formatStreamErrorLabel('repetition_detected', true), /重复输出/);
    assert.equal(formatStreamErrorLabel('net::ERR_NETWORK_CHANGED', true), '网络已切换，回复中断。');
    assert.equal(
      formatStreamErrorLabel('net::ERR_NETWORK_CHANGED', false),
      'Network changed; the reply was interrupted.',
    );
    assert.equal(formatStreamErrorLabel('fetch failed', true), '网络中断，回复未完成。');
    assert.equal(formatStreamErrorLabel('ECONNRESET', true), '连接被重置，回复中断。');
  });

  it('passes unknown errors through unchanged', () => {
    assert.equal(formatStreamErrorLabel('invalid api key', true), 'invalid api key');
  });
});

describe('restoreStreamErrorFromInterrupted', () => {
  it('restores a readable network banner from an interrupted assistant turn', () => {
    const messages = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'partial', { interrupted: true }),
    ];
    assert.equal(
      restoreStreamErrorFromInterrupted(messages, null),
      RESTORED_INTERRUPTED_STREAM_ERROR,
    );
    assert.equal(
      formatStreamErrorLabel(restoreStreamErrorFromInterrupted(messages, null)!, true),
      '网络中断，回复未完成。',
    );
    assert.equal(
      canShowStreamResume(restoreStreamErrorFromInterrupted(messages, null), messages, false),
      true,
    );
  });

  it('keeps a live network error when switching back to the same interrupted turn', () => {
    const messages = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'partial', { interrupted: true }),
    ];
    assert.equal(
      restoreStreamErrorFromInterrupted(messages, 'net::ERR_NETWORK_CHANGED'),
      'net::ERR_NETWORK_CHANGED',
    );
    assert.equal(
      formatStreamErrorLabel('net::ERR_NETWORK_CHANGED', true),
      '网络已切换，回复中断。',
    );
  });

  it('does not leak a leftover banner onto a conversation that is not interrupted', () => {
    const continued = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'done'),
    ];
    const userAbort = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'partial'),
    ];
    assert.equal(restoreStreamErrorFromInterrupted(continued, 'fetch failed'), null);
    assert.equal(restoreStreamErrorFromInterrupted(userAbort, 'fetch failed'), null);
    assert.equal(restoreStreamErrorFromInterrupted([], 'fetch failed'), null);
  });

  it('does not restore a banner while the conversation is still streaming', () => {
    const messages = [
      message('u1', 'user', 'hello'),
      message('a1', 'assistant', 'partial', { interrupted: true }),
    ];
    assert.equal(
      restoreStreamErrorFromInterrupted(messages, 'net::ERR_NETWORK_CHANGED', true),
      null,
    );
  });
});
