import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createBotDirectory, createMemoryStore, createProjectInbox, createProjectRegistry } from '@peer-agent/runtime-node';
import { assertIsolatedHome, seedBotShellHome, RC_SCALE } from './seed-bot-shell-home.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-rc-seed-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

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
