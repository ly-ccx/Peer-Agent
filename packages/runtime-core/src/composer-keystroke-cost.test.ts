import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createInputPredictionController } from './input-prediction.ts';
import { createProjectInputRecovery } from './project-input-recovery.ts';
import { emptyInputDraft, type ProjectInputDraftSnapshot, type ProjectInputRecoveryPort } from '@peer-agent/protocol';

/**
 * 合成用例，不是本机 Electron 里逐字敲击的复现。
 * 它只证明按键处理本身不读取会话历史或计划正文，也不等待草稿 IPC 返回。
 */
test('keystrokes publish the draft locally and do not wait for a slow draft write', async () => {
  let resume = () => {};
  let block = true;
  const writes: string[] = [];
  let stored: ProjectInputDraftSnapshot = { revision: 0, draft: emptyInputDraft(), pending: [] };
  const port: ProjectInputRecoveryPort = {
    read: async () => ({ ok: true, snapshot: stored }),
    write: async request => {
      writes.push(request.draft.text);
      assert.equal('messages' in request, false);
      if (block) await new Promise<void>(resolve => { resume = () => resolve(); });
      stored = { ...stored, revision: stored.revision + 1, draft: { ...emptyInputDraft(), text: request.draft.text } };
      return { ok: true, revision: stored.revision };
    },
    submit: async () => ({ ok: false, code: 'NOT_SENT' }),
  };
  const history = Array.from({ length: 4000 }, (_, i) => ({ id: `m${i}`, content: 'x'.repeat(200) }));
  const session = createProjectInputRecovery({
    workspaceId: 'ws', surface: 'desktop', port, createId: () => 'id',
  });
  assert.equal(await session.load(), true);
  const started = performance.now();
  for (let i = 1; i <= 40; i += 1) session.edit({ text: '字'.repeat(i) });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `40 local keystrokes took ${elapsed}ms beside a ${history.length}-message fixture that the editor never received`);
  assert.equal(session.getSnapshot().draft.text, '字'.repeat(40));
  assert.equal(writes.length, 1);
  block = false;
  resume();
  await session.flush();
  assert.equal(writes.at(-1), '字'.repeat(40));
});

test('prediction requests stay debounced and carry the draft, not a transcript', async () => {
  const requests: string[] = [];
  let sawMessages = false;
  const controller = createInputPredictionController({
    port: {
      request: async request => {
        requests.push(request.draftText);
        sawMessages = 'messages' in request;
        return { kind: 'unavailable', reason: 'synthetic' };
      },
      cancel: async () => {},
      validate: async () => ({ kind: 'unavailable' }),
    },
    createId: () => 'id',
    now: () => 0,
    apply() {},
    debounceMs: { next_turn: 0, continuation: 0 },
  });
  const base = {
    workspaceId: 'ws', conversationId: 'c', surface: 'desktop_bot' as const,
    selectionStart: 0, selectionEnd: 0, contextVersion: 'reply-1',
    eligible: true, active: true, composing: false, quoteMessageId: undefined,
  };
  for (let i = 1; i <= 25; i += 1) {
    const text = '请'.repeat(i);
    controller.update({ ...base, text, selectionStart: text.length, selectionEnd: text.length });
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(requests, ['请'.repeat(25)]);
  assert.equal(sawMessages, false);
  controller.dispose();
});
