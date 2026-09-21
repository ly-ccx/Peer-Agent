import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { conversationGrew, markLabReportClosed, snapshotConversationSizes } from './lab-experiment.mjs';

test('startNewConversation waits for composer or new-chat instead of failing at 10s', () => {
  const source = fs.readFileSync(new URL('./lab-experiment.mjs', import.meta.url), 'utf8');
  assert.match(source, /Date\.now\(\) \+ 45000/);
  assert.match(source, /composer-ready/);
  assert.match(source, /newChat\.isVisible/);
  assert.match(source, /composer\.isVisible/);
  assert.doesNotMatch(source, /composer\.or\(newChat\)/);
  assert.doesNotMatch(source, /newChat\.waitFor\(\{ state: 'visible', timeout: 10000 \}\)/);
});

test('lab report closed is true only after the owned handle actually exited', () => {
  assert.equal(markLabReportClosed({ ok: true, signaled: true, exited: true }), true);
  assert.equal(markLabReportClosed({ ok: true, signaled: true, exited: false }), false);
  assert.equal(markLabReportClosed({ ok: true, signaled: true }), false);
  assert.equal(markLabReportClosed(null), false);
});

test('conversationGrew treats a new jsonl as the turn starting', () => {
  const labHome = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-lab-grew-'));
  const dir = path.join(labHome, 'conversations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '{}\n');
  const before = snapshotConversationSizes(labHome);
  assert.equal(conversationGrew(before, labHome), false);
  fs.writeFileSync(path.join(dir, 'new-session.jsonl'), '{"role":"user"}\n');
  assert.equal(conversationGrew(before, labHome), true, '新建会话文件必须算回合开始');
  fs.rmSync(labHome, { recursive: true, force: true });
});
