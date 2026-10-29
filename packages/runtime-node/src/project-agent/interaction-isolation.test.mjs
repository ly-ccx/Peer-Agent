import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBotDirectory } from './bot-directory.mjs';
import { createBotProfileStore } from './bot-profile-store.mjs';

test('public interaction and card reads are independent, including a failed coordination surface', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interaction-isolation-'));
  try {
    const profiles = createBotProfileStore({ rootDir: root });
    profiles.create({ workspaceId: 'w', displayName: 'bot', agentConversationId: 'conversation', status: 'active' });
    let cards = 0;
    const directory = createBotDirectory({ rootDir: root,
      readMessages: () => assert.fail('public page cannot read full history'),
      readCards: () => { cards++; throw Error('coordination unavailable'); },
      readInteractionPage: async (id, params) => { assert.equal(id, 'conversation'); return { messages: [{ id: 'u', kind: 'user_input', content: 'hello' }], nextCursor: null }; },
    });
    const page = await directory.readInteractions('w');
    assert.equal(page.ok, true); assert.equal(page.messages[0].content, 'hello'); assert.equal(cards, 0);
    const failed = directory.readConversation('w', { view: 'cards' });
    assert.equal(failed.ok, false); assert.equal(cards, 1);
    assert.equal((await directory.readInteractions('w')).messages[0].id, 'u');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production card readiness fails before scanning legacy coordination or any child chain', async () => {
  const {createDesktopProjectFacts}=await import('./project-facts.mjs');
  const {createWorkCoordinationStore}=await import('./work-coordination-store.mjs');
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-card-readiness-'));
  try {
    const options={rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'test'};
    createWorkCoordinationStore(options).saveWork({workId:'existing',state:'cancelled'});
    const facts=createDesktopProjectFacts({runtimeRoot:root,requirePreparedCoordination:true,
      conversationStore:{getPersistedConversationHistory:()=>assert.fail('must not scan parent before readiness')},
      supervisor:{sessionsForProject:()=>assert.fail('must not scan child chains before readiness')},profileStore:{read:()=>({})},approvalStore:{}});
    assert.throws(()=>facts.cards('w'),/coordination_recovery_pending/);
    const owner=createWorkCoordinationStore({...options,formatVersion:2});await owner.prepare();owner.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
