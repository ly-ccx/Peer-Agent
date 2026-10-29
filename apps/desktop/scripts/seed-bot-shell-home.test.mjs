import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createBotDirectory, createMemoryStore, createProjectInbox, createProjectRegistry, createGoalPlanStore, createSessionSupervisor } from '@peer-agent/runtime-node';
import { assertIsolatedHome, seedBotShellHome, RC_SCALE } from './seed-bot-shell-home.mjs';
import { seedExecutionHistory, EXECUTION_HISTORY_SCALE } from './seed-execution-history.mjs';
import { seedExecutionWorkload } from './seed-execution-workload.mjs';
import { seedHistoryFixtures, refreshHistoryFixtureDates } from './bot-history-motion-checks.mjs';
import { presentHistory } from '../renderer/src/project-agent/state/historyPresentation.ts';
import { execFileSync } from 'node:child_process';
import { reduceCoordination } from '../../../packages/runtime-node/src/project-agent/work-coordination.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-rc-seed-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('history scenario refreshes calendar groups after midnight without changing identities, messages or unrelated records', t => {
  const root = fixture(t), home = path.join(root, 'data');
  seedBotShellHome({ home, scale: { bots: 1, messages: 0, memories: 0, inboxEvents: 0 } });
  const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const unrelated = store.createConversation({ title: 'Unrelated fixture conversation', mode: 'chat' });
  const rows = seedHistoryFixtures({ home, now: new Date(2026, 11, 31, 23, 59) });
  const afterMidnight = new Date(2027, 0, 1, 0, 1);
  assert.deepEqual(presentHistory(rows, '', 48, +afterMidnight).groups.map(group => group.key), ['yesterday', 'week', 'earlier']);
  const messagesBefore = store.getPersistedConversationHistory(rows[0].id);
  const readIndex = () => readFileSync(path.join(home, 'conversations', 'index.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const unrelatedBefore = readIndex().find(row => row.id === unrelated.id);
  const refreshed = refreshHistoryFixtureDates({ home, rows, now: afterMidnight });
  assert.deepEqual(presentHistory(refreshed, '', 48, +afterMidnight).groups.map(group => group.key), ['today', 'yesterday', 'week', 'earlier']);
  assert.deepEqual(refreshed.map(row => row.id), rows.map(row => row.id));
  assert.deepEqual(store.getPersistedConversationHistory(rows[0].id), messagesBefore);
  assert.deepEqual(readIndex().find(row => row.id === unrelated.id), unrelatedBefore);
  assert.equal(readIndex().length, 50);
  const persisted = readIndex().filter(row => rows.some(fixture => fixture.id === row.id));
  assert.deepEqual(presentHistory(persisted, '', 48, +afterMidnight).groups.map(group => group.key), ['today', 'yesterday', 'week', 'earlier']);
  writeFileSync(path.join(home, 'rc-fixture.json'), JSON.stringify({ fixture: false }));
  const beforeRefusal = readIndex();
  assert.throws(() => refreshHistoryFixtureDates({ home, rows, now: afterMidnight }));
  assert.deepEqual(readIndex(), beforeRefusal);
});

