import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillMarketplaceService } from './skill-marketplace-service.mjs';

function fixture({ digest, size, downloadUrl = './artifacts/demo.zip' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-service-'));
  const zip = Buffer.from('test-zip');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(root, 'artifacts', 'demo.zip'), zip);
  const entry = {
    catalogId: 'owned/demo', skillId: 'demo', name: 'Demo', description: 'Demo', whenToUse: 'Tests', version: '1',
    category: 'Tests', tags: [], dataLevel: 'D0_public', reviewStatus: 'approved',
    source: { sourceId: 'owned', kind: 'local-directory', path: 'skills/demo' },
    artifact: { downloadUrl, sha256: digest ?? createHash('sha256').update(zip).digest('hex'), size: size ?? zip.length, format: 'zip' },
  };
  writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ schemaVersion: 1, catalogId: 'peer-agent', generatedAt: 'now', entries: [entry] }));
  return { root, zip };
}

test('lists, resolves details, verifies artifact, and delegates to the existing installer', () => {
  const { root, zip } = fixture();
  let installed = null;
  const service = createSkillMarketplaceService({ catalogRoot: root, installSkillFromZip(buffer) { installed = buffer; return { id: 'demo' }; } });
  assert.equal(service.list().entries.length, 1);
  assert.equal(service.getDetail('owned/demo').skillId, 'demo');
  assert.deepEqual(service.install('owned/demo'), { ok: true, skillId: 'demo' });
  assert.deepEqual(installed, zip);
});

test('rejects missing entries, path escapes, checksum mismatch, and installed id mismatch', () => {
  let current = fixture();
  let service = createSkillMarketplaceService({ catalogRoot: current.root, installSkillFromZip: () => ({ id: 'demo' }) });
  assert.deepEqual(service.install('missing'), { ok: false, error: 'skill_marketplace_entry_not_found' });

  current = fixture({ downloadUrl: '../outside.zip' });
  service = createSkillMarketplaceService({ catalogRoot: current.root, installSkillFromZip: () => ({ id: 'demo' }) });
  assert.throws(() => service.install('owned/demo'), /artifact_path_invalid/);

  current = fixture({ digest: '0'.repeat(64) });
  service = createSkillMarketplaceService({ catalogRoot: current.root, installSkillFromZip: () => ({ id: 'demo' }) });
  assert.deepEqual(service.install('owned/demo'), { ok: false, error: 'skill_marketplace_artifact_checksum_mismatch' });

  current = fixture();
  service = createSkillMarketplaceService({ catalogRoot: current.root, installSkillFromZip: () => ({ id: 'other' }) });
  assert.deepEqual(service.install('owned/demo'), { ok: false, error: 'skill_marketplace_installed_skill_mismatch' });
});

test('returns an empty governed catalog when the bundled catalog is absent', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-marketplace-empty-'));
  const service = createSkillMarketplaceService({ catalogRoot: root, installSkillFromZip: () => null });
  assert.deepEqual(service.list().entries, []);
});
