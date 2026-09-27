/**
 * 记忆真源。项目条目在 projects/<workspaceId>/memory/items.jsonl，
 * 用户偏好在 memory/items.jsonl。只追加，按 id 折叠，最后一行有效。
 * 坏行跳过。inferred 本卡不写入。
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import { pathOf } from '../data-store.mjs';
import { memorySecretReason } from './memory-redaction.mjs';

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KINDS = new Set(['fact', 'preference', 'decision', 'procedure', 'responsibility']);
const TEXT_MAX = 2000;
const REASON_MAX = 500;
const REF_MAX = 200;
const REF_COUNT = 16;

export function isMemoryWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID.test(value);
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
  };
}

/**
 * @param {{ rootDir?: string | null, now?: () => Date }} [options]
 */
export function createMemoryStore({
  rootDir = null,
  now = () => new Date(),
} = {}) {
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
    if (input.trust !== 'stated' && input.trust !== 'verified') return null;
    if (input.status !== 'active' && input.status !== 'forgotten') return null;
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
    return record;
  }

  function readFolded(file) {
    if (!existsSync(file)) return [];
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
    return [...byId.values()];
  }

  function append(file, record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
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
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record) };
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
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record) };
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
    if (current.status === 'active') return { ok: true, item: current, alreadyActive: true };
    const record = {
      ...current,
      status: 'active',
      updatedAt: now().toISOString(),
    };
    delete record.forgetReason;
    append(fileFor(record), record);
    return { ok: true, item: copyItem(record) };
  }

  return {
    rememberStated,
    writeVerified,
    forget,
    restore,
    setPinned,
    reviseStated,
    markUsed,
    list,
    get,
    userFile,
    projectFile,
  };
}
