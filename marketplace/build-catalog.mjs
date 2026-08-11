import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
const SKILL_FILE = 'SKILL.md';
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const DATA_LEVELS = new Set(['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated']);
const REVIEW_STATUSES = new Set(['approved', 'pending', 'rejected']);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID}`);
  }
  return value;
}

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillMarkdown(markdown, context = SKILL_FILE, defaults = {}) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error(`${context} must start with YAML frontmatter`);
  const metadata = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(rawLine);
    if (!field) throw new Error(`${context} contains unsupported frontmatter: ${rawLine}`);
    metadata[field[1]] = scalar(field[2]);
  }
  metadata.whenToUse ||= defaults.whenToUse;
  metadata.version ||= defaults.version;
  for (const key of ['name', 'description', 'whenToUse', 'version']) {
    if (!metadata[key]) throw new Error(`${context} is missing ${key}`);
  }
  assertSafeId(metadata.name, `${context} name`);
  return { metadata, markdown };
}

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store' || entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in Skill packages: ${absolute}`);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile()) files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), content: readFileSync(absolute) });
  }
  return files;
}

function collectLocalSource(source, repositoryRoot) {
  const sourceRoot = path.resolve(repositoryRoot, source.path);
  const relative = path.relative(repositoryRoot, sourceRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Source escapes repository: ${source.path}`);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) throw new Error(`Source directory not found: ${source.path}`);
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(sourceRoot, entry.name, SKILL_FILE)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const skillRoot = path.join(sourceRoot, entry.name);
      return {
        sourcePath: `${source.path.replace(/\/$/, '')}/${entry.name}`,
        files: walkFiles(skillRoot),
      };
    });
}

function parseRepository(repository) {
  const match = /^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repository ?? '');
  if (!match) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
}

async function githubJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'peer-agent-marketplace' } });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`);
  return response.json();
}

