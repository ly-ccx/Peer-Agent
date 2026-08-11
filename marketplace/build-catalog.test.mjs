import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { buildMarketplaceCatalog, parseSkillMarkdown } from './build-catalog.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createSkill(root, id, overrides = {}) {
  const skillRoot = path.join(root, 'skills', id);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(path.join(skillRoot, 'SKILL.md'), `---\nname: ${overrides.name ?? id}\ndescription: ${overrides.description ?? `Use ${id}`}\nwhenToUse: ${overrides.whenToUse ?? `When ${id} is needed`}\nversion: ${overrides.version ?? '1.0.0'}\n---\n\n# ${id}\n`);
  writeFileSync(path.join(skillRoot, 'note.txt'), overrides.note ?? 'supporting file');
}

function createMarketplace(root, { sources, reviews }) {
  const marketplaceRoot = path.join(root, 'marketplace');
  writeJson(path.join(marketplaceRoot, 'sources.json'), { schemaVersion: 1, sources });
  writeJson(path.join(marketplaceRoot, 'reviews.json'), { schemaVersion: 1, reviews });
  return marketplaceRoot;
}

const localSource = {
  sourceId: 'owned',
  kind: 'local-directory',
  path: 'skills',
  enabled: true,
  defaultCategory: 'Peer Agent',
};

test('parses required Skill frontmatter and rejects incomplete metadata', () => {
  const parsed = parseSkillMarkdown('---\nname: demo\ndescription: Demo\nwhenToUse: Tests\nversion: 1.2.3\n---\n');
  assert.equal(parsed.metadata.name, 'demo');
  assert.throws(() => parseSkillMarkdown('---\nname: demo\ndescription: Demo\nversion: 1\n---\n'), /missing whenToUse/);
  const compatible = parseSkillMarkdown('---\nname: upstream\ndescription: Upstream\n---\n', 'upstream', { whenToUse: 'Use upstream', version: '2026.08.06' });
  assert.equal(compatible.metadata.whenToUse, 'Use upstream');
  assert.equal(compatible.metadata.version, '2026.08.06');
});

test('builds an approved catalog, deterministic zip, and excludes unapproved skills', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-build-'));
  createSkill(root, 'alpha');
  createSkill(root, 'pending');
  const marketplaceRoot = createMarketplace(root, {
    sources: [localSource],
    reviews: {
      'owned/alpha': { status: 'approved', reviewedAt: '2026-08-06T00:00:00.000Z', category: 'Tests', tags: ['z', 'a', 'a'] },
      'owned/pending': { status: 'pending' },
    },
  });
  const options = { repositoryRoot: root, marketplaceRoot, generatedAt: '2026-08-06T01:00:00.000Z' };
  const first = await buildMarketplaceCatalog(options);
  const firstZip = readFileSync(path.join(marketplaceRoot, 'dist', first.entries[0].artifact.downloadUrl));
  const second = await buildMarketplaceCatalog(options);
  const secondZip = readFileSync(path.join(marketplaceRoot, 'dist', second.entries[0].artifact.downloadUrl));

  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].catalogId, 'owned/alpha');
  assert.deepEqual(first.entries[0].tags, ['a', 'z']);
  assert.equal(first.entries[0].artifact.sha256, second.entries[0].artifact.sha256);
  assert.deepEqual(firstZip, secondZip);
  assert.deepEqual(new AdmZip(firstZip).getEntries().map((entry) => entry.entryName).sort(), ['SKILL.md', 'note.txt']);
});

test('rejects duplicate normalized catalog ids across one source', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-duplicate-'));
  createSkill(root, 'first', { name: 'shared' });
  createSkill(root, 'second', { name: 'shared' });
  const marketplaceRoot = createMarketplace(root, { sources: [localSource], reviews: {} });
  await assert.rejects(() => buildMarketplaceCatalog({ repositoryRoot: root, marketplaceRoot }), /name must match its directory|Duplicate/);
});

test('keeps the previous catalog when a build fails before publish', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-atomic-'));
  createSkill(root, 'stable');
  const marketplaceRoot = createMarketplace(root, {
    sources: [localSource],
    reviews: { 'owned/stable': { status: 'approved' } },
  });
  await buildMarketplaceCatalog({ repositoryRoot: root, marketplaceRoot, generatedAt: 'first' });
  const catalogPath = path.join(marketplaceRoot, 'dist', 'catalog.json');
  const previous = readFileSync(catalogPath, 'utf8');

  await assert.rejects(
    () => buildMarketplaceCatalog({
      repositoryRoot: root,
      marketplaceRoot,
      generatedAt: 'second',
      beforePublish() { throw new Error('simulated publish failure'); },
    }),
    /simulated publish failure/,
  );
  assert.equal(readFileSync(catalogPath, 'utf8'), previous);
  assert.equal(existsSync(path.join(marketplaceRoot, 'dist', 'artifacts')), true);
});

test('supports an API-free pinned GitHub archive with an explicit entry allowlist', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-archive-'));
  const source = {
    sourceId: 'trusted-archive', kind: 'github-directory', repository: 'peer/example-skills', revision: 'pinned-sha',
    path: 'skills', entries: ['demo'], enabled: true, defaults: { whenToUse: 'Use demo', version: '2026.08.06' },
  };
  const marketplaceRoot = createMarketplace(root, {
    sources: [source], reviews: { 'trusted-archive/demo': { status: 'approved' } },
  });
  const zip = new AdmZip();
  zip.addFile('example-skills-pinned/skills/demo/SKILL.md', Buffer.from('---\nname: demo\ndescription: Demo\n---\n'));
  zip.addFile('example-skills-pinned/skills/demo/LICENSE.txt', Buffer.from('Apache License'));
  zip.addFile('example-skills-pinned/skills/not-approved/SKILL.md', Buffer.from('---\nname: not-approved\ndescription: No\n---\n'));
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return { ok: true, arrayBuffer: async () => zip.toBuffer() };
  };
  const catalog = await buildMarketplaceCatalog({ repositoryRoot: root, marketplaceRoot, fetchImpl });
  assert.deepEqual(catalog.entries.map((entry) => entry.skillId), ['demo']);
  assert.equal(catalog.entries[0].version, '2026.08.06');
  assert.equal(requested.length, 1);
  assert.match(requested[0], /codeload\.github\.com/);
});

test('supports a governed GitHub directory source through injected fetch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-github-'));
  const source = {
    sourceId: 'trusted-upstream',
    kind: 'github-directory',
    repository: 'peer/example-skills',
    revision: 'pinned-revision',
    path: 'skills',
    enabled: true,
  };
  const marketplaceRoot = createMarketplace(root, {
    sources: [source],
    reviews: { 'trusted-upstream/demo': { status: 'approved' } },
  });
  const requested = [];
  const skill = Buffer.from('---\nname: demo\ndescription: Demo\nwhenToUse: GitHub test\nversion: 1.0.0\n---\n');
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes('/git/trees/')) {
      return { ok: true, json: async () => ({ truncated: false, tree: [{ type: 'blob', path: 'skills/demo/SKILL.md' }] }) };
    }
    return { ok: true, arrayBuffer: async () => skill };
  };
  const catalog = await buildMarketplaceCatalog({ repositoryRoot: root, marketplaceRoot, fetchImpl });
  assert.equal(catalog.entries[0].source.revision, 'pinned-revision');
  assert.equal(requested.every((url) => !url.includes('anbeime/skill')), true);
});
