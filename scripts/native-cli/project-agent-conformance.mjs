#!/usr/bin/env node
// Bidirectional Rust <-> TS Project Agent storage & SQLite FTS5 cold-read conformance test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = resolve(
  root,
  process.argv[2] ?? 'target/debug/examples/project-agent-conformance',
);

const { createProjectRegistry } = await import(
  join(root, 'packages/runtime-node/dist/project-registry.mjs')
);
const {
  createBotProfileStore,
  createInputQueue,
  createProjectInputDraftStore,
  createProjectInbox,
  createMemoryStore,
  createMemoryIndex,
  createObjectiveStore,
  createBotDirectory,
} = await import(
  join(root, 'packages/runtime-node/dist/project-agent-public.js')
);

const tmpRoot = mkdtempSync(join(tmpdir(), 'peer-pa-conformance-'));
try {
  // --- Direction 1: Rust writes -> TS cold-reads ---
  const home1 = join(tmpRoot, 'rust-to-ts-home');
  const ws1 = join(tmpRoot, 'rust-to-ts-ws');
  mkdirSync(home1, { recursive: true });
  mkdirSync(ws1, { recursive: true });

  const rustWrote = JSON.parse(
    execFileSync(bin, ['write', home1, ws1], { encoding: 'utf8' }),
  );
  const wsId1 = rustWrote.workspaceId;

  const tsReg1 = createProjectRegistry({
    filePath: join(home1, 'projects', 'registry.json'),
  });
  const foundReg = tsReg1.findByPath(ws1);
  assert.ok(foundReg, 'TS ProjectRegistry must find Rust-registered workspace');
  assert.equal(foundReg.workspaceId, wsId1);

  const tsProfiles1 = createBotProfileStore({ rootDir: home1 });
  const tsProfile = tsProfiles1.read(wsId1);
  assert.ok(tsProfile, 'TS BotProfileStore must cold-read Rust BotProfile');
  assert.equal(tsProfile.displayName, 'Interop Bot');
  assert.equal(tsProfile.agentConversationId, rustWrote.conversationId);
  assert.equal(tsProfile.avatar.color, rustWrote.avatar.color);
  assert.equal(tsProfile.avatar.shape, rustWrote.avatar.shape);

  const tsInputs1 = createInputQueue({ rootDir: join(home1, 'project-runtime') });
  const foundIn1 = tsInputs1.findSubmission(wsId1, 'interop-in-1');
  assert.ok(foundIn1, 'TS InputQueue must cold-read Rust input submission');
  assert.equal(foundIn1.text, 'Check Rust to TS interop');

  const tsDrafts1 = createProjectInputDraftStore({
    rootDir: join(home1, 'project-runtime'),
  });
  const draft1 = tsDrafts1.read({ workspaceId: wsId1, surface: 'tui' });
  assert.equal(draft1.ok, true, 'TS InputDraftStore must cold-read Rust draft');
  assert.equal(draft1.snapshot.draft.text, 'Draft text from Rust');

  const tsInbox1 = createProjectInbox({ rootDir: join(home1, 'project-runtime') });
  const batch1 = tsInbox1.takeBatch(wsId1, { ignoreWindow: true });
  assert.equal(batch1.events.length, 1);
  assert.equal(batch1.events[0].eventId, 'ev-rust-1');

  const tsMem1 = createMemoryStore({ rootDir: home1 });
  const memList1 = tsMem1.list({ workspaceId: wsId1 });
  assert.equal(memList1.length, 1);
  assert.equal(memList1[0].id, rustWrote.memoryId);

  const tsMemIdx1 = createMemoryIndex({
    file: join(home1, 'cache', 'memory-index', 'memory-index.sqlite'),
  });
  const tsZhHits = tsMemIdx1.search('原生', { workspaceId: wsId1, limit: 10 });
  assert.ok(
    tsZhHits.some((h) => h.id === rustWrote.memoryId),
    'TS SQLite FTS5 MemoryIndex must read Rust-indexed Chinese memory',
  );
  const tsEnHits = tsMemIdx1.search('conformance', {
    workspaceId: wsId1,
    limit: 10,
  });
  assert.ok(
    tsEnHits.some((h) => h.id === rustWrote.memoryId),
    'TS SQLite FTS5 MemoryIndex must read Rust-indexed English memory',
  );
  tsMemIdx1.close();

  const tsObj1 = createObjectiveStore({ rootDir: home1 });
  const objs1 = tsObj1.list(wsId1);
  assert.equal(objs1.length, 1);
  assert.equal(objs1[0].objectiveId, rustWrote.objectiveId);
  assert.equal(objs1[0].title, 'Cross-language compatibility');

  const tsDir1 = createBotDirectory({
    rootDir: home1,
    registry: tsReg1,
    listSessions: () => [],
  });
  const dirItems1 = tsDir1.list();
  assert.equal(dirItems1.length, 1);
  assert.equal(dirItems1[0].workspaceId, wsId1);

  // --- Direction 2: TS writes -> Rust cold-reads ---
  const home2 = join(tmpRoot, 'ts-to-rust-home');
  const ws2 = join(tmpRoot, 'ts-to-rust-ws');
  mkdirSync(home2, { recursive: true });
  mkdirSync(ws2, { recursive: true });

  const tsReg2 = createProjectRegistry({
    filePath: join(home2, 'projects', 'registry.json'),
  });
  const entry2 = tsReg2.ensureForPath(ws2);
  const wsId2 = entry2.workspaceId;
  const convId2 = `bot-conv-${wsId2}`;

  const tsProfiles2 = createBotProfileStore({ rootDir: home2 });
  tsProfiles2.create({
    workspaceId: wsId2,
    displayName: 'TS Origin Bot',
    agentConversationId: convId2,
    folderName: 'ts-to-rust-ws',
  });

  const tsInputs2 = createInputQueue({ rootDir: join(home2, 'project-runtime') });
  tsInputs2.submitInput({
    workspaceId: wsId2,
    inputId: 'ts-in-1',
    surface: 'desktop',
    text: 'Check TS to Rust interop',
  });

  const tsDrafts2 = createProjectInputDraftStore({
    rootDir: join(home2, 'project-runtime'),
  });
  tsDrafts2.write({
    workspaceId: wsId2,
    surface: 'tui',
    revision: 0,
    draft: { text: 'Draft text from TS', quote: null, attachmentIds: [] },
    pending: [],
    uploads: [],
  });

  const tsInbox2 = createProjectInbox({ rootDir: join(home2, 'project-runtime') });
  tsInbox2.append(wsId2, [
    {
      eventId: 'ev-ts-1',
      kind: 'session_spawned',
      sessionId: 'sess-ts-1',
      payload: { title: 'TS event' },
    },
  ]);

  const tsMem2 = createMemoryStore({ rootDir: home2 });
  const savedMem2 = tsMem2.rememberStated({
    scope: 'project',
    workspaceId: wsId2,
    kind: 'decision',
    text: 'TS 写入的原生 conformance 记忆条目',
    anchorMessageId: 'in:ts-in-1',
    messages: [{ id: 'in:ts-in-1', role: 'user', kind: 'user_input' }],
  });
  assert.equal(savedMem2.ok, true, `TS rememberStated failed: ${JSON.stringify(savedMem2)}`);
  const tsMemIdx2 = createMemoryIndex({
    file: join(home2, 'cache', 'memory-index', 'memory-index.sqlite'),
  });
  tsMemIdx2.upsert(savedMem2.item);
  tsMemIdx2.close();

  const tsObj2 = createObjectiveStore({ rootDir: home2 });
  tsObj2.create({
    workspaceId: wsId2,
    projectAgentConversationId: convId2,
    originMessageId: 'in:ts-in-1',
    title: 'TS Objective',
    outcome: 'Rust reads TS objective cleanly',
    autonomy: 'propose',
    createdBy: 'user_request',
  });

  const rustRead = JSON.parse(
    execFileSync(bin, ['read', home2, ws2], { encoding: 'utf8' }),
  );
  assert.equal(rustRead.workspaceId, wsId2);
  assert.equal(rustRead.displayName, 'TS Origin Bot');
  assert.equal(rustRead.conversationId, convId2);
  assert.deepEqual(rustRead.pendingInputIds, ['ts-in-1']);
  assert.equal(rustRead.draftText, 'Draft text from TS');
  assert.deepEqual(rustRead.inboxEventIds, ['ev-ts-1']);
  assert.equal(rustRead.memoryCount, 1);
  assert.equal(rustRead.zhHits, 1, 'Rust FTS5 must cold-read TS Chinese memory');
  assert.equal(rustRead.enHits, 1, 'Rust FTS5 must cold-read TS English memory');
  assert.deepEqual(rustRead.objectiveTitles, ['TS Objective']);
  assert.equal(rustRead.bots.length, 1);
  assert.equal(rustRead.bots[0].workspaceId, wsId2);

  console.log(
    'Project Agent bidirectional Rust <-> TS cold-read conformance (registry, profiles, input_queue, drafts, inbox, memory+FTS5 Chinese/English, objectives, directory) passed.',
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
