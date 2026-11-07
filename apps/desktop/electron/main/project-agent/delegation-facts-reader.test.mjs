import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createDelegationFactsReader } from './delegation-facts-reader.mjs';

const plan = (id, conversationId, workspaceId = 'ws') => ({
  planId: id, conversationId, status: 'executing', createdAt: '2026-10-02T00:00:00Z',
  delegationOrigin: { sessionId: `session-${id}`, workspaceId, phase: 'running' },
});

test('one current metadata read handles repeated plans without hydrating chat bodies or foreign plans', () => {
  const plans = Array.from({ length: 400 }, (_, i) => plan(String(i), 'large-legacy', 'other'));
  plans.push(plan('owned', 'owned'), plan('missing', 'missing'), plan('foreign-origin', 'owned', 'other'));
  let reads = 0; const hydrated = [];
  const read = createDelegationFactsReader({
    conversationStore: {
      listConversations(options) {
        reads++; assert.deepEqual(options.roles, ['default', 'project_agent', 'work_session']);
        assert.equal(options.includeMessageCount, false);
        return [{ id: 'large-legacy', workspaceId: 'other' }, { id: 'owned', workspaceId: 'ws' }];
      },
      getConversation() { assert.fail('must not read conversation bodies'); },
    },
    goalPlanStore: { listPlans: () => plans, getPlan(id) { hydrated.push(id); return plans.find(p => p.planId === id); } },
  });
  assert.deepEqual(read('ws').sessions.map(s => s.sessionId), ['session-owned']);
  assert.equal(reads, 1);
  assert.deepEqual(hydrated, ['owned', 'foreign-origin']);
});

test('real index includes all roles and archived conversations; each read observes an external writer', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-watch-metadata-'));
  try {
    const store = createConversationStore({ storeDir: root });
    const writer = createConversationStore({ storeDir: root });
    const rows = [undefined, 'project_agent', 'work_session'].map(role => writer.createConversation({ role, workspaceId: 'ws', title: role || 'default' }));
    writer.archiveConversation(rows[0].id);
    const plans = rows.map((row, i) => plan(String(i), row.id));
    const read = createDelegationFactsReader({ conversationStore: store, goalPlanStore: {
      listPlans: () => plans, getPlan: id => plans.find(p => p.planId === id),
    } });
    assert.equal(read('ws').sessions.length, 3);
    const fresh = writer.createConversation({ workspaceId: 'ws', title: 'External writer' });
    plans.push(plan('fresh', fresh.id));
    assert.equal(read('ws').sessions.length, 4);
    assert.equal(read('other').sessions.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing plans are omitted and current failure/dependency facts retain the existing projector', () => {
  const active = plan('active', 'c'); active.status = 'failed';
  const read = createDelegationFactsReader({
    conversationStore: { listConversations: () => [{ id: 'c', workspaceId: 'ws' }] },
    goalPlanStore: { listPlans: () => [active, { planId: 'deleted', conversationId: 'c' }], getPlan: id => id === 'active' ? active : null },
  });
  assert.equal(read('ws').sessions[0].status, 'failed');
  active.status = 'completed';
  assert.equal(read('ws').sessions[0].status, 'result_ready');
  assert.deepEqual(read(''), { sessions: [] });
});

test('an unchanged large plan is not parsed again on the next 30s watch read', () => {
  const result = 'x'.repeat(4_000_000);
  const body = {
    ...plan('big', 'owned'), status: 'completed', updatedAt: '2026-11-07T03:00:00.000Z',
    timing: { completedAt: '2026-11-07T03:00:00.000Z' },
    runner: { status: 'idle' },
    tasks: [{ taskId: 't', status: 'completed', updatedAt: '2026-11-07T03:00:00.000Z', result, subtasks: [] }],
  };
  let hydrations = 0;
  let stamp = 'body-v1';
  const read = createDelegationFactsReader({
    conversationStore: { listConversations: () => [{ id: 'owned', workspaceId: 'ws' }] },
    goalPlanStore: {
      listPlanMetadata: () => [body],
      planReadStamp: () => stamp,
      getPlan() { hydrations += 1; return body; },
    },
  });
  const firstStart = performance.now();
  const first = read('ws');
  const firstMs = performance.now() - firstStart;
  const secondStart = performance.now();
  const second = read('ws');
  const secondMs = performance.now() - secondStart;
  assert.equal(hydrations, 1);
  assert.equal(second.sessions[0].reportRevision, first.sessions[0].reportRevision);
  assert.ok(secondMs < 20, `cached watch read took ${secondMs}ms after a ${firstMs}ms hydration`);
  assert.ok(firstMs > secondMs * 5, `expected the full read (${firstMs}ms) to dwarf the cached read (${secondMs}ms)`);
  stamp = 'body-v2';
  body.tasks = [{ ...body.tasks[0], result: `${result}y` }];
  const changed = read('ws');
  assert.equal(hydrations, 2);
  assert.notEqual(changed.sessions[0].reportRevision, first.sessions[0].reportRevision);
});

test('watch discovery uses raw metadata before UI completion hydration', () => {
  const rows = [...Array.from({length:400},(_,i)=>plan(`foreign-${i}`,'other','other')),plan('owned','owned')];
  const hydrated=[];
  const read=createDelegationFactsReader({
    conversationStore:{listConversations:()=>[{id:'owned',workspaceId:'ws'}]},
    goalPlanStore:{listPlans(){assert.fail('UI list hydrates unrelated completed plans');},
      listPlanMetadata:()=>rows,getPlan(id){hydrated.push(id);return rows.find(row=>row.planId===id);}},
  });
  assert.equal(read('ws').sessions.length,1);assert.deepEqual(hydrated,['owned']);
});