async function collectGithubSource(source, fetchImpl) {
  const { owner, repo } = parseRepository(source.repository);
  const revision = source.revision || 'main';
  if (Array.isArray(source.entries) && source.entries.length > 0) {
    const response = await fetchImpl(`https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(revision)}`, {
      headers: { 'user-agent': 'peer-agent-marketplace' },
    });
    if (!response.ok) throw new Error(`GitHub archive request failed (${response.status}): ${source.repository}@${revision}`);
    const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const requested = new Set(source.entries.map((entry) => assertSafeId(entry, 'source entry')));
    const prefix = source.path.replace(/^\/+|\/+$/g, '');
    const skills = [];
    for (const entry of [...requested].sort()) {
      const suffix = `/${prefix}/${entry}/`;
      const files = archive.getEntries()
        .filter((item) => !item.isDirectory && item.entryName.includes(suffix))
        .map((item) => ({ path: item.entryName.slice(item.entryName.indexOf(suffix) + suffix.length), content: item.getData() }))
        .filter((item) => item.path && !item.path.split('/').includes('..'))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (!files.some((file) => file.path === SKILL_FILE)) throw new Error(`Requested GitHub Skill not found: ${prefix}/${entry}`);
      skills.push({ sourcePath: `${prefix}/${entry}`, files });
    }
    return skills;
  }
  const tree = await githubJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`, fetchImpl);
  if (tree.truncated) throw new Error(`GitHub tree is truncated: ${source.repository}@${revision}`);
  const prefix = source.path.replace(/^\/+|\/+$/g, '');
  const blobs = tree.tree.filter((item) => item.type === 'blob' && item.path.startsWith(`${prefix}/`));
  const skillRoots = [...new Set(blobs.filter((item) => item.path.endsWith(`/${SKILL_FILE}`)).map((item) => item.path.slice(0, -SKILL_FILE.length - 1)))].sort();
  const skills = [];
  for (const skillRoot of skillRoots) {
    const directParent = path.posix.dirname(skillRoot);
    if (directParent !== prefix) continue;
    const files = [];
    for (const blob of blobs.filter((item) => item.path.startsWith(`${skillRoot}/`)).sort((a, b) => a.path.localeCompare(b.path))) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(revision)}/${blob.path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetchImpl(rawUrl, { headers: { 'user-agent': 'peer-agent-marketplace' } });
      if (!response.ok) throw new Error(`GitHub file request failed (${response.status}): ${blob.path}`);
      files.push({ path: blob.path.slice(skillRoot.length + 1), content: Buffer.from(await response.arrayBuffer()) });
    }
    skills.push({ sourcePath: skillRoot, files });
  }
  return skills;
}

export async function collectSourceSkills(source, { repositoryRoot = DEFAULT_REPOSITORY_ROOT, fetchImpl = globalThis.fetch } = {}) {
  assertSafeId(source.sourceId, 'sourceId');
  if (source.kind === 'local-directory') return collectLocalSource(source, repositoryRoot);
  if (source.kind === 'github-directory') {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required for github-directory sources');
    return collectGithubSource(source, fetchImpl);
  }
  throw new Error(`Unsupported marketplace source kind: ${source.kind}`);
}

function createZip(files) {
  const zip = new AdmZip();
  for (const file of files) {
    if (file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error(`Unsafe package path: ${file.path}`);
    zip.addFile(file.path, file.content);
    const entry = zip.getEntry(file.path);
    if (entry) entry.header.time = new Date('1980-01-01T00:00:00.000Z');
  }
  return zip.toBuffer();
}

function normalizeEntry({ source, candidate, review, artifact }) {
  const skillFile = candidate.files.find((file) => file.path === SKILL_FILE);
  if (!skillFile) throw new Error(`${candidate.sourcePath} does not contain ${SKILL_FILE}`);
  const { metadata } = parseSkillMarkdown(skillFile.content.toString('utf8'), candidate.sourcePath, {
    ...source.defaults,
    whenToUse: review?.whenToUse ?? source.defaults?.whenToUse,
    version: review?.version ?? source.defaults?.version,
  });
  const directoryId = path.posix.basename(candidate.sourcePath);
  if (metadata.name !== directoryId) throw new Error(`${candidate.sourcePath} name must match its directory (${directoryId})`);
  const catalogId = `${source.sourceId}/${metadata.name}`;
  const status = review?.status ?? source.reviewStatus ?? 'pending';
  if (!REVIEW_STATUSES.has(status)) throw new Error(`${catalogId} has invalid review status: ${status}`);
  const dataLevel = review?.dataLevel ?? 'D0_public';
  if (!DATA_LEVELS.has(dataLevel)) throw new Error(`${catalogId} has invalid dataLevel: ${dataLevel}`);
  return {
    catalogId,
    skillId: metadata.name,
    name: review?.displayName ?? metadata.name,
    description: metadata.description,
    whenToUse: metadata.whenToUse,
    version: metadata.version,
    category: review?.category ?? source.defaultCategory ?? 'Other',
    tags: Array.isArray(review?.tags) ? [...new Set(review.tags)].sort() : [],
    dataLevel,
    reviewStatus: status,
    ...(review?.reviewedAt ? { reviewedAt: review.reviewedAt } : {}),
    source: {
      sourceId: source.sourceId,
      kind: source.kind,
      ...(source.repository ? { repository: source.repository } : {}),
      ...(source.revision ? { revision: source.revision } : {}),
      path: candidate.sourcePath,
    },
    artifact,
  };
}

export async function buildMarketplaceCatalog({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  marketplaceRoot = path.join(repositoryRoot, 'marketplace'),
  outputDirectory = path.join(marketplaceRoot, 'dist'),
  generatedAt = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  beforePublish,
} = {}) {
  const sourceDocument = readJson(path.join(marketplaceRoot, 'sources.json'));
  const reviewDocument = readJson(path.join(marketplaceRoot, 'reviews.json'));
  if (sourceDocument.schemaVersion !== 1 || !Array.isArray(sourceDocument.sources)) throw new Error('Unsupported sources.json schema');
  if (reviewDocument.schemaVersion !== 1 || !reviewDocument.reviews || Array.isArray(reviewDocument.reviews)) throw new Error('Unsupported reviews.json schema');

  const staging = mkdtempSync(path.join(path.dirname(outputDirectory), '.catalog-'));
  const artifactsDirectory = path.join(staging, 'artifacts');
  mkdirSync(artifactsDirectory, { recursive: true });
  const entries = [];
  const seen = new Set();
  try {
    for (const source of sourceDocument.sources.filter((item) => item.enabled !== false)) {
      const candidates = await collectSourceSkills(source, { repositoryRoot, fetchImpl });
      for (const candidate of candidates) {
        const skillFile = candidate.files.find((file) => file.path === SKILL_FILE);
        if (!skillFile) continue;
        const { metadata } = parseSkillMarkdown(skillFile.content.toString('utf8'), candidate.sourcePath, source.defaults);
        const catalogId = `${source.sourceId}/${metadata.name}`;
        if (seen.has(catalogId)) throw new Error(`Duplicate marketplace catalogId: ${catalogId}`);
        seen.add(catalogId);
        const review = reviewDocument.reviews[catalogId];
        const status = review?.status ?? source.reviewStatus ?? 'pending';
        if (status !== 'approved') continue;
        const zipBuffer = createZip(candidate.files);
        const filename = `${source.sourceId}--${metadata.name}--${metadata.version}.zip`;
        writeFileSync(path.join(artifactsDirectory, filename), zipBuffer);
        entries.push(normalizeEntry({
          source,
          candidate,
          review,
          artifact: {
            downloadUrl: `./artifacts/${filename}`,
            sha256: createHash('sha256').update(zipBuffer).digest('hex'),
            size: zipBuffer.length,
            format: 'zip',
          },
        }));
      }
    }
    entries.sort((a, b) => a.catalogId.localeCompare(b.catalogId));
    const catalog = { schemaVersion: 1, catalogId: 'peer-agent', generatedAt, entries };
    writeFileSync(path.join(staging, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    await beforePublish?.({ staging, catalog });
    const backup = `${outputDirectory}.previous`;
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(outputDirectory)) renameSync(outputDirectory, backup);
    try {
      renameSync(staging, outputDirectory);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup) && !existsSync(outputDirectory)) renameSync(backup, outputDirectory);
      throw error;
    }
    return catalog;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const catalog = await buildMarketplaceCatalog();
  console.log(`Built Peer Agent Skill Catalog with ${catalog.entries.length} approved skill(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
