import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotAccessPolicyAuthority } from './bot-access-policy.mjs';

function fixture(t, legacyAccessLevel = 'full_local') {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), 'peer-bot-access-'));
  const profiles = new Map();
  const conversations = new Map();
  const plans = new Map();
  const add = id => {
    const profile = { workspaceId: id, agentConversationId: `bot-${id}`, status: 'active', displayName: id };
    profiles.set(id, profile); mkdirSync(path.join(dataHome, 'projects', id), { recursive: true });
    conversations.set(profile.agentConversationId, { role: 'project_agent', workspaceId: id });
  };
  add('a'); add('b');
  const options = { dataHome, legacyAccessLevel, profileStore: { read: id => profiles.get(id) },
    conversationStore: { getConversation: id => conversations.get(id) }, goalPlanStore: {
      getPlan: id => plans.get(id), getActivePlanByConversation: id => [...plans.values()].find(plan => plan.conversationId === id),
    } };
  const authority = createBotAccessPolicyAuthority(options);
  const handles = [authority];
  t.after(() => { handles.forEach(handle => handle.close()); rmSync(dataHome, { recursive: true, force: true }); });
  return { authority, profiles, conversations, plans, dataHome, add,
    reopen: (overrides = {}) => { const next = createBotAccessPolicyAuthority({ ...options, ...overrides }); handles.push(next); return next; } };
}

test('legacy policies freeze per Bot, new bots ask, global changes and restart do not overwrite them', t => {
  const f = fixture(t);
  assert.equal(f.authority.initialize().ok, true);
  assert.equal(f.authority.read('a').policy.accessLevel, 'full_local');
  f.add('new');
  assert.equal(f.authority.read('new').policy.accessLevel, 'ask_before_local');
  const changed = f.authority.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'ask_before_local' });
  assert.equal(changed.policy.revision, 2);
  assert.equal(f.authority.read('b').policy.accessLevel, 'full_local');
  assert.deepEqual(f.reopen().read('a').policy, changed.policy);
});

test('all legacy values including restricted are preserved; invalid defaults ask', t => {
  for (const level of ['ask_before_local', 'session_local', 'restricted_local', 'full_local', 'invalid']) {
    const f = fixture(t, level);
    assert.equal(f.authority.read('a').policy.accessLevel, level === 'invalid' ? 'ask_before_local' : level);
  }
});

test('two live authority instances use CAS, same value is idempotent and down/up never revives an old version', t => {
  const f = fixture(t); const second = f.reopen();
  const first = f.authority.read('a').policy;
  assert.equal(f.authority.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'full_local' }).policy.revision, 1);
  second.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'ask_before_local' });
  assert.equal(f.authority.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'full_local' }).code, 'POLICY_CONFLICT');
  assert.equal(f.authority.update({ workspaceId: 'a', expectedRevision: 2, accessLevel: 'full_local' }).policy.revision, 3);
  assert.equal(f.authority.valid(first, { conversationId: 'bot-a', workspaceId: 'a' }), false);
  assert.equal(f.authority.update({ workspaceId: 'a', expectedRevision: 3, accessLevel: 'full_local', parentConversationId: 'spoof' }).code, 'INVALID_INPUT');
});

test('worker identity, session, ancestry, workspace and current lifecycle are required; ordinary same-workspace chats are independent', t => {
  const f = fixture(t);
  f.conversations.set('child', { role: 'work_session', workspaceId: 'a', parentConversationId: 'bot-a' });
  f.plans.set('p', { planId: 'p', conversationId: 'child', status: 'running', delegationOrigin: {
    workspaceId: 'a', sessionId: 's', parentConversationId: 'bot-a', phase: 'running',
  } });
  const identity = { conversationId: 'child', workspaceId: 'a', planId: 'p', sessionId: 's' };
  assert.equal(f.authority.resolve(identity).policy.conversationId, 'bot-a');
  assert.equal(f.authority.resolve({ ...identity, sessionId: 'other' }).ok, false);
  assert.equal(f.authority.resolve({ ...identity, workspaceId: 'b' }).ok, false);
  f.conversations.set('ordinary', { workspaceId: 'a' });
  assert.equal(f.authority.resolve({ conversationId: 'ordinary' }), null);
  f.plans.get('p').status = 'paused';
  assert.equal(f.authority.resolve(identity).ok, false);
  assert.equal(f.authority.resolve(identity, { presentation: true }).inherited, true);
  f.conversations.get('child').parentConversationId = 'child';
  assert.equal(f.authority.resolve(identity, { presentation: true }).ok, false);
});

test('archived or replaced parent cannot inherit its old Full authority', t => {
  const f = fixture(t); f.authority.read('a');
  f.profiles.get('a').agentConversationId = 'new-parent';
  assert.equal(f.authority.read('a').code, 'OUT_OF_SCOPE');
  f.profiles.get('b').status = 'archived';
  assert.equal(f.authority.read('b').code, 'NOT_FOUND');
});

