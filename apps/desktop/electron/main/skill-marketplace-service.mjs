import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

function assertCatalog(value) {
  if (!value || value.schemaVersion !== 1 || value.catalogId !== 'peer-agent' || !Array.isArray(value.entries)) {
    throw new Error('skill_marketplace_catalog_invalid');
  }
  const ids = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry.catalogId !== 'string' || !entry.catalogId || ids.has(entry.catalogId)) {
      throw new Error('skill_marketplace_entry_invalid');
    }
    ids.add(entry.catalogId);
    if (entry.reviewStatus !== 'approved') throw new Error('skill_marketplace_entry_not_approved');
    if (entry.artifact?.format !== 'zip' || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256 ?? '')) {
      throw new Error('skill_marketplace_artifact_invalid');
    }
    if (!Number.isSafeInteger(entry.artifact.size) || entry.artifact.size <= 0 || entry.artifact.size > MAX_ARTIFACT_BYTES) {
      throw new Error('skill_marketplace_artifact_size_invalid');
    }
  }
  return value;
}

function resolveArtifact(catalogRoot, downloadUrl) {
  if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('./artifacts/')) {
    throw new Error('skill_marketplace_artifact_path_invalid');
  }
  const absolute = path.resolve(catalogRoot, downloadUrl);
  const relative = path.relative(catalogRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('skill_marketplace_artifact_path_invalid');
  return absolute;
}

export function createSkillMarketplaceService({ catalogRoot, installSkillFromZip }) {
  if (typeof catalogRoot !== 'string' || !catalogRoot) throw new TypeError('catalogRoot must be a path');
  if (typeof installSkillFromZip !== 'function') throw new TypeError('installSkillFromZip must be a function');
  const catalogPath = path.join(catalogRoot, 'catalog.json');
  let cached = null;
  let cachedMtime = -1;

  function readCatalog() {
    if (!existsSync(catalogPath)) return { schemaVersion: 1, catalogId: 'peer-agent', generatedAt: '', entries: [] };
    const mtime = statSync(catalogPath).mtimeMs;
    if (cached && mtime === cachedMtime) return cached;
    const parsed = assertCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
    cached = parsed;
    cachedMtime = mtime;
    return parsed;
  }

  function getEntry(catalogId) {
    if (typeof catalogId !== 'string' || !catalogId) throw new Error('skill_marketplace_catalog_id_required');
    return readCatalog().entries.find((entry) => entry.catalogId === catalogId) ?? null;
  }

  return Object.freeze({
    list() {
      return readCatalog();
    },
    getDetail(catalogId) {
      return getEntry(catalogId);
    },
    install(catalogId) {
      const entry = getEntry(catalogId);
      if (!entry) return { ok: false, error: 'skill_marketplace_entry_not_found' };
      const artifactPath = resolveArtifact(catalogRoot, entry.artifact.downloadUrl);
      if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
        return { ok: false, error: 'skill_marketplace_artifact_not_found' };
      }
      const zip = readFileSync(artifactPath);
      if (zip.length !== entry.artifact.size) return { ok: false, error: 'skill_marketplace_artifact_size_mismatch' };
      const digest = createHash('sha256').update(zip).digest('hex');
      if (digest !== entry.artifact.sha256) return { ok: false, error: 'skill_marketplace_artifact_checksum_mismatch' };
      const installed = installSkillFromZip(zip);
      if (!installed || installed.id !== entry.skillId) return { ok: false, error: 'skill_marketplace_installed_skill_mismatch' };
      return { ok: true, skillId: installed.id };
    },
  });
}
