/**
 * 记忆真源。项目条目在 projects/<workspaceId>/memory/items.jsonl，
 * 用户偏好在 memory/items.jsonl。只追加，按 id 折叠，最后一行有效。
 * 坏行跳过。工具路径不写 inferred。
 * inferred 偏好只由 Curator 在 3 个不同 episode 之后经 writeCurated 写入。
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { pathOf } from '../data-store.mjs';
import { memorySecretReason } from './memory-redaction.mjs';
import { memoryConflictDecision } from './conflict.mjs';

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KINDS = new Set(['fact', 'preference', 'decision', 'procedure', 'responsibility']);
const TEXT_MAX = 2000;
const REASON_MAX = 500;
const REF_MAX = 200;
const REF_COUNT = 16;
const STATUSES = new Set(['active', 'forgotten', 'expired', 'conflicted']);

function metadata(input) {
  const result = {};
  if (input.expiresAt != null) {
    if (typeof input.expiresAt !== 'string' || input.expiresAt.length > 40 || !Number.isFinite(Date.parse(input.expiresAt))) return null;
    result.expiresAt = new Date(input.expiresAt).toISOString();
  }
  if (input.topicKey != null || input.topicValue != null) {
    if (typeof input.topicKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.topicKey)
      || !clip(input.topicValue, 200) || memorySecretReason(input.topicValue)) return null;
    result.topicKey = input.topicKey.toLowerCase(); result.topicValue = input.topicValue.trim().toLowerCase();
  }
  if (input.fileAnchors != null) {
    if (!Array.isArray(input.fileAnchors) || input.fileAnchors.length > 16) return null;
    result.fileAnchors = [];
    for (const anchor of input.fileAnchors) {
      if (!clip(anchor?.path, 500) || path.isAbsolute(anchor.path) || anchor.path.includes('\\') || anchor.path.split('/').includes('..')
        || !clip(anchor.contentHash, 128)) return null;
      result.fileAnchors.push({ path: anchor.path, contentHash: anchor.contentHash, commit: clip(anchor.commit, 200) || null });
    }
  }
  if (input.needsReverify === true) result.needsReverify = true;
  for (const key of ['conflictId', 'supersededBy', 'maintenanceReason']) if (clip(input[key], 200)) result[key] = input[key];
  if (Array.isArray(input.conflictsWith)) result.conflictsWith = input.conflictsWith.filter(id => clip(id, 200)).slice(0, 100);
  return result;
}

export function isMemoryWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID.test(value);
}

export function isEffectiveMemory(item, at = Date.now()) {
  if (item?.status !== 'active' || item.needsReverify === true) return false;
  if (item.pinned || item.kind === 'responsibility') return true;
  if (item.expiresAt && Date.parse(item.expiresAt) <= at) return false;
  return !(item.kind === 'preference' && item.trust === 'inferred'
    && at - Date.parse(item.lastUsedAt || item.createdAt) >= 90 * 24 * 60 * 60_000);
}

function fail(reason) {
  return { ok: false, reason };
}

function clip(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function isUserInput(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  if (kind === 'user_input') return true;
  if (typeof kind === 'string' && kind) return false;
  return message?.role === 'user';
}

function messageId(message) {
  if (typeof message?.id === 'string' && message.id.trim()) return message.id.trim();
  if (typeof message?.messageId === 'string' && message.messageId.trim()) return message.messageId.trim();
  return null;
}

function copyItem(item) {
  return {
    ...item,
    sourceRefs: [...item.sourceRefs],
    ...(item.fileAnchors ? { fileAnchors: item.fileAnchors.map(anchor => ({ ...anchor })) } : {}),
    ...(item.conflictsWith ? { conflictsWith: [...item.conflictsWith] } : {}),
  };
}

/**
 * @param {{ rootDir?: string | null, now?: () => Date }} [options]
 */
