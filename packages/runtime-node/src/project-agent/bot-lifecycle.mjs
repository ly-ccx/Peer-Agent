/**
 * 机器人生命周期。档案与代理对话懒创建；熟悉项目只产出任务规格和记忆。
 * 受管目录的创建与废纸篓在桌面宿主。这里只在确认后调用注入的移除和废纸篓。
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceHead } from '../goal-delivery-binding.mjs';
import { projectCards } from './card-projection.mjs';
import { cleanDisplayName, createBotProfileStore, isBotWorkspaceId } from './bot-profile-store.mjs';
import {
  RESPONSIBILITY_QUESTION,
  buildFamiliarizePlan,
  buildReadmeTask,
} from './familiarize-template.mjs';

function fail(code) {
  return { ok: false, code };
}

export function createBotLifecycle({
  rootDir = null,
  enabled = () => true,
  registry = null,
  conversationStore = null,
  memoryStore = null,
  now = () => new Date(),
  spawn = null,
  removeWorkspace = null,
  moveToTrash = null,
  gitRun = null,
  readdir = readdirSync,
} = {}) {
  const profiles = createBotProfileStore({ rootDir, now });
  const pending = new Map();

  function workspacePath(workspaceId) {
    const entry = registry?.get?.(workspaceId);
    return typeof entry?.path === 'string' ? entry.path : '';
  }

  function activeProfile(workspaceId) {
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const profile = profiles.read(workspaceId);
    if (!profile) return fail('NOT_FOUND');
    if (profile.status === 'archived') return fail('ARCHIVED');
    return { ok: true, profile };
  }

  function ensureBot(workspaceId, options = {}) {
    if (enabled() !== true) return fail('PROJECT_AGENT_DISABLED');
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const existing = profiles.read(workspaceId);
    if (existing?.agentConversationId) {
      return { ok: true, profile: existing, created: false };
    }
    if (!registry || typeof registry.get !== 'function') return fail('REGISTRY_REQUIRED');
    const entry = registry.get(workspaceId);
    if (!entry?.path) return fail('NOT_FOUND');
    if (!conversationStore || typeof conversationStore.createConversation !== 'function') {
      return fail('CONVERSATION_REQUIRED');
    }
    const named = cleanDisplayName(options.displayName);
    const displayName = named || cleanDisplayName(path.basename(entry.path)) || '项目';
    const conversation = conversationStore.createConversation({
      title: displayName,
      role: 'project_agent',
      workspaceId,
      workspacePath: entry.path,
      mode: 'chat',
    });
    if (!conversation?.id) return fail('CONVERSATION_REQUIRED');
    const created = profiles.create({
      workspaceId,
      displayName,
      managed: options.managed === true,
      agentConversationId: conversation.id,
    });
    if (!created.ok) return created;
    return { ok: true, profile: created.profile, created: created.created === true };
  }

  function ensureBots(workspaces) {
    if (enabled() !== true) return fail('PROJECT_AGENT_DISABLED');
    if (!Array.isArray(workspaces)) return fail('INVALID_INPUT');
    const bots = [];
    for (const workspace of workspaces) {
      const folder = typeof workspace?.path === 'string' ? workspace.path.trim() : '';
      if (!folder) continue;
      let entry = null;
      try {
        entry = typeof registry?.ensureForPath === 'function' ? registry.ensureForPath(folder) : null;
      } catch {
        bots.push({
          workspaceId: '',
          ok: false,
          created: false,
          code: 'NOT_FOUND',
          displayName: '',
          agentConversationId: '',
          familiarize: null,
        });
        continue;
      }
      const workspaceId = entry?.workspaceId
        || (typeof workspace?.id === 'string' ? workspace.id.trim() : '')
        || (typeof workspace?.workspaceId === 'string' ? workspace.workspaceId.trim() : '');
      if (!workspaceId) continue;
      const ensured = ensureBot(workspaceId, {
        displayName: workspace?.name || workspace?.displayName,
        managed: workspace?.managed === true,
      });
      bots.push({
        workspaceId,
        ok: ensured.ok === true,
        created: ensured.created === true,
        code: ensured.code,
        displayName: ensured.profile?.displayName || '',
        agentConversationId: ensured.profile?.agentConversationId || '',
        familiarize: ensured.profile?.familiarize ?? null,
      });
    }
    return { ok: true, bots };
  }

  function listNames(folder) {
    try {
      const names = readdir(folder);
      if (!Array.isArray(names)) return [];
      return names
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((name) => typeof name === 'string');
    } catch {
      return null;
    }
  }

  function startFamiliarize(workspaceId) {
    const loaded = activeProfile(workspaceId);
    if (!loaded.ok) return loaded;
    const profile = loaded.profile;
    if (pending.has(workspaceId)) return pending.get(workspaceId);
    if (profile.familiarize?.plan && (profile.familiarize.kind === 'blank' || profile.familiarize.dispatched === true)) {
      return { ok: true, profile, plan: profile.familiarize.plan, reused: true };
    }
    const folder = workspacePath(workspaceId);
    if (!folder) return fail('NOT_FOUND');
    const names = listNames(folder);
    if (!names) return fail('WORKSPACE_UNREADABLE');
    const head = resolveWorkspaceHead(folder, typeof gitRun === 'function' ? { run: gitRun } : {});
    const plan = buildFamiliarizePlan({
      displayName: profile.displayName,
      entries: names,
      git: head,
    });
    if (plan.kind === 'blank') {
      if (!conversationStore || typeof conversationStore.appendMessage !== 'function') {
        return fail('CONVERSATION_REQUIRED');
      }
      const appended = conversationStore.appendMessage(profile.agentConversationId, {
        id: `assistant-${randomUUID()}`,
        role: 'assistant',
        content: RESPONSIBILITY_QUESTION,
      });
      if (!appended) return fail('CONVERSATION_MISSING');
    }
    function saveStarted(result) {
      if (result?.error || result?.ok === false) return fail(result.error || result.code || 'SPAWN_FAILED');
      const saved = profiles.save({
        ...profiles.read(workspaceId),
        familiarize: { kind: plan.kind, plan, dispatched: plan.kind === 'research',
          ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
          startedAt: now() instanceof Date ? now().toISOString() : String(now()) },
      });
      return saved.ok ? { ok: true, profile: saved.profile, plan } : saved;
    }
    if (plan.kind !== 'research') return saveStarted(null);
    if (typeof spawn !== 'function') return fail('SPAWN_UNAVAILABLE');
    return dispatch(workspaceId, () => spawn({
      workspaceId, conversationId: profile.agentConversationId, workspacePath: folder,
      kind: 'research', readOnly: true, delegationOrigin: { readOnly: true, kind: 'research' }, task: plan.task,
    }), saveStarted);
  }

  function dispatch(workspaceId, run, save) {
    try {
      const result = run();
      if (!result?.then) return save(result);
      const promise = Promise.resolve(result).then(save, () => fail('SPAWN_FAILED'))
        .finally(() => pending.delete(workspaceId));
      pending.set(workspaceId, promise);
      return promise;
    } catch { return fail('SPAWN_FAILED'); }
  }

  function recordVerifiedFindings(workspaceId, findings) {
    const loaded = activeProfile(workspaceId);
    if (!loaded.ok) return loaded;
    if (!Array.isArray(findings)) return fail('INVALID_INPUT');
    if (!memoryStore || typeof memoryStore.writeVerified !== 'function') return fail('MEMORY_REQUIRED');
    const prepared = [];
    for (const finding of findings) {
      const text = typeof finding?.text === 'string' ? finding.text.trim() : '';
      const sourceRefs = Array.isArray(finding?.sourceRefs) ? finding.sourceRefs : [];
      if (!text || sourceRefs.length === 0) return fail('SOURCE_REFS_REQUIRED');
      prepared.push({
        workspaceId,
        kind: finding.kind || 'fact',
        text,
        sourceRefs,
      });
    }
    const items = [];
    for (const input of prepared) {
      const written = memoryStore.writeVerified(input);
      if (!written?.ok) return { ok: false, code: written?.reason || written?.code || 'MEMORY_REJECTED' };
      items.push(written.item);
    }
    return { ok: true, items };
  }

  function responsibilityText(workspaceId) {
    if (!memoryStore || typeof memoryStore.list !== 'function') return '';
    const items = memoryStore.list({ workspaceId, scope: 'project' });
    const hit = items.find((item) => (
      item.kind === 'responsibility' && item.status === 'active' && item.pinned === true
    ));
    return typeof hit?.text === 'string' ? hit.text : '';
  }

  function acceptResponsibility(workspaceId, input = {}) {
    const loaded = activeProfile(workspaceId);
    if (!loaded.ok) return loaded;
    const profile = loaded.profile;
    if (profile.familiarize?.kind !== 'blank') return fail('NOT_BLANK');
    if (profile.readmeOffer?.offered === true) {
      return {
        ok: true,
        profile,
        reused: true,
        cards: projectCards(workspaceId, { readmeOffer: profile.readmeOffer }),
      };
    }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return fail('INVALID_INPUT');
    if (!memoryStore || typeof memoryStore.rememberStated !== 'function') return fail('MEMORY_REQUIRED');
    if (!conversationStore || typeof conversationStore.appendMessage !== 'function') {
      return fail('CONVERSATION_REQUIRED');
    }
    const anchorMessageId = input.anchorMessageId || `user-${randomUUID()}`;
    const appended = input.anchorMessageId
      ? conversationStore.getPersistedConversationHistory?.(profile.agentConversationId)
      : conversationStore.appendMessage(profile.agentConversationId, {
      id: anchorMessageId,
      role: 'user',
      kind: 'user_input',
      content: text,
    });
    const messages = Array.isArray(appended?.messages) ? appended.messages : [];
    const written = memoryStore.rememberStated({
      workspaceId,
      kind: 'responsibility',
      text,
      pinned: true,
      anchorMessageId,
      messages,
    });
    if (!written?.ok) return { ok: false, code: written?.reason || written?.code || 'MEMORY_REJECTED' };
    const saved = profiles.save({
      ...profile,
      readmeOffer: { offered: true, accepted: false },
    });
    if (!saved.ok) return saved;
    return {
      ok: true,
      profile: saved.profile,
      item: written.item,
      cards: projectCards(workspaceId, { readmeOffer: { offered: true } }),
    };
  }

  function acceptReadme(workspaceId) {
    const loaded = activeProfile(workspaceId);
    if (!loaded.ok) return loaded;
    const profile = loaded.profile;
    if (profile.readmeOffer?.offered !== true) return fail('OFFER_MISSING');
    if (profile.readmeOffer.accepted === true) return { ok: true, profile, reused: true };
    if (pending.has(workspaceId)) return pending.get(workspaceId);
    if (typeof spawn !== 'function') return fail('SPAWN_UNAVAILABLE');
    const task = buildReadmeTask({ displayName: profile.displayName, responsibility: responsibilityText(workspaceId) });
    return dispatch(workspaceId, () => spawn({
      workspaceId, conversationId: profile.agentConversationId, workspacePath: workspacePath(workspaceId),
      kind: 'docs', readOnly: false, task,
    }), (result) => {
      if (result?.error || result?.ok === false) return fail(result.error || result.code || 'SPAWN_FAILED');
      const saved = profiles.save({ ...profiles.read(workspaceId),
        readmeOffer: { offered: true, accepted: true, ...(result?.sessionId ? { sessionId: result.sessionId } : {}) },
      });
      return saved.ok ? { ok: true, profile: saved.profile, task } : saved;
    });
  }

  function deleteBot(workspaceId, options = {}) {
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const profile = profiles.read(workspaceId);
    if (!profile) return fail('NOT_FOUND');
    if (profile.status === 'archived') return { ok: true, profile, reused: true };
    if (profile.managed === true && options.confirmManaged !== true) return fail('CONFIRM_REQUIRED');
    const folder = workspacePath(workspaceId);
    let trashed = null;
    if (profile.managed === true) {
      if (typeof moveToTrash !== 'function') return fail('TRASH_UNAVAILABLE');
      if (!folder) return fail('NOT_FOUND');
      const result = moveToTrash(folder);
      if (result && result.ok === false) return result;
      trashed = folder;
    }
    if (typeof removeWorkspace === 'function' && folder) {
      const removed = removeWorkspace(folder);
      if (removed && removed.ok === false) return removed;
    }
    const saved = profiles.save({ ...profile, status: 'archived' });
    if (!saved.ok) return saved;
    return { ok: true, profile: saved.profile, removedPath: folder || null, trashed };
  }

  function restoreBot(workspaceId) {
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const profile = profiles.read(workspaceId);
    if (!profile) return fail('NOT_FOUND');
    if (profile.status !== 'archived') return { ok: true, profile, restored: false };
    const saved = profiles.save({ ...profile, status: 'active' });
    if (!saved.ok) return saved;
    return {
      ok: true,
      profile: saved.profile,
      restored: true,
      agentConversationId: saved.profile.agentConversationId,
    };
  }

  return {
    ensureBot,
    ensureBots,
    readProfile: (workspaceId) => profiles.read(workspaceId),
    regenerateAvatar: (workspaceId) => profiles.regenerateAvatar(workspaceId),
    setAvatarColor: (workspaceId, color) => profiles.setAvatarColor(workspaceId, color),
    uploadAvatar: (workspaceId, sourcePath) => profiles.installAvatar(workspaceId, sourcePath),
    startFamiliarize,
    recordVerifiedFindings,
    acceptResponsibility,
    acceptReadme,
    deleteBot,
    restoreBot,
  };
}
