import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import { createConversationStore } from './index.mjs';

describe('createConversationStore options guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-store-options-'));
  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects positional string storeDir instead of silently using the real user store', () => {
    // 回归：createConversationStore(dir) 曾静默回落到 ~/.peer-agent/conversations，
    // 把测试会话写进用户真实会话库。存储根目录是数据边界，必须显式失败。
    assert.throws(() => createConversationStore(dir), /must be an object/);
  });

  it('rejects non-object options', () => {
    assert.throws(() => createConversationStore(null), /must be an object/);
    assert.throws(() => createConversationStore(42), /must be an object/);
    assert.throws(() => createConversationStore([dir]), /must be an object/);
  });

  it('rejects blank storeDir', () => {
    assert.throws(() => createConversationStore({ storeDir: '' }), /non-empty string/);
    assert.throws(() => createConversationStore({ storeDir: '   ' }), /non-empty string/);
    assert.throws(() => createConversationStore({ storeDir: 123 }), /non-empty string/);
  });

  it('accepts an explicit storeDir and writes only there', () => {
    const store = createConversationStore({ storeDir: dir });
    const conv = store.createConversation({ title: 'options-guard', mode: 'chat' });
    assert.ok(conv.id);
    assert.ok(existsSync(join(dir, 'index.jsonl')));
  });
});