export function createMemoryStore({
  rootDir = null,
  now = () => new Date(),
} = {}) {
  const foldedCache = new Map();
  function fileVersion(file) {
    try { const stat = statSync(file); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch { return null; }
  }
  function getVersion() {
    return [userFile(), ...projectFiles().sort()].map(file => `${file}:${fileVersion(file)}`).join('|');
  }
  function projectsRoot() {
    return rootDir ? path.join(rootDir, 'projects') : pathOf('projects');
  }

  function userFile() {
    const base = rootDir ? path.join(rootDir, 'memory') : pathOf('userMemory');
    return path.join(base, 'items.jsonl');
  }

  function projectFile(workspaceId) {
    return path.join(projectsRoot(), workspaceId, 'memory', 'items.jsonl');
  }

  function fileFor(item) {
    return item.scope === 'user' ? userFile() : projectFile(item.workspaceId);
  }

  function projectFiles() {
    const dir = projectsRoot();
    if (!existsSync(dir)) return [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isMemoryWorkspaceId(entry.name)) continue;
      const file = projectFile(entry.name);
      if (existsSync(file)) files.push(file);
    }
    return files;
  }

  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const id = clip(input.id, 200);
    const text = clip(input.text, TEXT_MAX);
    if (!id || !text || !KINDS.has(input.kind)) return null;
    const inferredPreference = input.trust === 'inferred'
      && input.kind === 'preference'
      && input.scope === 'user'
      && STATUSES.has(input.status)
      && Number.isInteger(input.confirmedCount)
      && input.confirmedCount >= 3;
    if (input.trust !== 'stated' && input.trust !== 'verified' && !inferredPreference) return null;
    if (!STATUSES.has(input.status)) return null;
    if (input.scope !== 'project' && input.scope !== 'user') return null;
    if (input.scope === 'project' && !isMemoryWorkspaceId(input.workspaceId)) return null;
    if (input.scope === 'user' && input.kind !== 'preference') return null;
    if (input.scope === 'project' && input.kind === 'preference') return null;
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) return null;
    const sourceRefs = [];
    for (const ref of input.sourceRefs) {
      const next = clip(ref, REF_MAX);
      if (!next) return null;
      sourceRefs.push(next);
    }
    const record = {
      id,
      scope: input.scope,
      kind: input.kind,
      text,
      trust: input.trust,
      sourceRefs,
      pinned: input.pinned === true,
      status: input.status,
      confirmedCount: Number.isInteger(input.confirmedCount) && input.confirmedCount >= 0
        ? input.confirmedCount
        : 1,
      createdAt: clip(input.createdAt, 40) || now().toISOString(),
      updatedAt: clip(input.updatedAt, 40) || now().toISOString(),
    };
    const lastUsedAt = clip(input.lastUsedAt, 40);
    if (lastUsedAt) record.lastUsedAt = lastUsedAt;
    if (input.scope === 'project') record.workspaceId = input.workspaceId;
    const anchorMessageId = clip(input.anchorMessageId, REF_MAX);
    if (anchorMessageId) record.anchorMessageId = anchorMessageId;
    const forgetReason = clip(input.forgetReason, REASON_MAX);
    if (input.status === 'forgotten' && forgetReason) record.forgetReason = forgetReason;
    const extra = metadata(input); if (!extra) return null;
    Object.assign(record, extra);
    return record;
  }

  function readFolded(file) {
    const version = fileVersion(file);
    if (version === null) { foldedCache.delete(file); return []; }
    const cached = foldedCache.get(file);
    if (cached?.version === version) return cached.items;
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const byId = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = normalize(JSON.parse(line));
        if (record) byId.set(record.id, record);
      } catch {
        // 坏行跳过，不挡住其余条目。
      }
    }
    const items = [...byId.values()];
    foldedCache.set(file, { version, items });
    return items;
  }

  function append(file, record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  function writeNew(record) {
    const existing = list({ workspaceId: record.workspaceId, scope: record.scope });
    const decision = memoryConflictDecision(record, existing);
    const records = decision.replaceIds.map(id => ({ ...existing.find(item => item.id === id), status: 'forgotten',
      forgetReason: 'superseded', supersededBy: record.id, updatedAt: record.updatedAt }));
    if (decision.conflictIds.length) {
      const linked = existing.filter(item => decision.conflictIds.includes(item.id));
      const linkedIds = new Set(linked.flatMap(item => [item.id, ...(item.conflictsWith || [])]));
      const eligible = existing.filter(item => linkedIds.has(item.id) && ['active', 'conflicted'].includes(item.status) && !decision.replaceIds.includes(item.id));
      const ids = [...new Set([record.id, ...eligible.map(item => item.id)])].sort();
      const conflictId = `memory:${ids[0]}`;
      for (const item of eligible) records.push({ ...item, status: 'conflicted', conflictId,
        conflictsWith: ids.filter(id => id !== item.id), updatedAt: record.updatedAt });
      record = { ...record, status: 'conflicted', conflictId, conflictsWith: ids.filter(id => id !== record.id) };
    }
    records.push(record);
    const file = fileFor(record); mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, records.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    return { ok: true, item: copyItem(record) };
  }

  function list({ workspaceId, status, scope } = {}) {
    const items = [];
    if (scope !== 'project') items.push(...readFolded(userFile()));
    if (scope !== 'user') {
      if (workspaceId !== undefined && workspaceId !== null) {
        if (isMemoryWorkspaceId(workspaceId)) items.push(...readFolded(projectFile(workspaceId)));
      } else {
        for (const file of projectFiles()) items.push(...readFolded(file));
      }
    }
    const filtered = status ? items.filter((item) => item.status === status) : items;
    return filtered.map(copyItem);
  }

  function get(id) {
    const key = clip(id, 200);
    if (!key) return null;
    const user = readFolded(userFile()).find((item) => item.id === key);
    if (user) return copyItem(user);
    for (const file of projectFiles()) {
      const hit = readFolded(file).find((item) => item.id === key);
      if (hit) return copyItem(hit);
    }
    return null;
  }

  function place(kind, workspaceId) {
    if (!KINDS.has(kind)) return fail('invalid_kind');
    if (kind === 'preference') return { ok: true, scope: 'user' };
    if (!isMemoryWorkspaceId(workspaceId)) return fail('invalid_workspace');
    return { ok: true, scope: 'project', workspaceId };
  }

  function draft(input, trust) {
    const text = clip(input?.text, TEXT_MAX);
    if (!text) return fail('invalid_input');
    if (memorySecretReason(text)) return fail('sensitive');
    if (input?.pinned !== undefined && typeof input.pinned !== 'boolean') return fail('invalid_input');
    const placed = place(input?.kind, input?.workspaceId);
    if (!placed.ok) return placed;
    const stamp = now().toISOString();
    const record = {
      id: `mem-${randomUUID()}`,
      scope: placed.scope,
      kind: input.kind,
      text,
      trust,
      pinned: input.pinned === true,
      status: 'active',
      confirmedCount: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (placed.scope === 'project') record.workspaceId = placed.workspaceId;
    const extra = metadata(input); if (!extra) return fail('invalid_input');
    Object.assign(record, extra);
    return { ok: true, record };
  }

  function rememberStated(input = {}) {
    const built = draft(input, 'stated');
    if (!built.ok) return built;
    const anchorMessageId = clip(input.anchorMessageId, REF_MAX);
    if (!anchorMessageId) return fail('anchor_required');
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const message = messages.find((item) => messageId(item) === anchorMessageId);
    if (!message || !isUserInput(message)) return fail('anchor_not_user_input');
    const record = {
      ...built.record,
      trust: 'stated',
      sourceRefs: [anchorMessageId],
      anchorMessageId,
    };
    return writeNew(record);
  }

  function writeCurated(input = {}) {
    if (input?.trust !== 'inferred' || input?.kind !== 'preference') return fail('invalid_input');
    if (!Number.isInteger(input.confirmedCount) || input.confirmedCount < 3) return fail('preference_unconfirmed');
    const built = draft(input, 'inferred');
    if (!built.ok) return built;
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 3 || input.sourceRefs.length > REF_COUNT) {
      return fail('source_refs_required');
    }
    const sourceRefs = [];
    for (const ref of input.sourceRefs) {
      const next = clip(ref, REF_MAX);
      if (!next) return fail('source_refs_required');
      if (memorySecretReason(next)) return fail('sensitive');
      sourceRefs.push(next);
    }
    const record = {
      ...built.record,
      trust: 'inferred',
      confirmedCount: input.confirmedCount,
      sourceRefs,
    };
    return writeNew(record);
  }

  function writeVerified(input = {}) {
    const built = draft(input, 'verified');
    if (!built.ok) return built;
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0 || input.sourceRefs.length > REF_COUNT) {
      return fail('source_refs_required');
    }
    const sourceRefs = [];
    for (const ref of input.sourceRefs) {
      const next = clip(ref, REF_MAX);
      if (!next) return fail('source_refs_required');
      if (memorySecretReason(next)) return fail('sensitive');
      sourceRefs.push(next);
    }
    const record = {
      ...built.record,
      trust: 'verified',
      sourceRefs,
    };
    return writeNew(record);
  }

  function visible(item, workspaceId) {
    if (!item) return null;
    if (item.scope === 'user') return item;
    if (!isMemoryWorkspaceId(workspaceId) || item.workspaceId !== workspaceId) return null;
    return item;
  }

  function forget(input = {}) {
    const id = clip(input.id, 200);
    const reason = clip(input.reason, REASON_MAX);
    if (!id || !reason) return fail('invalid_input');
    if (memorySecretReason(reason)) return fail('sensitive');
    const current = visible(get(id), input.workspaceId);
    if (!current) return fail('not_found');
    if (current.status === 'forgotten') return { ok: true, item: current, alreadyForgotten: true };
    const record = {
      ...current,
      status: 'forgotten',
      forgetReason: reason,
      updatedAt: now().toISOString(),
    };
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record) };
  }

  function setPinned(input = {}) {
    if (typeof input.pinned !== 'boolean') return fail('invalid_input');
    const id = clip(input.id, 200);
    if (!id) return fail('invalid_input');
    const current = visible(get(id), input.workspaceId);
    if (!current || current.status !== 'active') return fail('not_found');
    if (current.pinned === input.pinned) return { ok: true, item: current };
    const record = {
      ...current,
      pinned: input.pinned,
      updatedAt: now().toISOString(),
    };
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record) };
  }

  function reviseStated(input = {}) {
    const id = clip(input.id, 200);
    const text = clip(input.text, TEXT_MAX);
    if (!id || !text) return fail('invalid_input');
    if (memorySecretReason(text)) return fail('sensitive');
    const current = visible(get(id), input.workspaceId);
    if (!current || current.status !== 'active') return fail('not_found');
    const stamp = now().toISOString();
    const forgotten = {
      ...current,
      status: 'forgotten',
      forgetReason: 'edited',
      updatedAt: stamp,
    };
    const record = {
      id: `mem-${randomUUID()}`,
      scope: current.scope,
      kind: current.kind,
      text,
      trust: 'stated',
      sourceRefs: [`edit:${current.id}`],
      pinned: current.pinned === true,
      status: 'active',
      confirmedCount: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (current.scope === 'project') record.workspaceId = current.workspaceId;
    append(fileFor(forgotten), forgotten);
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record), revokedId: current.id };
  }

  function markUsed(ids, at = now().toISOString()) {
    const stamp = clip(at, 40);
    if (!stamp) return [];
    const touched = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const current = get(raw);
      if (!current || current.status !== 'active') continue;
      const record = {
        ...current,
        lastUsedAt: stamp,
      };
      append(fileFor(record), record);
      touched.push(copyItem(record));
    }
    return touched;
  }

  function restore(input = {}) {
    const id = clip(input.id, 200);
    if (!id) return fail('invalid_input');
    const current = visible(get(id), input.workspaceId);
    if (!current) return fail('not_found');
    if (current.status === 'conflicted') return fail('conflict_choice_required');
    if (current.status === 'active') return { ok: true, item: current, alreadyActive: true };
    const record = {
      ...current,
      status: 'active',
      updatedAt: now().toISOString(),
    };
    delete record.forgetReason;
    return writeNew(record);
  }

  function markMaintained(input = {}) {
    const current = visible(get(input.id), input.workspaceId);
    if (!current) return fail('not_found');
    if (input.status !== undefined && input.status !== 'expired') return fail('invalid_input');
    const record = { ...current, ...(input.status ? { status: input.status } : {}),
      ...(input.needsReverify === true ? { needsReverify: true } : {}),
      maintenanceReason: clip(input.maintenanceReason, 200) || 'maintenance', updatedAt: now().toISOString() };
    append(fileFor(record), record); return { ok: true, item: copyItem(record) };
  }

  function resolveConflict(input = {}) {
    const current = visible(get(input.id), input.workspaceId);
    if (current?.status === 'active') return { ok: true, item: current, alreadyResolved: true };
    if (!current || current.status !== 'conflicted' || !current.conflictId) return fail('not_conflicted');
    const others = list({ workspaceId: input.workspaceId, scope: current.scope }).filter(item => item.id !== current.id && item.status === 'conflicted' && item.conflictId === current.conflictId);
    const updatedAt = now().toISOString();
    const records = others.map(other => ({ ...other, status: 'forgotten', forgetReason: 'conflict_choice', supersededBy: current.id, updatedAt }));
    const record = { ...current, status: 'active', updatedAt };
    delete record.conflictId; delete record.conflictsWith;
    records.push(record);
    appendFileSync(fileFor(record), records.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    return { ok: true, item: copyItem(record) };
  }

  return {
    rememberStated,
    writeVerified,
    writeCurated,
    forget,
    restore,
    resolveConflict,
    markMaintained,
    setPinned,
    reviseStated,
    markUsed,
    list,
    get,
    userFile,
    projectFile,
    getVersion,
  };
}
