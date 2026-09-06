/**
 * Seed a PEER_AGENT_HOME with two real conversations via conversation-store.
 * Does not pre-open Workbench Browser — the Desktop UI / CDP driver does that.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '../../../packages/conversation-store/src/index.mjs';

const home = process.env.PEER_AGENT_HOME;
if (!home) {
  console.error('PEER_AGENT_HOME is required');
  process.exit(1);
}

mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({
  locale: 'en',
  workbench: {
    open: false,
    openByConversation: {},
    width: 640,
    activeTab: {},
    browserSessions: {},
    documentSessions: {},
    sidebarOpen: true,
    sidebarWidth: 264,
  },
}, null, 2)}\n`);

const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
const a = store.createConversation({ title: 'KeepAlive A' });
const b = store.createConversation({ title: 'KeepAlive B' });
const now = Date.now();
store.appendMessage(a.id, {
  id: 'seed-a',
  role: 'user',
  content: 'seed conversation A',
  timestamp: now,
});
store.appendMessage(b.id, {
  id: 'seed-b',
  role: 'user',
  content: 'seed conversation B',
  timestamp: now + 1,
});

const report = { home, a: a.id, b: b.id };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