test('ephemeral verifier/explorer inherit only through an explicit live plan/session and persisted ancestry', t => {
  const f = fixture(t);
  f.conversations.set('child', { role: 'work_session', workspaceId: 'a', parentConversationId: 'bot-a' });
  const plan = { planId: 'p', conversationId: 'child', status: 'executing', delegationOrigin: {
    workspaceId: 'a', sessionId: 's', parentConversationId: 'bot-a', phase: 'running',
  } };
  f.plans.set('p', plan);
  const identity = { role: 'work_session', conversationId: null, workspaceId: 'a', planId: 'p', sessionId: 's' };
  const result = f.authority.resolve(identity);
  assert.equal(result.ok, true);
  assert.equal(result.inherited, true);
  assert.equal(result.policy.conversationId, 'bot-a');
  for (const patch of [{ sessionId: 'other' }, { sessionId: undefined }, { planId: undefined },
    { workspaceId: 'b' }, { conversationId: 'bot-b' }, { role: 'user_chat' }]) {
    assert.notEqual(f.authority.resolve({ ...identity, ...patch })?.ok, true);
  }
  assert.notEqual(f.authority.resolve(identity, { presentation: true })?.ok, true);
  f.authority.update({ workspaceId: 'a', expectedRevision: result.policy.revision, accessLevel: 'restricted_local' });
  assert.equal(f.authority.valid(result.policy, identity), false);
  assert.equal(f.authority.resolve(identity).policy.accessLevel, 'restricted_local');
  f.conversations.get('child').parentConversationId = 'bot-b';
  assert.equal(f.authority.resolve(identity).ok, false);
  f.conversations.get('child').parentConversationId = 'bot-a';
  plan.status = 'paused';
  assert.equal(f.authority.resolve(identity).ok, false);
});

test('corrupt authority is unavailable and is never replaced by the global Full default', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.dataHome, 'project-runtime'), { recursive: true });
  writeFileSync(path.join(f.dataHome, 'project-runtime', 'bot-access.sqlite'), 'corrupt');
  assert.equal(f.authority.initialize().code, 'POLICY_UNAVAILABLE');
  assert.equal(f.authority.read('a').code, 'POLICY_UNAVAILABLE');
});

test('failed migration rolls back all Bot policies and its completion marker before a retry', t => {
  const f = fixture(t); let calls = 0;
  const failed = f.reopen({ now: () => { if (++calls === 2) throw new Error('disk failure'); return new Date().toISOString(); } });
  assert.equal(failed.initialize().ok, false);
  const recovered = f.reopen({ legacyAccessLevel: 'session_local' });
  assert.equal(recovered.read('a').policy.source, 'legacy_migration');
  assert.equal(recovered.read('a').policy.accessLevel, 'session_local');
  assert.equal(recovered.read('b').policy.accessLevel, 'session_local');
});

test('unwritable storage and unknown schema never fall back to a global Full policy', async t => {
  const f = fixture(t); writeFileSync(path.join(f.dataHome, 'project-runtime'), 'not a directory');
  assert.equal(f.authority.read('a').code, 'POLICY_UNAVAILABLE');
  assert.equal(f.authority.update({ workspaceId: 'a', accessLevel: 'full_local', expectedRevision: 1 }).ok, false);
  const g = fixture(t); g.authority.initialize();
  const { createRequire } = await import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(g.dataHome, 'project-runtime', 'bot-access.sqlite'));
  db.exec('PRAGMA user_version=999'); db.close();
  assert.equal(g.reopen().initialize().code, 'POLICY_UNAVAILABLE');
});

test('nested workers inherit only through an intact, bounded and current parent chain', t => {
  const f = fixture(t); let parent = 'bot-a';
  for (let i = 0; i < 5; i++) {
    const conversationId = `child-${i}`, planId = `plan-${i}`, sessionId = `session-${i}`;
    f.conversations.set(conversationId, { role: 'work_session', workspaceId: 'a', parentConversationId: parent });
    f.plans.set(planId, { planId, conversationId, status: 'executing', delegationOrigin: { workspaceId: 'a', sessionId, parentConversationId: parent } });
    const result = f.authority.resolve({ conversationId, planId, sessionId, workspaceId: 'a' });
    assert.equal(result.ok, i < 4);
    parent = conversationId;
  }
  f.plans.get('plan-0').status = 'paused';
  assert.equal(f.authority.resolve({ conversationId: 'child-2', planId: 'plan-2', sessionId: 'session-2', workspaceId: 'a' }).ok, false);
});

test('portable settings export excludes device-local Bot Full authority', async t => {
  const f = fixture(t); f.authority.initialize();
  const { exportBundle } = await import('../data-store.mjs');
  const { existsSync } = await import('node:fs');
  const prior = process.env.PEER_AGENT_HOME;
  try {
    process.env.PEER_AGENT_HOME = f.dataHome;
    const target = path.join(f.dataHome, 'export');
    assert.equal(exportBundle(target).exported.includes('projectRuntime'), false);
    assert.equal(existsSync(path.join(target, 'project-runtime', 'bot-access.sqlite')), false);
  } finally { if (prior === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = prior; }
});

test('portable import cannot silently turn a new device global Full preference into Bot Full authority', async t => {
  const f = fixture(t);
  const source = path.join(f.dataHome, 'import-source');
  mkdirSync(path.join(source, 'projects'), { recursive: true });
  writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ localAccessLevel: 'full_local' }));
  const { importBundle } = await import('../data-store.mjs');
  const prior = process.env.PEER_AGENT_HOME;
  try {
    process.env.PEER_AGENT_HOME = f.dataHome;
    importBundle(source);
    assert.equal(f.authority.read('a').policy.accessLevel, 'ask_before_local');
    assert.equal(f.authority.read('b').policy.accessLevel, 'ask_before_local');
    assert.equal(f.authority.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'full_local' }).ok, true);
    importBundle(source);
    assert.equal(f.authority.read('a').policy.accessLevel, 'full_local', 'explicit local authority is retained on later imports');
  } finally { if (prior === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = prior; }
});
