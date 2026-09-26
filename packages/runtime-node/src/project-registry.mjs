/**
 * 项目注册表：每个工作区一个稳定 workspaceId。
 *
 * 真源是 projects/registry.json。文件夹改名或搬家之后 id 不变。
 * settings.workspaces[].id 只是缓存：旧版本写回丢掉它时，按路径从这里取回原来的 id。
 * previousPaths 只记录旧路径，不参与匹配。不按路径相似度猜测身份。
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_STORE_ENTRIES } from './data-store.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 与远程委托标识同一形状，别名才能写进 workspaceIds。 */
const REMOTE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isRemoteWorkspaceId(value) {
  return typeof value === 'string' && REMOTE_WORKSPACE_ID.test(value);
}

function dataHome() {
  const override = process.env.PEER_AGENT_HOME;
  return override && override.trim()
    ? override.trim()
    : path.join(os.homedir(), '.peer-agent');
}

/** 注册表文件路径。不创建目录。 */
export function defaultProjectRegistryFile() {
  return path.join(dataHome(), DATA_STORE_ENTRIES.projects.rel, 'registry.json');
}

/**
 * 只读别名。文件缺失或损坏时返回空，不改磁盘。
 * @param {string} workspaceId
 * @param {string | null | undefined} registryFile
 */
export function readRemoteAliases(workspaceId, registryFile) {
  if (!isRemoteWorkspaceId(workspaceId) || typeof registryFile !== 'string' || !registryFile) return [];
  if (!existsSync(registryFile)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryFile, 'utf8'));
  } catch {
    return [];
  }
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : null;
  if (!Array.isArray(projects)) return [];
  const entry = projects.find((item) => item && item.workspaceId === workspaceId);
  const alias = entry?.remoteAlias;
  if (!isRemoteWorkspaceId(alias) || alias === workspaceId) return [];
  return [alias];
}

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 1) trimmed = trimmed.replace(/[\\/]+$/, '');
  return trimmed || null;
}

function defaultRealPath(folder) {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

function emptyDocument() {
  return { schemaVersion: 1, projects: [] };
}

function copyEntry(entry) {
  return {
    workspaceId: entry.workspaceId,
    path: entry.path,
    realPath: entry.realPath,
    createdAt: entry.createdAt,
    previousPaths: [...entry.previousPaths],
    ...(entry.remoteAlias ? { remoteAlias: entry.remoteAlias } : {}),
  };
}

function validateDocument(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) return null;
  const ids = new Set();
  const paths = new Set();
  const projects = [];
  for (const entry of parsed.projects) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (!UUID_V4.test(entry.workspaceId) || typeof entry.path !== 'string' || !entry.path) return null;
    if (typeof entry.realPath !== 'string' || !entry.realPath) return null;
    if (typeof entry.createdAt !== 'string' || !entry.createdAt) return null;
    if (!Array.isArray(entry.previousPaths) || entry.previousPaths.some((item) => typeof item !== 'string')) {
      return null;
    }
    if (entry.remoteAlias !== undefined && !isRemoteWorkspaceId(entry.remoteAlias)) return null;
    if (ids.has(entry.workspaceId) || paths.has(entry.path)) return null;
    ids.add(entry.workspaceId);
    paths.add(entry.path);
    projects.push({
      workspaceId: entry.workspaceId,
      path: entry.path,
      realPath: entry.realPath,
      createdAt: entry.createdAt,
      previousPaths: [...entry.previousPaths],
      ...(entry.remoteAlias ? { remoteAlias: entry.remoteAlias } : {}),
    });
  }
  return { schemaVersion: 1, projects };
}

/**
 * @param {{ filePath?: string | null, now?: () => Date, createId?: () => string, resolveRealPath?: (folder: string) => string }} [options]
 */
