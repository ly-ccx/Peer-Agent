import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 3;

function emptyPublished() {
  return { schemaVersion: SCHEMA_VERSION, source: 'skillhub', updatedAt: null, items: [], categories: [] };
}

function emptyCheckpoint() {
  return { schemaVersion: SCHEMA_VERSION, status: 'idle', nextPage: 1, total: 0, error: null, skipped: 0, skippedReasons: {} };
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function readPublished(filePath) {
  const value = readJson(filePath, emptyPublished());
  if (!Array.isArray(value?.items)) return emptyPublished();
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'skillhub',
    updatedAt: value.schemaVersion === SCHEMA_VERSION && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
    items: value.items,
    categories: Array.isArray(value.categories) ? value.categories : [],
  };
}

function atomicWrite(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, filePath);
}

function pageFile(pagesPath, page) {
  return path.join(pagesPath, `${String(page).padStart(6, '0')}.json`);
}

function readPendingPages(pagesPath) {
  const byId = new Map();
  if (!existsSync(pagesPath)) return byId;
  for (const fileName of readdirSync(pagesPath).filter((name) => /^\d{6}\.json$/.test(name)).sort()) {
    const value = readJson(path.join(pagesPath, fileName), null);
    if (!Array.isArray(value?.items)) continue;
    for (const item of value.items) byId.set(item.catalogId, item);
  }
  return byId;
}

