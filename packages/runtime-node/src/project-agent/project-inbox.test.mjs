import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { delegationEventId } from './event-mapper.mjs';
import { createProjectInbox } from './project-inbox.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-05-inbox-'));
}

function event(kind, extra = {}) {
  const sessionId = extra.sessionId || 'session-1';
  const version = extra.version ?? kind;
  return {
    eventId: delegationEventId({ sessionId, kind, version, approvalId: extra.approvalId }),
    kind,
    sessionId,
    workspaceId: 'ws-1',
    at: extra.at || '2026-09-27T00:00:00.000Z',
    version: String(version),
    payload: extra.payload ?? null,
  };
}

test('重复 eventId 丢弃，重启后仍然只保留一条', () => {
  const root = tempRoot();
  try {
    const inbox = createProjectInbox({ rootDir: root });
    const row = event('session_started', { version: 1 });
    const first = inbox.append('ws-1', [row]);
    const second = inbox.append('ws-1', [row, row]);
    assert.equal(first.appended.length, 1);
    assert.equal(first.duplicates.length, 0);
    assert.deepEqual(second.duplicates, [row.eventId, row.eventId]);
    assert.equal(second.appended.length, 0);

    const restarted = createProjectInbox({ rootDir: root });
    const again = restarted.append('ws-1', [row]);
    assert.deepEqual(again.duplicates, [row.eventId]);
    const batch = restarted.takeBatch('ws-1');
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].seq, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('游标只在成功结束后推进，失败回合重放同一批', () => {
  const root = tempRoot();
  try {
    const inbox = createProjectInbox({ rootDir: root, mergeWindowMs: 2_000 });
    inbox.append('ws-1', [
      event('session_started', { version: 1, at: '2026-09-27T00:00:00.000Z' }),
      event('progress', { version: 'scan', at: '2026-09-27T00:00:01.000Z' }),
    ]);
    const batch = inbox.takeBatch('ws-1');
    assert.equal(batch.events.length, 2);
    const failed = inbox.commitBatch('ws-1', { throughSeq: batch.throughSeq, ok: false });
    assert.equal(failed.advanced, false);
    assert.equal(failed.seq, 0);
    const replay = inbox.takeBatch('ws-1');
    assert.deepEqual(replay.events.map((item) => item.eventId), batch.events.map((item) => item.eventId));

    const committed = inbox.commitBatch('ws-1', { throughSeq: replay.throughSeq, ok: true });
    assert.equal(committed.seq, batch.throughSeq);
    assert.equal(inbox.takeBatch('ws-1').events.length, 0);
    assert.equal(createProjectInbox({ rootDir: root }).cursor('ws-1').seq, batch.throughSeq);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('两秒窗口内的事件合成一批，窗口外的留到下一次', () => {
  const root = tempRoot();
  try {
    const inbox = createProjectInbox({ rootDir: root, mergeWindowMs: 2_000 });
    inbox.append('ws-1', [
      event('session_started', { version: 1, at: '2026-09-27T00:00:00.000Z' }),
      event('progress', { version: 'scan', at: '2026-09-27T00:00:01.500Z' }),
      event('needs_user', { approvalId: 'approval-1', at: '2026-09-27T00:00:03.000Z' }),
    ]);
    const first = inbox.takeBatch('ws-1');
    assert.deepEqual(first.events.map((item) => item.kind), ['session_started', 'progress']);
    inbox.commitBatch('ws-1', { throughSeq: first.throughSeq, ok: true });
    const second = inbox.takeBatch('ws-1');
    assert.deepEqual(second.events.map((item) => item.kind), ['needs_user']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归档已消费的旧事件后游标仍指向原来的序号', () => {
  const root = tempRoot();
  try {
    const inbox = createProjectInbox({
      rootDir: root,
      now: () => '2026-09-27T00:00:00.000Z',
      maxBytes: 1,
      archiveAfterMs: 7 * 24 * 60 * 60 * 1000,
    });
    const oldEvent = event('session_started', { version: 1, at: '2026-09-01T00:00:00.000Z' });
    inbox.append('ws-1', [oldEvent]);
    const consumed = inbox.takeBatch('ws-1');
    inbox.commitBatch('ws-1', { throughSeq: consumed.throughSeq, ok: true });
    const fresh = event('progress', { version: 'scan', at: '2026-09-27T00:00:00.000Z' });
    const written = inbox.append('ws-1', [fresh]);
    assert.equal(written.archived, 1);

    const cursorFile = path.join(root, 'ws-1', 'inbox-cursor.json');
    assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).seq, consumed.throughSeq);
    const archive = gunzipSync(readFileSync(path.join(root, 'ws-1', 'inbox-2026-09-01.jsonl.gz')));
    assert.match(archive.toString('utf8'), /session_started/);

    const restarted = createProjectInbox({ rootDir: root, maxBytes: 1 });
    assert.equal(restarted.cursor('ws-1').seq, consumed.throughSeq);
    const pending = restarted.takeBatch('ws-1');
    assert.deepEqual(pending.events.map((item) => item.eventId), [fresh.eventId]);
    const duplicate = restarted.append('ws-1', [oldEvent]);
    assert.deepEqual(duplicate.duplicates, [oldEvent.eventId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('进程重启后从游标继续，未消费的事件还在', () => {
  const root = tempRoot();
  try {
    const inbox = createProjectInbox({ rootDir: root, mergeWindowMs: 2_000 });
    inbox.append('ws-1', [
      event('session_started', { version: 1, at: '2026-09-27T00:00:00.000Z' }),
      event('failed', { version: 2, at: '2026-09-27T00:00:05.000Z' }),
    ]);
    const first = inbox.takeBatch('ws-1');
    inbox.commitBatch('ws-1', { throughSeq: first.throughSeq, ok: true });

    const restarted = createProjectInbox({ rootDir: root, mergeWindowMs: 2_000 });
    const rest = restarted.takeBatch('ws-1');
    assert.deepEqual(rest.events.map((item) => item.kind), ['failed']);
    restarted.commitBatch('ws-1', { throughSeq: rest.throughSeq, ok: false });
    const replay = createProjectInbox({ rootDir: root, mergeWindowMs: 2_000 }).takeBatch('ws-1');
    assert.deepEqual(replay.events.map((item) => item.eventId), rest.events.map((item) => item.eventId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
