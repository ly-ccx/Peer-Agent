/** RC-01 synthetic data only. Refuses a nonempty directory or the personal data home. */
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readdirSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createProjectRegistry, createBotLifecycle, createMemoryStore } from '@peer-agent/runtime-node';

export const RC_SCALE = Object.freeze({ bots: 200, messages: 10_000, inboxEvents: 100_000, memories: 10_000 });

function canonicalTarget(target) {
  let parent = path.resolve(target);
  const rest = [];
  while (!existsSync(parent)) {
    rest.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  return path.join(realpathSync(parent), ...rest);
}

export function assertIsolatedHome(home, personalHome = path.join(os.homedir(), '.peer-agent')) {
  assert.ok(typeof home === 'string' && path.isAbsolute(home), 'absolute isolated home required');
  const resolved = path.resolve(home);
  const personal = path.resolve(personalHome);
  assert.ok(resolved !== personal && !resolved.startsWith(personal + path.sep), 'personal data home is forbidden');
  const canonical = canonicalTarget(home);
  const personalCanonical = canonicalTarget(personal);
  assert.ok(canonical !== personalCanonical && !canonical.startsWith(personalCanonical + path.sep), 'personal data home is forbidden');
  if (existsSync(home)) {
    assert.equal(lstatSync(home).isSymbolicLink(), false, 'symlinked home is forbidden');
    assert.equal(readdirSync(home).length, 0, 'seed requires an empty directory');
  }
  return resolved;
}

export function seedBotShellHome({ home, projectRoot = null, scale = RC_SCALE } = {}) {
  const resolved = assertIsolatedHome(home);
  for (const key of Object.keys(RC_SCALE)) assert.ok(Number.isInteger(scale[key]) && scale[key] >= 0, `invalid ${key}`);
  assert.ok(scale.bots > 0 && scale.bots <= RC_SCALE.bots, 'bot count outside fixture bound');
  for (const key of ['messages', 'inboxEvents', 'memories']) assert.ok(scale[key] <= RC_SCALE[key], 'fixture bound exceeded');
  projectRoot = projectRoot || path.join(home, 'fixture-projects');
  assert.ok(path.resolve(projectRoot).startsWith(resolved + path.sep), 'projects must stay in isolated home');
  assert.ok(canonicalTarget(projectRoot).startsWith(canonicalTarget(home) + path.sep), 'projects must stay in isolated home');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const at = new Date().toISOString();
  const registry = createProjectRegistry({ filePath: path.join(home, 'projects/registry.json') });
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const memories = createMemoryStore({ rootDir: home });
  const lifecycle = createBotLifecycle({ rootDir: home, registry, conversationStore: conversations, memoryStore: memories });
  const bots = [];
  for (let i = 0; i < scale.bots; i++) {
    const folder = path.join(projectRoot, `project-${String(i).padStart(3, '0')}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'README.md'), `RC synthetic project ${i}. Marker RC_FIXTURE_OK.\n`);
    const entry = registry.ensureForPath(folder);
    const result = lifecycle.ensureBot(entry.workspaceId);
    assert.equal(result.ok, true);
    bots.push({ ...entry, conversationId: result.profile.agentConversationId });
  }
  const first = bots[0];
  // Bulk fixture seeding avoids measuring setup's repeated O(n) append validation.
  // Every row is then parsed by the production stores in the benchmark.
  const messages = Array.from({ length: scale.messages }, (_, i) => ({ id: `rc-message-${i}`, role: i % 2 ? 'assistant' : 'user',
    kind: i % 2 ? 'agent_reply' : 'user_input', content: `合成验收消息 ${i} ${i === 123 ? 'unique-needle' : 'ordinary'}`,
    createdAt: at, timestamp: Date.now() + i }));
  writeFileSync(path.join(home, 'conversations', first.conversationId + '.jsonl'), messages.map(r => JSON.stringify(r)).join('\n') + (messages.length ? '\n' : ''));
  const runtime = path.join(home, 'project-runtime', first.workspaceId);
  mkdirSync(runtime, { recursive: true });
  const events = Array.from({ length: scale.inboxEvents }, (_, i) => ({ eventId: `rc-event-${i}`, seq: i + 1, workspaceId: first.workspaceId,
    kind: 'session_verified', sessionId: `fixture-session-${i}`, at }));
  writeFileSync(path.join(runtime, 'inbox.jsonl'), events.map(r => JSON.stringify(r)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(path.join(runtime, 'inbox-cursor.json'), JSON.stringify({ seq: events.length, updatedAt: at }));
  const memoryDir = path.join(home, 'projects', first.workspaceId, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const memoryRows = Array.from({ length: scale.memories }, (_, i) => ({ id: `rc-memory-${i}`, workspaceId: first.workspaceId, scope: 'project',
    kind: 'fact', text: `Synthetic memory ${i} ${i === 123 ? 'unique memory needle' : 'ordinary'}`, status: 'active', trust: 'verified',
    sourceRefs: [`fixture-evidence-${i}`], confirmedCount: 1, pinned: false, createdAt: at, updatedAt: at }));
  writeFileSync(path.join(memoryDir, 'items.jsonl'), memoryRows.map(r => JSON.stringify(r)).join('\n') + (memoryRows.length ? '\n' : ''));
  const settings = { schemaVersion: 3, locale: 'zh-CN', projectAgent: { shell: 'bots', shellIntroDismissed: true },
    workspaces: bots.map(b => ({ id: b.workspaceId, path: b.path, name: path.basename(b.path) })), activeWorkspace: first.path };
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const manifest = { schemaVersion: 1, fixture: true, id: randomUUID(), createdAt: at, scale, bots };
  writeFileSync(path.join(home, 'rc-fixture.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const home = process.argv[2];
  console.log(JSON.stringify(seedBotShellHome({ home })));
}
