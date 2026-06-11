import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pathOf } from './data-store.mjs';
import {
  writePendingTask,
  readAndClearPendingTask,
  peekPendingTask,
  hasPendingTask,
  clearPendingTask,
} from './pending-task-store.mjs';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pending-task-'));
  // getDataHome() 每次读 env（不缓存），所以切换隔离根有效
  process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('write then read returns the same task payload', () => {
  const task = { sessionId: 'c1', task: '继续做任务续传', reason: 'restart' };
  const res = writePendingTask(task);
  assert.equal(res.ok, true);
  assert.equal(hasPendingTask(), true);

  const got = readAndClearPendingTask();
  assert.deepEqual(got, task);
});

test('read clears the file (read-and-clear, one-shot)', () => {
  writePendingTask({ sessionId: 'c1', task: 'x' });
  assert.equal(hasPendingTask(), true);

  const first = readAndClearPendingTask();
  assert.ok(first);
  // 第二次应为 null，文件已删
  assert.equal(hasPendingTask(), false);
  assert.equal(readAndClearPendingTask(), null);
});

test('peek returns the task but keeps the file (read without clear)', () => {
  const task = { sessionId: 'c1', task: 'peek-me' };
  writePendingTask(task);

  const peeked = peekPendingTask();
  assert.deepEqual(peeked, task);
  // peek 不清除：文件仍在，可再次读到
  assert.equal(hasPendingTask(), true);
  assert.deepEqual(peekPendingTask(), task);

  // consume 之后才清除
  const consumed = readAndClearPendingTask();
  assert.deepEqual(consumed, task);
  assert.equal(hasPendingTask(), false);
});

test('returns null when no pending task file exists', () => {
  assert.equal(hasPendingTask(), false);
  assert.equal(readAndClearPendingTask(), null);
});

test('corrupt file is discarded and returns null', () => {
  const file = pathOf('pendingTask');
  // 直接写入坏 JSON
  writeFileSync(file, '{ this is not valid json', 'utf8');
  assert.equal(hasPendingTask(), true);

  const got = readAndClearPendingTask();
  assert.equal(got, null);
  // 坏文件应被清掉，不阻塞后续启动
  assert.equal(existsSync(file), false);
});

test('unsupported version is discarded and returns null', () => {
  const file = pathOf('pendingTask');
  writeFileSync(
    file,
    JSON.stringify({ version: 999, createdAt: new Date().toISOString(), task: { prompt: 'x' } }),
    'utf8',
  );
  const got = readAndClearPendingTask();
  assert.equal(got, null);
  assert.equal(existsSync(file), false);
});

test('clearPendingTask removes the file and is a no-op when absent', () => {
  writePendingTask({ sessionId: 'c1', task: 'x' });
  assert.equal(hasPendingTask(), true);
  clearPendingTask();
  assert.equal(hasPendingTask(), false);
  // 再次清除不报错
  assert.doesNotThrow(() => clearPendingTask());
});

test('writePendingTask rejects non-object task', () => {
  assert.throws(() => writePendingTask(null));
  assert.throws(() => writePendingTask('nope'));
});

test('payload wraps task with version and createdAt metadata', () => {
  writePendingTask({ sessionId: 'c1', task: 'meta-check' });
  const file = pathOf('pendingTask');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(typeof raw.createdAt, 'string');
  assert.deepEqual(raw.task, { sessionId: 'c1', task: 'meta-check' });
});
