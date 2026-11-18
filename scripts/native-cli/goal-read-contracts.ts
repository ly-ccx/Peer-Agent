// Development fixture from the actual TUI bridge and canonical Goal store.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTuiGoalBridge } from '../../apps/tui/src/goal-bridge.ts';

const directory = mkdtempSync(join(tmpdir(), 'peer-goal-read-contract-'));
const RealDate = Date;
const time = '2026-11-14T04:00:00.000Z';
class FixedDate extends RealDate {
  constructor(value?: string | number) { super(value ?? time); }
  static now() { return RealDate.parse(time); }
}
globalThis.Date = FixedDate as DateConstructor;

try {
  const bridge = createTuiGoalBridge({ storeDir: directory });
  const tool = bridge.toolDefinitions.find(tool => tool.name === 'goal_get_plan');
  assert.ok(tool);
  const manifest = {
    capabilityId: tool.capabilityId,
    description: tool.description,
    modeScopes: tool.modeScopes,
    inputSchema: tool.inputSchema,
  };
  bridge.store.createPlan({
    planId: 'fixture-goal',
    conversationId: 'fixture-conversation',
    title: 'Compare tool results',
    goal: 'Preserve authoritative task identities.',
    originWorkspacePath: '/synthetic/goal-read',
    targetWorkspacePath: '/synthetic/goal-read',
    workflowKind: 'goal_self_driven',
    status: 'accepted',
    tasks: [{
      taskId: 'verify-tree', title: 'Verify the tree', status: 'pending',
      subtasks: [{ taskId: 'read-result', title: 'Read the saved result', status: 'pending' }],
    }],
    successCriteria: ['The stored task identities remain recoverable.'],
  });
  const detail = await bridge.execute({
    capabilityId: manifest.capabilityId, conversationId: 'fixture-conversation',
    args: { planId: 'fixture-goal' }, toolCallId: 'fixture-detail',
  });
  const list = await bridge.execute({
    capabilityId: manifest.capabilityId, conversationId: 'fixture-conversation',
    args: {}, toolCallId: 'fixture-list',
  });
  assert.equal(detail.result.status, 'success');
  assert.equal(list.result.status, 'success');
  const plan = detail.result.output.plan;
  const first = list.result.output.plans[0];
  const canonicalPlan = JSON.parse(readFileSync(join(directory, 'fixture-goal.json'), 'utf8'));
  // The internal trace contains a random event ID and is outside the tool view.
  delete canonicalPlan.runTrace;
  const fixture = {
    manifest,
    canonicalPlan,
    canonicalIndex: JSON.parse(readFileSync(join(directory, 'index.jsonl'), 'utf8').trim()),
    expectedDetail: Object.fromEntries(['planId', 'title', 'status', 'goal', 'tasks', 'successCriteria']
      .map(key => [key, plan[key]])),
    expectedListItem: Object.fromEntries(['planId', 'title', 'status']
      .map(key => [key, first[key]])),
  };
  const file = new URL('../../packages/protocol/contracts/native-cli/goal-read-tool.json', import.meta.url);
  const encoded = JSON.stringify(fixture, null, 2) + '\n';
  if (process.argv.includes('--write')) {
    writeFileSync(file, encoded);
  } else {
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(encoded));
  }
  console.log('Actual TUI Goal manifest, list and detail agree with the fixture.');
} finally {
  globalThis.Date = RealDate;
  rmSync(directory, { recursive: true, force: true });
}