test('execution history represents cancelled real-shaped sessions and refuses a foreign home', t => {
  const root = fixture(t), home = path.join(root, 'data');
  const small = seedBotShellHome({ home, scale: { bots: 1, messages: 0, memories: 0, inboxEvents: 0 } });
  const bot = small.bots[0];
  assert.throws(() => seedExecutionHistory({ home: os.homedir(), bot }));
  const result = seedExecutionHistory({ home, bot, scale: { plans: 16, sessions: 8, parentBytes: 20000, childBytes: 20000, journalBytes: 20000, failures: 8, recoveryWorks: 20, deliveredWorks: 10 } });
  assert.equal(result.actualPlans, 16);
  const state = readFileSync(path.join(home, 'project-runtime', bot.workspaceId, 'coordination.jsonl'), 'utf8')
    .trim().split('\n').map(line=>JSON.parse(line)).reduce(reduceCoordination, undefined);
  assert.equal(Object.keys(state.works).length, 20);
  assert.equal(Object.values(state.works).filter(work => work.state === 'delivered').length, 10);
  assert.equal(Object.values(state.deliveries).filter(row => row.state === 'delivered').length, 10);
  const turns = createConversationStore({storeDir:path.join(home,'conversations')}).getPersistedConversationHistory(bot.conversationId).messages.filter(row=>row.kind==='agent_turn');
  assert.ok(turns.length && turns.every(row=>row.turnId===row.id));
  assert.equal(EXECUTION_HISTORY_SCALE.recoveryWorks, 200);
  const supervisor = createSessionSupervisor({ conversationStore: createConversationStore({ storeDir: path.join(home, 'conversations') }),
    goalPlanStore: createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') }), deferRecovery: true, canManageWorkspace: () => false });
  const sessions = supervisor.sessionsForProject(bot.workspaceId);
  assert.equal(sessions.length, 8); assert.ok(sessions.every(row => row.status === 'cancelled'));
  assert.equal(EXECUTION_HISTORY_SCALE.plans, 1100);
  assert.ok(EXECUTION_HISTORY_SCALE.childBytes >= 46_300_000 && EXECUTION_HISTORY_SCALE.journalBytes >= 185_000_000);
});

test('multi-file live workload starts with 18 valid failing contracts, rather than a passing canned result', t => {
  const root = fixture(t); mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/sum.mjs'), 'export function sumNumbers(values){return values.reduce((a,b)=>a+b)}');
  writeFileSync(path.join(root, 'sum.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import{sumNumbers}from'./src/sum.mjs';test('sum',()=>assert.equal(sumNumbers([]),0));");
  seedExecutionWorkload(root);
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  assert.throws(() => execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: root, env: childEnv, encoding: 'utf8' }), error => {
    assert.match(error.stdout, /# tests 18/); assert.doesNotMatch(error.stdout, /SyntaxError/); return error.status === 1;
  });
});

test('scaled fixture is accepted by production bot, conversation, inbox and memory readers', t => {
  const root = fixture(t), home = path.join(root, 'data');
  const scale = { bots: 2, messages: 4, inboxEvents: 6, memories: 5 };
  const result = seedBotShellHome({ home, scale });
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const registry = createProjectRegistry({ filePath: path.join(home, 'projects/registry.json') });
  const readMessages = id => conversations.getPersistedConversationHistory(id)?.messages || [];
  const directory = createBotDirectory({ rootDir: home, registry, readMessages });
  assert.equal(directory.list().length, scale.bots);
  assert.equal(result.bots.reduce((n, b) => n + readMessages(b.conversationId).length, 0), scale.messages);
  assert.equal(createMemoryStore({ rootDir: home }).list({ workspaceId: result.bots[0].workspaceId }).length, scale.memories);
  const inbox = createProjectInbox({ rootDir: path.join(home, 'project-runtime') });
  assert.equal(inbox.cursor(result.bots[0].workspaceId).seq, scale.inboxEvents);
  const lines = readFileSync(path.join(home, 'project-runtime', result.bots[0].workspaceId, 'inbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, scale.inboxEvents);
  assert.equal(JSON.parse(lines.at(-1)).seq, scale.inboxEvents);
  assert.throws(() => seedBotShellHome({ home, scale }), /empty directory/);
});

test('guard refuses personal paths through existing and nonexistent symlink descendants', t => {
  const root = fixture(t), personal = path.join(root, 'fake-personal');
  mkdirSync(personal); writeFileSync(path.join(personal, 'sentinel'), 'untouched');
  const alias = path.join(root, 'alias'); symlinkSync(personal, alias, 'dir');
  for (const home of [personal, path.join(personal, 'new'), alias, path.join(alias, 'new', 'nested')]) {
    assert.throws(() => assertIsolatedHome(home, personal), /personal data home/);
  }
  assert.deepEqual(readdirSync(personal), ['sentinel']);
  assert.equal(readFileSync(path.join(personal, 'sentinel'), 'utf8'), 'untouched');
});

test('guard refuses direct symlink homes and nonempty directories without changing their contents', t => {
  const root = fixture(t), home = path.join(root, 'empty'); mkdirSync(home);
  const link = path.join(root, 'link'); symlinkSync(home, link, 'dir');
  assert.throws(() => assertIsolatedHome(link, path.join(root, 'fake-personal')), /symlinked home/);
  writeFileSync(path.join(home, 'sentinel'), 'untouched');
  assert.throws(() => seedBotShellHome({ home }), /empty directory/);
  assert.deepEqual(readdirSync(home), ['sentinel']);
});

test('seed refuses external projects and invalid scales before creating fixture data', t => {
  const root = fixture(t), home = path.join(root, 'data'); mkdirSync(home);
  assert.throws(() => seedBotShellHome({ home: 'relative' }), /absolute/);
  assert.throws(() => seedBotShellHome({ home, projectRoot: root }), /isolated home/);
  for (const scale of [ { ...RC_SCALE, bots: 0 }, { ...RC_SCALE, bots: 201 },
    { ...RC_SCALE, messages: -1 }, { ...RC_SCALE, memories: 1.5 }, { ...RC_SCALE, inboxEvents: 100001 } ]) {
    assert.throws(() => seedBotShellHome({ home, scale }));
  }
  assert.deepEqual(readdirSync(home), []);
});