export function createProjectRegistry({
  filePath = null,
  now = () => new Date(),
  createId = () => randomUUID(),
  resolveRealPath = defaultRealPath,
} = {}) {
  let memory = null;

  function backupCorrupt() {
    const stamp = now().toISOString().replace(/:/g, '-');
    const dest = `${filePath}.corrupt-${stamp}`;
    copyFileSync(filePath, dest);
    return dest;
  }

  function readDoc() {
    if (!filePath) {
      if (!memory) memory = emptyDocument();
      return { doc: memory, dirty: false };
    }
    if (!existsSync(filePath)) return { doc: emptyDocument(), dirty: false };
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      const doc = validateDocument(parsed);
      if (!doc) throw new Error('invalid registry');
      return { doc, dirty: false };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { doc: emptyDocument(), dirty: false };
      backupCorrupt();
      return { doc: emptyDocument(), dirty: true };
    }
  }

  function writeDoc(doc) {
    const payload = {
      schemaVersion: 1,
      projects: doc.projects.map((entry) => copyEntry(entry)),
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temporary, filePath);
  }

  function withDoc(mutate) {
    const loaded = readDoc();
    const mark = () => { loaded.dirty = true; };
    const result = mutate(loaded.doc, mark);
    if (filePath) {
      if (loaded.dirty) writeDoc(loaded.doc);
    } else {
      memory = loaded.doc;
    }
    return result;
  }

  function findById(doc, workspaceId) {
    return doc.projects.find((entry) => entry.workspaceId === workspaceId) ?? null;
  }

  function findByPath(doc, folder) {
    const real = resolveRealPath(folder);
    if (real) {
      const byReal = doc.projects.find((entry) => entry.realPath === real);
      if (byReal) return byReal;
    }
    return doc.projects.find((entry) => entry.path === folder || entry.realPath === folder || (real && entry.path === real)) ?? null;
  }

  function ensure(doc, folder, mark) {
    const existing = findByPath(doc, folder);
    if (existing) return existing;
    const workspaceId = createId();
    if (!UUID_V4.test(workspaceId)) throw new Error('INVALID_WORKSPACE_ID');
    const entry = {
      workspaceId,
      path: folder,
      realPath: resolveRealPath(folder),
      createdAt: now().toISOString(),
      previousPaths: [],
    };
    doc.projects.push(entry);
    mark();
    return entry;
  }

  function adoptCache(doc, workspace, folder, mark) {
    const cached = typeof workspace?.id === 'string' ? workspace.id.trim() : '';
    if (!UUID_V4.test(cached) || findById(doc, cached)) return null;
    const entry = {
      workspaceId: cached,
      path: folder,
      realPath: resolveRealPath(folder),
      createdAt: typeof workspace.addedAt === 'string' && workspace.addedAt
        ? workspace.addedAt
        : now().toISOString(),
      previousPaths: [],
    };
    doc.projects.push(entry);
    mark();
    return entry;
  }

  function resolveWorkspace(doc, workspace, mark) {
    const folder = normalizePath(workspace?.path);
    if (!folder) return null;
    return findByPath(doc, folder) ?? adoptCache(doc, workspace, folder, mark) ?? ensure(doc, folder, mark);
  }

  function move(workspaceId, newPath) {
    const folder = normalizePath(newPath);
    if (!folder) return { ok: false, reason: 'missing-path' };
    return withDoc((doc, mark) => {
      const entry = findById(doc, workspaceId);
      if (!entry) return { ok: false, reason: 'not-found' };
      if (entry.path === folder) return { ok: true, entry: copyEntry(entry) };
      const owner = findByPath(doc, folder);
      if (owner && owner.workspaceId !== entry.workspaceId) return { ok: false, reason: 'taken' };
      const previous = new Set(entry.previousPaths.filter((item) => item !== folder));
      if (entry.path !== folder) previous.add(entry.path);
      entry.previousPaths = [...previous];
      entry.path = folder;
      entry.realPath = resolveRealPath(folder);
      mark();
      return { ok: true, entry: copyEntry(entry) };
    });
  }

  return {
    ensureForPath(folderPath) {
      const folder = normalizePath(folderPath);
      if (!folder) return null;
      return withDoc((doc, mark) => copyEntry(ensure(doc, folder, mark)));
    },
    recordMove: move,
    relinkWorkspace: move,
    setRemoteAlias(workspaceId, alias) {
      const cleaned = typeof alias === 'string' ? alias.trim() : '';
      if (cleaned && !isRemoteWorkspaceId(cleaned)) return { ok: false, reason: 'invalid-alias' };
      return withDoc((doc, mark) => {
        const entry = findById(doc, workspaceId);
        if (!entry) return { ok: false, reason: 'not-found' };
        if (!cleaned) {
          if (!entry.remoteAlias) return { ok: true, entry: copyEntry(entry) };
          delete entry.remoteAlias;
          mark();
          return { ok: true, entry: copyEntry(entry) };
        }
        if (doc.projects.some((item) => item.workspaceId === cleaned || (item.remoteAlias === cleaned && item.workspaceId !== workspaceId))) {
          return { ok: false, reason: 'taken' };
        }
        if (entry.remoteAlias === cleaned) return { ok: true, entry: copyEntry(entry) };
        entry.remoteAlias = cleaned;
        mark();
        return { ok: true, entry: copyEntry(entry) };
      });
    },
    sync(workspaces) {
      const list = Array.isArray(workspaces) ? workspaces : [];
      return withDoc((doc, mark) => list.map((workspace) => {
        const entry = resolveWorkspace(doc, workspace, mark);
        return entry ? copyEntry(entry) : null;
      }));
    },
    get(workspaceId) {
      return withDoc((doc) => {
        const entry = findById(doc, workspaceId);
        return entry ? copyEntry(entry) : null;
      });
    },
    findByPath(folderPath) {
      const folder = normalizePath(folderPath);
      if (!folder) return null;
      return withDoc((doc) => {
        const entry = findByPath(doc, folder);
        return entry ? copyEntry(entry) : null;
      });
    },
    list() {
      return withDoc((doc) => doc.projects.map((entry) => copyEntry(entry)));
    },
  };
}
