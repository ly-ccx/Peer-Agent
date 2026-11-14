import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Public synthetic history, never an execution/verification receipt for a real task. */
export async function seedRi00({ moduleRoot, home, plans = 1460, sessions = 23, ready = 6, evidence = 69045 }) {
  if ([plans, sessions, ready, evidence].some(value => !Number.isInteger(value) || value < 0)
    || ready > sessions || sessions < 1 || plans < sessions) throw new Error('invalid_fixture_scale');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(home).length) throw new Error('fixture_directory_must_be_empty');
  process.env.PEER_AGENT_HOME = home;
  const from = relative => import(pathToFileURL(path.join(moduleRoot, relative)).href);
  const [{ seedBotShellHome }, { createConversationStore }, { createGoalPlanStore }] = await Promise.all([
    from('apps/desktop/scripts/seed-bot-shell-home.mjs'),
    from('packages/conversation-store/dist/index.mjs'), from('packages/runtime-node/dist/goal-plan-store.mjs'),
  ]);
  const fixture = seedBotShellHome({ home, scale: { bots: 1, messages: 0, memories: 0, inboxEvents: 0 } });
  const bot = fixture.bots[0];
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const store = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const base = store.createPlan({ title: 'RI-00 synthetic history', goal: 'Historical load fixture only; never execute.', tasks: [] });
  const index = path.join(store.getStoreDir(), 'index.jsonl');
  const baseMeta = JSON.parse(fs.readFileSync(index, 'utf8').trim().split('\n').at(-1));
  fs.unlinkSync(path.join(store.getStoreDir(), `${base.planId}.json`));
  const models = { providerId: 'ri00-synthetic-only', modelId: 'historical-load', modelProviderId: 'historical-load', family: 'synthetic' };
  const records = [];
  const children = [];
  const positions = new Map(Array.from({ length: sessions }, (_, i) => [Math.floor((i + 1) * plans / (sessions + 1)), i]));
  for (let position = 0; position < plans; position++) {
    const planId = `ri00-history-${String(position).padStart(6, '0')}`;
    const session = positions.get(position);
    let plan = { ...base, planId, status: 'cancelled', syntheticHistoricalFixture: true };
    if (session !== undefined) {
      const conversation = conversations.createConversation({ title: `RI-00 synthetic history ${session}`, role: 'work_session', workspaceId: bot.workspaceId, workspacePath: bot.path });
      children.push({ planId, conversationId: conversation.id });
      const completed = session < ready;
      plan = { ...plan, conversationId: conversation.id, status: completed ? 'completed' : 'cancelled',
        tasks: [{ taskId: `ri00-leaf-${session}`, title: 'Synthetic historical state, not executed', status: completed ? 'completed' : 'cancelled' }],
        runner: { enabled: false, status: completed ? 'completed' : 'cancelled' },
        delegationOrigin: { workspaceId: bot.workspaceId, parentConversationId: bot.conversationId, sessionId: `ri00-session-${session}`,
          anchorMessageId: `ri00-input-${session}`, inputId: `ri00-input-${session}`, phase: completed ? 'running' : 'cancelled', depth: 1, readOnly: true,
          modelSelection: { worker: models, explorer: models, verifier: models, source: {}, resolvedAt: '2026-01-01T00:00:00.000Z' } } };
    }
    fs.writeFileSync(path.join(store.getStoreDir(), `${planId}.json`), JSON.stringify(plan));
    records.push({ ...baseMeta, planId, conversationId: plan.conversationId, status: plan.status });
  }
  fs.writeFileSync(index, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const rows = Array.from({ length: evidence }, (_, i) => {
    const child = children[i % children.length];
    return { evidenceRef: `ri00-synthetic-evidence:${i}`, planId: child.planId, conversationId: child.conversationId,
      createdAt: '2026-01-01T00:00:00.000Z', capabilityId: 'local.file.read', toolName: 'read_file', toolCallId: `ri00-call-${i}` };
  });
  fs.writeFileSync(path.join(store.getStoreDir(), 'evidence-index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const receipt = { fixture: true, synthetic: true, scope: 'Historical read load only; no model/tool execution, real Evidence or result acceptance.',
    plans, sessions, ready, evidence, bot: { workspaceId: bot.workspaceId, conversationId: bot.conversationId } };
  fs.writeFileSync(path.join(home, 'ri00-fixture.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
