import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDesktopProjectFacts } from './project-facts.mjs';
import { registerWorkBudget } from './work-budget.mjs';

test('cards reuse the restored owner reader only for the same journal location', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-facts-reader-'));
  let reads = 0;
  const remove = registerWorkBudget('w', { journalFile: path.join(rootDir, 'w', 'coordination.jsonl'),
    read: () => { reads++; return { works: {}, deliveries: {} }; } });
  try {
    const ports = { runtimeRoot: rootDir, supervisor: { sessionsForProject: () => [] },
      approvalStore: { list: () => [] }, profileStore: { read: () => ({ agentConversationId: 'c' }) },
      conversationStore: { getPersistedConversationHistory: () => ({ messages: [] }) } };
    const facts = createDesktopProjectFacts(ports);
    facts.cards('w'); facts.cards('w');
    assert.equal(reads, 2, 'fresh projection must reuse the live owner, not replay the journal');
    createDesktopProjectFacts({ ...ports, runtimeRoot: path.join(rootDir, 'other-home') }).cards('w');
    assert.equal(reads, 2, 'a matching workspace id in another data root cannot borrow owner facts');
  } finally { remove(); rmSync(rootDir, { recursive: true, force: true }); }
});
