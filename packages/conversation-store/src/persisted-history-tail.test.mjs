import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';

test('tail-bounded history projection preserves opening turn + recent tail and excludes provisional streaming sidecar', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'peer-tail-proj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const conv = store.createConversation({ title: 'Long Bot', workspacePath: dir, role: 'project_agent' });
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    rows.push({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: i % 2 === 0 ? 'user_input' : 'agent_reply',
      content: i === 0 ? 'FIRST_USER_ANCHOR' : `turn-${i}-${'x'.repeat(120)}`,
      createdAt: new Date(Date.now() - (300 - i) * 1000).toISOString(),
    });
  }
  writeFileSync(path.join(dir, `${conv.id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const project = (history) => {
    const messages = history?.messages ?? [];
    const recent = messages.slice(-8);
    const first = messages.find((m) => m.role === 'user');
    if (first && recent.length === 8 && !recent.includes(first)) recent.splice(0, 1, first);
    return { ids: recent.map((m) => m.id), totalLoaded: messages.length };
  };

  const fullProj = store.createHistoryProjection(project, { immutableInput: true, immutableOutput: true });
  const tailProj = store.createHistoryProjection(project, {
    immutableInput: true,
    immutableOutput: true,
    tailLimit: 32,
    headLimit: 8,
  });

  const fullResult = fullProj(conv.id);
  const tailResult = tailProj(conv.id);
  assert.deepEqual(tailResult.ids, fullResult.ids);
  assert.equal(tailResult.ids[0], 'm-0');
  assert.equal(tailResult.ids.at(-1), 'm-299');
  assert.ok(tailResult.totalLoaded <= 40, `expected bounded head+tail load, got ${tailResult.totalLoaded}`);

  // Provisional streaming sidecar on m-299 must exclude m-299 identically to full projection.
  store.patchStreamingMessage(conv.id, 'm-299', { content: 'streaming partial' });
  assert.deepEqual(tailProj(conv.id).ids, fullProj(conv.id).ids);
  assert.equal(tailProj(conv.id).ids.at(-1), 'm-298');

  // If sidecar targets a message outside the tail window, fall back cleanly to full strict read.
  store.clearStreamPatch(conv.id);
  store.patchStreamingMessage(conv.id, 'm-10', { content: 'older streaming partial' });
  assert.deepEqual(tailProj(conv.id).ids, fullProj(conv.id).ids);
  assert.equal(tailProj(conv.id).ids.at(-1), 'm-9');
});
