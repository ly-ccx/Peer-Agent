import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAttentionNativeController, installAttentionNativeFixture } from './bot-attention-native-fixture.mjs';

test('native attention delivery acknowledges once, preserves targets and rejects unknown commands', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-attention-native-'));
  const commandFile = path.join(root, 'command.json'), receiptFile = path.join(root, 'receipt.json');
  for (const file of [commandFile, receiptFile]) writeFileSync(file, JSON.stringify({ seq: 0 }));
  const deliveries = [];
  const stop = installAttentionNativeFixture({ commandFile, receiptFile,
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args) => deliveries.push(args) } }] } });
  const until = async (read, predicate) => {
    for (let n = 0; n < 100; n++) {
      const value = read(); if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('Native receipt missing');
  };
  const command = createAttentionNativeController({ commandFile, receiptFile, until });
  try {
    await command('signal', ['first', 'other']);
    assert.deepEqual(deliveries, [
      ['project-agent:changed', { workspaceIds: ['first', 'other'] }],
      ['project-agent:conversation-changed', { workspaceIds: ['first', 'other'] }],
    ]);
    const target = { workspaceId: 'other', conversationId: 'conversation', messageId: 'question' };
    await command('notify', target);
    assert.deepEqual(deliveries.at(-1), ['quick-chat:open-conversation', target]);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(deliveries.length, 3, 'polling an acknowledged sequence must not redeliver');
    await command('failRead'); assert.equal(globalThis.rcAttentionFailOnce, true);
    await command('failInput'); assert.equal(globalThis.rcAttentionFailInput, true);
    await assert.rejects(command('unrecognized'), /Unknown attention fixture action/);
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).ok, false);
    assert.equal(deliveries.length, 3);
  } finally {
    stop(); delete globalThis.rcAttentionFailOnce; delete globalThis.rcAttentionFailInput;
    rmSync(root, { recursive: true, force: true });
  }
});
