import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitToolArgProgress } from './tool-arg-progress.mjs';

function makeWebContents() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

const baseCtx = (webContents, argsJson) => ({
  webContents,
  streamId: 'stream-1',
  toolCallId: 'call-1',
  toolName: 'edit_file',
  argsJson,
});

test('emits tool-progress with parsed path and estimated line count', () => {
  const wc = makeWebContents();
  const progress = {};
  const argsJson = '{"path":"src/a.ts","content":"line1\\nline2\\nline3"}';
  emitToolArgProgress(progress, baseCtx(wc, argsJson));

  assert.equal(wc.sent.length, 1);
  const { channel, payload } = wc.sent[0];
  assert.equal(channel, 'chat:stream:tool-progress');
  assert.equal(payload.streamId, 'stream-1');
  assert.equal(payload.toolCallId, 'call-1');
  assert.equal(payload.tool, 'edit_file');
  assert.equal(payload.path, 'src/a.ts');
  assert.equal(payload.receivedChars, argsJson.length);
  assert.equal(payload.receivedLines, 2); // two literal \n in the JSON
});

test('throttles repeat calls within interval when line count is unchanged', () => {
  const wc = makeWebContents();
  const progress = {};
  // First emit establishes lastProgressAt/Lines.
  emitToolArgProgress(progress, baseCtx(wc, '{"path":"a.ts","content":"x\\ny"}'));
  assert.equal(wc.sent.length, 1);
  // Same line count, immediately after -> throttled.
  emitToolArgProgress(progress, baseCtx(wc, '{"path":"a.ts","content":"x\\nyy"}'));
  assert.equal(wc.sent.length, 1);
});

test('throttles rapid line growth instead of emitting one IPC event per line', () => {
  const wc = makeWebContents();
  const progress = {};
  const originalNow = Date.now;
  Date.now = () => 1_000;
  try {
    emitToolArgProgress(progress, baseCtx(wc, '{"path":"a.ts","content":"line-0"}'));
    for (let line = 1; line <= 100; line += 1) {
      const content = Array.from({ length: line + 1 }, (_, index) => `line-${index}`).join('\n');
      emitToolArgProgress(progress, baseCtx(wc, JSON.stringify({ path: 'a.ts', content })));
    }
  } finally {
    Date.now = originalNow;
  }

  assert.equal(wc.sent.length, 1);
  assert.equal(wc.sent[0].payload.receivedLines, 0);
});

test('path is null until it appears in the accumulating JSON', () => {
  const wc = makeWebContents();
  const progress = {};
  emitToolArgProgress(progress, baseCtx(wc, '{"con'));
  assert.equal(wc.sent[0].payload.path, null);
});

test('does not throw and sends nothing when webContents is destroyed', () => {
  const wc = makeWebContents();
  wc.isDestroyed = () => true;
  const progress = {};
  emitToolArgProgress(progress, baseCtx(wc, '{"path":"a.ts","content":"x\\ny"}'));
  assert.equal(wc.sent.length, 0);
});

test('ignores missing progress state or ctx without throwing', () => {
  assert.doesNotThrow(() => emitToolArgProgress(null, baseCtx(makeWebContents(), '{}')));
  assert.doesNotThrow(() => emitToolArgProgress({}, null));
});

test('handles escaped quotes inside the path value', () => {
  const wc = makeWebContents();
  const progress = {};
  emitToolArgProgress(progress, baseCtx(wc, '{"path":"a\\"b.ts","content":""}'));
  assert.equal(wc.sent[0].payload.path, 'a"b.ts');
});
