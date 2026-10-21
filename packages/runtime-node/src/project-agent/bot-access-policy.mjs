import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getDataHome } from '../data-store.mjs';
import { createBotProfileStore, isBotWorkspaceId } from './bot-profile-store.mjs';
import { resolvePermissionPrincipal } from './permission-inheritance.mjs';

const require = createRequire(import.meta.url);
const levels = new Set(['ask_before_local', 'session_local', 'restricted_local', 'full_local']);
/** @returns {import('@peer-agent/protocol').BotAccessPolicyResult} */
const fail = code => ({ ok: false, code });
const normalize = value => levels.has(value) ? value : 'ask_before_local';
const stopped = plan => ['cancelled', 'paused', 'interrupted'].includes(plan?.status)
  || ['cancelled', 'paused', 'superseded'].includes(plan?.delegationOrigin?.phase)
  || plan?.delegationOrigin?.supersededBy || plan?.delegationOrigin?.cancellation;

/** Versioned device authority with atomic migration/CAS. Corrupt authority is never rebuilt.
 * @param {{dataHome?: string, profileStore?: any, conversationStore?: any, goalPlanStore?: any, legacyAccessLevel?: unknown, now?: () => string}} [options]
 */
export function createBotAccessPolicyAuthority({ dataHome = getDataHome(), profileStore = null,
  conversationStore = null, goalPlanStore = null, legacyAccessLevel = 'ask_before_local', now = () => new Date().toISOString() } = {}) {
  const profiles = profileStore ?? createBotProfileStore({ rootDir: dataHome });
  let db = null;
  function activeProfile(workspaceId) {
    if (!isBotWorkspaceId(workspaceId)) return null;
    const profile = profiles.read(workspaceId);
    return profile && (profile.status === 'active' || profile.status == null) && typeof profile.agentConversationId === 'string' && profile.agentConversationId ? profile : null;
  }
  function connect() {
    if (db) return db;
    const root = path.join(dataHome, 'project-runtime');
    mkdirSync(root, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const connection = new DatabaseSync(path.join(root, 'bot-access.sqlite'));
    try {
      connection.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (connection.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('POLICY_UNAVAILABLE');
      const version = connection.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1].includes(version)) throw new Error('POLICY_UNAVAILABLE');
      connection.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS access_policy (
          workspaceId TEXT NOT NULL, conversationId TEXT NOT NULL, revision INTEGER NOT NULL,
          accessLevel TEXT NOT NULL, updatedAt TEXT NOT NULL, source TEXT NOT NULL,
          PRIMARY KEY(workspaceId, revision));
        CREATE TABLE IF NOT EXISTS access_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;`);
      if (!connection.prepare("SELECT value FROM access_meta WHERE key='migrated'").get()) {
        const migrationLevel = existsSync(path.join(root, 'bot-access-imported.json')) ? 'ask_before_local' : normalize(legacyAccessLevel);
        let entries = [];
        try { entries = readdirSync(path.join(dataHome, 'projects'), { withFileTypes: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const profile = activeProfile(entry.name);
          if (profile) connection.prepare('INSERT OR IGNORE INTO access_policy VALUES(?,?,?,?,?,?)')
            .run(profile.workspaceId, profile.agentConversationId, 1, migrationLevel, now(), 'legacy_migration');
        }
        connection.prepare("INSERT INTO access_meta VALUES('migrated','1')").run();
      }
      connection.exec('COMMIT');
      db = connection;
      return db;
    } catch (error) {
      try { connection.exec('ROLLBACK'); } catch {}
      connection.close();
      throw error;
    }
  }
  function current(connection, workspaceId) {
    const row = connection.prepare('SELECT * FROM access_policy WHERE workspaceId=? ORDER BY revision DESC LIMIT 1').get(workspaceId);
    if (!row) return null;
    if (!levels.has(row.accessLevel) || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !['legacy_migration', 'new_bot', 'local_ui'].includes(row.source)) throw new Error('POLICY_UNAVAILABLE');
    return { ...row };
  }
  /** @returns {import('@peer-agent/protocol').BotAccessPolicyResult} */
  function read(workspaceId) {
    try {
      const connection = connect();
      const profile = activeProfile(workspaceId);
      if (!profile) return fail('NOT_FOUND');
      let policy = current(connection, workspaceId);
      if (!policy) {
        connection.prepare('INSERT OR IGNORE INTO access_policy VALUES(?,?,?,?,?,?)')
          .run(workspaceId, profile.agentConversationId, 1, 'ask_before_local', now(), 'new_bot');
        policy = current(connection, workspaceId);
      }
      if (policy.conversationId !== profile.agentConversationId) return fail('OUT_OF_SCOPE');
      return { ok: true, policy, inherited: false, botName: profile.displayName };
    } catch { return fail('POLICY_UNAVAILABLE'); }
  }
  /** @returns {import('@peer-agent/protocol').BotAccessPolicyResult} */
  function update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['workspaceId', 'expectedRevision', 'accessLevel'].includes(key))
      || !isBotWorkspaceId(input.workspaceId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !levels.has(input.accessLevel)) return fail('INVALID_INPUT');
    const existing = read(input.workspaceId);
    if (!existing.ok) return existing;
    const connection = connect();
    try {
      connection.exec('BEGIN IMMEDIATE');
      const before = current(connection, input.workspaceId);
      const profile = activeProfile(input.workspaceId);
      if (!profile || before.conversationId !== profile.agentConversationId) { connection.exec('ROLLBACK'); return fail('OUT_OF_SCOPE'); }
      if (before.revision !== input.expectedRevision) {
        connection.exec('ROLLBACK'); return { ...fail('POLICY_CONFLICT'), policy: before };
      }
      if (before.accessLevel !== input.accessLevel) connection.prepare('INSERT INTO access_policy VALUES(?,?,?,?,?,?)')
        .run(before.workspaceId, before.conversationId, before.revision + 1, input.accessLevel, now(), 'local_ui');
      connection.exec('COMMIT');
      return read(input.workspaceId);
    } catch { try { connection.exec('ROLLBACK'); } catch {} return fail('POLICY_UNAVAILABLE'); }
  }
  /** @returns {import('@peer-agent/protocol').BotAccessPolicyResult | null} */
  function resolve(identity = {}, { presentation = false } = {}) {
    try {
      const metadata = id => typeof conversationStore?.listConversations === 'function'
        ? conversationStore.listConversations({ roles: ['default', 'project_agent', 'work_session'], includeMessageCount: false }).find(row => row.id === id)
        : conversationStore?.getConversation?.(id);
      // Do not load a long Bot message history just to check an already host-bound principal.
      const known = activeProfile(identity.workspaceId);
      const meta = known?.agentConversationId === identity.conversationId ? null : metadata(identity.conversationId);
      const plan = identity.planId ? goalPlanStore?.getPlan?.(identity.planId)
        : goalPlanStore?.getActivePlanByConversation?.(identity.conversationId);
      const workspaceId = identity.workspaceId ?? plan?.delegationOrigin?.workspaceId ?? meta?.workspaceId;
      const profile = activeProfile(workspaceId);
      const delegated = Boolean(plan?.delegationOrigin || meta?.role === 'work_session' || identity.role === 'work_session');
      const root = profile && profile.agentConversationId === identity.conversationId;
      if (!root && !delegated && meta?.role !== 'project_agent' && identity.role !== 'project_agent') return null;
      if (!profile || identity.workspaceId && identity.workspaceId !== workspaceId) return fail('OUT_OF_SCOPE');
      if (root) return read(workspaceId);
      if (!presentation) {
        if (!plan?.delegationOrigin || stopped(plan)) return fail('OUT_OF_SCOPE');
        const principal = resolvePermissionPrincipal({ workspaceId, conversationId: identity.conversationId,
          planId: plan.planId, sessionId: identity.sessionId ?? plan.delegationOrigin.sessionId, goalPlanStore });
        if (principal?.conversationId !== profile.agentConversationId) return fail('OUT_OF_SCOPE');
      }
      // Persisted conversation ancestry is also checked; presentation never grants execution.
      let cursor = identity.conversationId;
      const seen = new Set();
      for (let depth = 0; cursor !== profile.agentConversationId && depth < 4; depth++) {
        if (!cursor || seen.has(cursor)) return fail('OUT_OF_SCOPE');
        seen.add(cursor);
        const row = metadata(cursor);
        if (row && (row.workspaceId !== workspaceId || row.role !== 'work_session')) return fail('OUT_OF_SCOPE');
        cursor = row?.parentConversationId ?? (cursor === identity.conversationId ? plan : goalPlanStore?.getActivePlanByConversation?.(cursor))?.delegationOrigin?.parentConversationId;
      }
      if (cursor !== profile.agentConversationId) return fail('OUT_OF_SCOPE');
      const result = read(workspaceId);
      return result.ok ? { ...result, inherited: true } : result;
    } catch { return fail('POLICY_UNAVAILABLE'); }
  }
  return { initialize() { try { connect(); return { ok: true }; } catch { return fail('POLICY_UNAVAILABLE'); } }, read, update, resolve,
    valid(policy, identity) { const latest = resolve(identity); return latest?.ok === true
      && latest.policy.workspaceId === policy.workspaceId && latest.policy.conversationId === policy.conversationId && latest.policy.revision === policy.revision; },
    close() { db?.close(); db = null; } };
}
