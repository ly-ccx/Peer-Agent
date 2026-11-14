import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const output = resolve(process.argv[2] ?? '');
const rounds = Number(process.argv[3] ?? 1000);
if (!process.argv[2] || !Number.isSafeInteger(rounds) || rounds < 0 || rounds > 1000) throw Error('Usage: prepare-baseline.ts <isolated-output> <0..1000>');
mkdirSync(output, { recursive: true });
const home = join(output, 'home');
const workspace = join(output, 'workspace');
mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
process.env.PEER_AGENT_HOME = home;
process.env.PEER_USER_DATA_PATH = home;
// Import only after the isolated data root is set; no credential/provider setup.
const { createConversationStore } = await import('../../packages/conversation-store/src/index.mjs');
const { createProjectRegistry } = await import('../../packages/runtime-node/src/project-registry.mjs');
const { createBotLifecycle } = await import('../../packages/runtime-node/src/project-agent/bot-lifecycle.mjs');
const store = createConversationStore({ storeDir: join(home, 'conversations'), usageLogFile: join(home, 'usage-request-log.jsonl') });
const registry = createProjectRegistry({ filePath: join(home, 'projects/registry.json') });
const entry = registry.ensureForPath(realpathSync(workspace));
const lifecycle = createBotLifecycle({ rootDir: home, registry, conversationStore: store });
const bot = lifecycle.ensureBot(entry.workspaceId);
if (!bot.ok) throw Error('Could not construct isolated Bot fixture');
const classic = store.createConversation({ title: 'Native migration synthetic baseline', workspacePath: realpathSync(workspace), mode: 'chat' });
const chunk = 'Synthetic baseline 中文数据. **bold** `code`\n'.repeat(1400);
const messages = Array.from({ length: rounds * 2 }, (_, i) => ({
  id: `synthetic-${i}`, role: i % 2 ? 'assistant' : 'user',
  content: `${i}\n${chunk}`, timestamp: 1700000000000 + i,
  ...(i % 2 ? { kind: 'agent_reply', replyTo: [`synthetic-${i - 1}`] } : { kind: 'user_input', inputId: `fixture-input-${i}` }),
}));
store.replaceMessages(classic.id, messages, { allowEmpty: true });
store.replaceMessages(bot.profile.agentConversationId, messages, { allowEmpty: true });
const bytes = messages.reduce((n, row) => n + Buffer.byteLength(row.content), 0);
const hash = createHash('sha256');
for (const row of messages) hash.update(JSON.stringify(row)).update('\n');
const manifest = {
  version: 1, synthetic: true, rounds, messages: messages.length, contentBytes: bytes, fixtureHash: hash.digest('hex'),
  classicConversationId: classic.id, botConversationId: bot.profile.agentConversationId,
  workspaceId: entry.workspaceId, dataHome: home, workspace: realpathSync(workspace),
  coverage: 'Synthetic persisted history only; no model/tool execution; not a reproduction of the user screenshot.',
};
writeFileSync(join(output, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ rounds, messages: messages.length, contentBytes: bytes, fixtureHash: manifest.fixtureHash })}\n`);
