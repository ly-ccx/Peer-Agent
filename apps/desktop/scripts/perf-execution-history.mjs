/** Opt-in large-history production read benchmark. All load records are synthetic. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore, createSessionSupervisor, createDesktopProjectFacts, createBotDirectory } from '@peer-agent/runtime-node';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { seedExecutionHistory } from './seed-execution-history.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'peer-large-history-'));
const output = process.argv.indexOf('--output'), report = { scope: 'Synthetic full historical scale; production SessionSupervisor, facts and directory. No Provider calls or task execution.', cases: {} };
const stats = values => { const sorted = [...values].sort((a,b)=>a-b); return { n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1) }; };
try {
  const fixture = seedBotShellHome({ home: root, scale: { bots: 2, messages: 0, memories: 0, inboxEvents: 0 } }), bot = fixture.bots[0];
  report.scale = seedExecutionHistory({ home: root, bot });
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
  let hydrations = 0; const readPlan = plans.getPlan; plans.getPlan = id => { hydrations++; return readPlan(id); };
  const supervisor = createSessionSupervisor({ conversationStore: conversations, goalPlanStore: plans, deferRecovery: true, canManageWorkspace: () => false });
  const runtimeRoot = path.join(root, 'project-runtime'), coordination = createWorkCoordinationStore({ rootDir: runtimeRoot, workspaceId: bot.workspaceId });
  coordination.read();
  const profile = JSON.parse(readFileSync(path.join(root, 'projects', bot.workspaceId, 'profile.json'), 'utf8'));
  const facts = createDesktopProjectFacts({ runtimeRoot, conversationStore: conversations, supervisor, profileStore: { read: () => profile }, approvalStore: { list: () => [] }, readCoordination: () => coordination.read() });
  const history = conversations.createHistoryProjection(value => value.messages, { maxEntries: 8, maxBytes: 32 * 1024 * 1024 });
  const directory = createBotDirectory({ rootDir: root, readMessages: id => history(id) || [], readCards: id => facts.cards(id), getSession: id => supervisor.get({ sessionId: id }) });
  const cold = performance.now(); directory.readConversation(bot.workspaceId, { latest: true, limit: 50 }); report.firstConversationMs = performance.now()-cold;
  assert.equal(supervisor.sessionsForProject(bot.workspaceId).length, 8, 'all historical delegated plans must survive real normalization');
  for (const [name, read] of [['conversation', () => directory.readConversation(bot.workspaceId, { latest: true, limit: 50 })],
    ['cards', () => facts.cards(bot.workspaceId)], ['sessions', () => supervisor.sessionsForProject(bot.workspaceId)]]) {
    const samples = [], counts = [];
    for (let i = 0; i < 20; i++) { hydrations=0; const at=performance.now(); read(); samples.push(performance.now()-at); counts.push(hydrations); }
    report.cases[name] = { ...stats(samples), maxHydrations:Math.max(...counts) };
    assert.ok(report.cases[name].p95 < 50, `${name} p95 exceeded 50ms`);
    assert.ok(report.cases[name].maxHydrations <= 8, `${name} rescanned unrelated historical plans`);
  }
  report.ok = true;
} catch (error) { report.ok=false;report.error=error.stack;process.exitCode=1; }
finally {
  rmSync(root,{recursive:true,force:true});report.fixtureRemoved=true;
  if(output>=0)writeFileSync(process.argv[output+1],JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