function haystack(item) {
  return [
    item.name,
    item.slug,
    item.canonicalName,
    item.description,
    item.descriptionOriginal,
    item.category,
    item.ownerName,
    ...(Array.isArray(item.subCategories) ? item.subCategories.map((entry) => entry.name) : []),
    ...Object.keys(item.labels ?? {}),
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

export function createSkillHubMarketplaceStore({ filePath, apiClient, now = () => Date.now() }) {
  if (!filePath) throw new TypeError('filePath is required');
  if (!apiClient?.listSkills) throw new TypeError('apiClient.listSkills is required');

  const checkpointPath = `${filePath}.checkpoint.json`;
  const pagesPath = `${filePath}.pages`;
  const categoriesPath = `${filePath}.categories.json`;
  let published = readPublished(filePath);
  let checkpoint = readJson(checkpointPath, emptyCheckpoint());
  if (checkpoint?.schemaVersion !== SCHEMA_VERSION) checkpoint = emptyCheckpoint();
  let pendingById = readPendingPages(pagesPath);
  if (checkpoint.nextPage > 1 && pendingById.size === 0) checkpoint = emptyCheckpoint();
  let categories = Array.isArray(published.categories) && published.categories.length > 0
    ? published.categories
    : (readJson(categoriesPath, { items: [] })?.items ?? []);
  let syncing = null;

  function saveCheckpoint() { atomicWrite(checkpointPath, checkpoint); }

  function resetPending() {
    rmSync(pagesPath, { recursive: true, force: true });
    pendingById = new Map();
    checkpoint = { ...emptyCheckpoint(), status: 'syncing' };
  }

  async function refreshCategories() {
    if (typeof apiClient.listCategories !== 'function') return categories;
    try {
      const result = await apiClient.listCategories();
      categories = Array.isArray(result?.items) ? result.items : [];
      atomicWrite(categoriesPath, { schemaVersion: SCHEMA_VERSION, updatedAt: now(), items: categories });
      if (published.items.length > 0) {
        published = { ...published, categories };
        atomicWrite(filePath, published);
      }
    } catch {
      // 分类刷新失败不阻断技能索引同步，保留旧字典。
    }
    return categories;
  }

  async function sync({ reset = false, maxPages = Infinity, onProgress } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const continuing = !reset && checkpoint.nextPage > 1 && pendingById.size > 0;
      if (!continuing) resetPending();
      checkpoint = { ...checkpoint, status: 'syncing', error: null };
      saveCheckpoint();
      // 分类字典轻量：先刷新一次，失败不阻断技能分页同步。
      await refreshCategories();
      let page = checkpoint.nextPage;
      let completedPages = 0;
      try {
        while (completedPages < maxPages) {
          const result = await apiClient.listSkills({ page, pageSize: 100, sortBy: 'score' });
          mkdirSync(pagesPath, { recursive: true });
          atomicWrite(pageFile(pagesPath, page), { schemaVersion: SCHEMA_VERSION, page, items: result.items });
          for (const item of result.items) pendingById.set(item.catalogId, item);
          const skippedReasons = { ...(checkpoint.skippedReasons ?? {}) };
          for (const [reason, count] of Object.entries(result.skippedReasons ?? {})) {
            skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count;
          }
          const received = Number.isSafeInteger(result.received) ? result.received : result.items.length;
          const done = received === 0 || page * result.pageSize >= result.total;
          checkpoint = {
            schemaVersion: SCHEMA_VERSION,
            status: done ? 'idle' : 'syncing',
            nextPage: done ? 1 : page + 1,
            total: result.total,
            error: null,
            skipped: (checkpoint.skipped ?? 0) + (result.skipped ?? 0),
            skippedReasons,
          };
          if (done) {
            published = {
              schemaVersion: SCHEMA_VERSION,
              source: 'skillhub',
              updatedAt: now(),
              items: [...pendingById.values()],
              categories,
            };
            atomicWrite(filePath, published);
            rmSync(pagesPath, { recursive: true, force: true });
            pendingById = new Map();
          }
          saveCheckpoint();
          completedPages += 1;
          onProgress?.({ page, total: result.total, indexed: done ? published.items.length : pendingById.size, done });
          if (done) break;
          page += 1;
        }
        return getStatus();
      } catch (error) {
        checkpoint = {
          ...checkpoint,
          status: 'error',
          nextPage: page,
          error: error instanceof Error ? error.message : String(error),
        };
        saveCheckpoint();
        throw error;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  function readableItems() {
    return published.items.length > 0 ? published.items : [...pendingById.values()];
  }

  function query({ page = 1, pageSize = 24, keyword = '', category = '', sortBy = 'score' } = {}) {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('marketplace_invalid_page');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('marketplace_invalid_page_size');
    const needle = keyword.trim().toLocaleLowerCase();
    let items = readableItems().filter((item) => (!needle || haystack(item).includes(needle)) && (!category || item.category === category));

    // 近期飙升：仅保留近 14 天有更新的条目，再按下载量排序（SkillHub 无官方趋势字段，本地近似）。
    if (sortBy === 'rising') {
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const recent = items.filter((item) => Number(item.updatedAt) >= cutoff);
      items = recent.length > 0 ? recent : items;
    }

    const compare = sortBy === 'downloads' || sortBy === 'rising'
      ? (a, b) => (b.downloads - a.downloads) || (b.score - a.score)
      : sortBy === 'stars'
        ? (a, b) => (b.stars - a.stars) || (b.downloads - a.downloads)
        : sortBy === 'created'
          ? (a, b) => (b.createdAt - a.createdAt) || (b.updatedAt - a.updatedAt)
          : sortBy === 'updated'
            ? (a, b) => b.updatedAt - a.updatedAt
            : sortBy === 'featured'
              ? (a, b) => (Number(b.verified) - Number(a.verified)) || (b.score - a.score) || (b.downloads - a.downloads)
              : (a, b) => (b.score - a.score) || (b.downloads - a.downloads);

    items = [...items].sort((a, b) => compare(a, b) || a.catalogId.localeCompare(b.catalogId));
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { page, pageSize, total, items: items.slice(start, start + pageSize), sync: getStatus() };
  }

  function getById(catalogId) {
    return readableItems().find((item) => item.catalogId === catalogId) ?? null;
  }

  function getStatus() {
    return {
      status: checkpoint.status,
      nextPage: checkpoint.nextPage,
      total: checkpoint.total,
      error: checkpoint.error,
      skipped: checkpoint.skipped ?? 0,
      skippedReasons: checkpoint.skippedReasons ?? {},
      indexed: published.items.length > 0 ? published.items.length : pendingById.size,
      updatedAt: published.updatedAt,
    };
  }

  function listCategories() {
    return categories.slice();
  }

  function getCategoryName(key) {
    if (!key) return '其他';
    const found = categories.find((item) => item.key === key);
    return found?.name || key;
  }

  return Object.freeze({ sync, query, getById, getStatus, listCategories, getCategoryName, refreshCategories });
}
