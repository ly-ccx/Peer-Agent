import { createHash, randomUUID } from 'node:crypto';
import { statSync, openSync, closeSync, readFileSync, existsSync, realpathSync, linkSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { open as legacyOpen } from 'node:fs/promises';
import path from 'node:path';

const legacyError = code => Object.assign(new Error(code), { code });
const legacyStatToken = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
export function legacyFileToken(file) {
  try { return legacyStatToken(statSync(file, { bigint: true })); }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}
const legacySealFile = directory => path.join(directory, 'coordination-v2', 'legacy-seal.json');
const legacySealDigest = seal => createHash('sha256').update(JSON.stringify(seal)).digest('hex');

/** Small canonical proof; machine-local acceptance belongs only to the derived index. */
export function readLegacySeal(directory, baseline) {
  const file = legacySealFile(directory);
  if (!existsSync(file)) return null;
  if (statSync(file).size > 4096) throw legacyError('coordination_legacy_seal_invalid');
  let seal;
  try { seal = JSON.parse(readFileSync(file, 'utf8')); } catch { throw legacyError('coordination_legacy_seal_invalid'); }
  if (seal?.schemaVersion !== 1 || seal.generation !== baseline.generation || seal.legacyVersion !== baseline.legacyVersion
    || !Number.isSafeInteger(seal.bytes) || seal.bytes < 0 || !/^[a-f0-9]{64}$/.test(seal.sha256 || '')) throw legacyError('coordination_legacy_seal_invalid');
  return { seal, digest: legacySealDigest(seal) };
}

/** Bounded asynchronous I/O, with both descriptor and path checked before/after. */
export async function hashLegacyFile(file, onRead = () => {}) {
  const version = legacyFileToken(file);
  if (version === 'missing') throw legacyError('coordination_legacy_changed');
  const fd = await legacyOpen(file, 'r'), hash = createHash('sha256');
  let bytes = 0;
  try {
    const initial = await fd.stat({ bigint: true });
    if (legacyStatToken(initial) !== version) throw legacyError('coordination_read_changed');
    const buffer = Buffer.alloc(256 * 1024);
    while (bytes < Number(initial.size)) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, Number(initial.size) - bytes), bytes);
      if (!bytesRead) throw legacyError('coordination_read_changed');
      hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead; onRead(bytesRead);
    }
    if (legacyStatToken(await fd.stat({ bigint: true })) !== version || legacyFileToken(file) !== version) throw legacyError('coordination_read_changed');
    return { version, bytes, sha256: hash.digest('hex') };
  } finally { await fd.close(); }
}

function publishLegacySeal(directory, baseline, content, assertOwner) {
  const file = legacySealFile(directory), seal = { schemaVersion: 1, generation: baseline.generation,
    legacyVersion: baseline.legacyVersion, bytes: content.bytes, sha256: content.sha256 };
  const temporary = `${file}.${randomUUID()}.tmp`;
  assertOwner();
  writeFileSync(temporary, JSON.stringify(seal), { flag: 'wx', mode: 0o600 });
  try {
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    assertOwner();
    try { linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST' || readLegacySeal(directory, baseline)?.digest !== legacySealDigest(seal)) throw legacyError('coordination_legacy_seal_conflict');
    }
    const parent = openSync(path.dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    return { seal, digest: legacySealDigest(seal) };
  } finally { unlinkSync(temporary); }
}

/** Only prepare may admit a relocated baseline. A sync read must never hash or repair. */
export async function prepareLegacyIntegrity({ directory, legacyFile, baseline, assertOwner, onRead }) {
  const version = legacyFileToken(legacyFile);
  if (baseline.legacyVersion === 'missing') {
    if (version !== 'missing') throw legacyError('coordination_legacy_changed');
    return null;
  }
  let proof = readLegacySeal(directory, baseline);
  if (version === baseline.legacyVersion && proof) return null;
  if (!proof && version !== baseline.legacyVersion) throw legacyError('coordination_legacy_changed');
  const content = await hashLegacyFile(legacyFile, onRead);
  assertOwner();
  if (proof && (content.bytes !== proof.seal.bytes || content.sha256 !== proof.seal.sha256)) throw legacyError('coordination_legacy_changed');
  if (!proof) proof = publishLegacySeal(directory, baseline, content, () => {
    assertOwner(); if (legacyFileToken(legacyFile) !== content.version) throw legacyError('coordination_read_changed');
  });
  return { version: content.version, sealDigest: proof.digest };
}

/** Validate the explicit prepare -> worker/cache receipt without scanning the journal. */
export function acceptsLegacyIntegrity(directory, legacyFile, baseline, receipt) {
  const version = legacyFileToken(legacyFile);
  if (version === baseline.legacyVersion) return true;
  if (!receipt || receipt.version !== version || baseline.legacyVersion === 'missing') return false;
  return readLegacySeal(directory, baseline)?.digest === receipt.sealDigest;
}

const legacyWithin = (root, file) => file === root || file.startsWith(root + path.sep);
function legacyContained(root, file) {
  if (!legacyWithin(root, realpathSync(file))) throw legacyError('coordination_backup_path_invalid');
}
function readLegacyBaseline(directory) {
  const dir = path.join(directory, 'coordination-v2');
  for (const name of ['manifest.json', 'head.json']) legacyContained(directory, path.join(dir, name));
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const head = JSON.parse(readFileSync(path.join(dir, 'head.json'), 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.minimumReaderVersion !== 2 || manifest.minimumWriterVersion !== 2
    || typeof manifest.generation !== 'string' || !manifest.generation || manifest.legacyFile !== 'coordination.jsonl'
    || typeof manifest.legacyVersion !== 'string' || !manifest.legacyVersion
    || head.generation !== manifest.generation || head.legacyVersion !== manifest.legacyVersion) throw legacyError('coordination_legacy_seal_invalid');
  return { generation: manifest.generation, legacyVersion: manifest.legacyVersion };
}

/** Source-assisted transition for pre-seal backups. Never writes or leases the source.
 * The caller owns an offline backup; an extant lease (even stale) is rejected.
 * This is storage maintenance, not a model-visible execution capability.
 */
export async function sealCoordinationBackup({ sourceDirectory, backupDirectory }) {
  const source = realpathSync(sourceDirectory), backup = realpathSync(backupDirectory);
  if (legacyWithin(source, backup) || legacyWithin(backup, source)) throw legacyError('coordination_backup_path_invalid');
  const sourceFile = path.join(source, 'coordination.jsonl'), backupFile = path.join(backup, 'coordination.jsonl');
  const assertOffline = () => {
    if (existsSync(path.join(backup, 'host.lease'))) throw legacyError('coordination_backup_active');
    for (const file of [backupFile, path.join(backup, 'coordination-v2')]) legacyContained(backup, file);
    for (const name of ['manifest.json', 'head.json', 'legacy-seal.json']) {
      const file = path.join(backup, 'coordination-v2', name); if (existsSync(file)) legacyContained(backup, file);
    }
  };
  assertOffline(); legacyContained(source, sourceFile);
  if (existsSync(legacySealFile(source))) legacyContained(source, legacySealFile(source));
  const baseline = readLegacyBaseline(source), target = readLegacyBaseline(backup);
  if (JSON.stringify(target) !== JSON.stringify(baseline)) throw legacyError('coordination_legacy_seal_invalid');
  if (legacyFileToken(sourceFile).split(':').slice(0, 2).join(':') === legacyFileToken(backupFile).split(':').slice(0, 2).join(':')) throw legacyError('coordination_backup_path_invalid');
  const existing = readLegacySeal(source, baseline);
  if (!existing && legacyFileToken(sourceFile) !== baseline.legacyVersion) throw legacyError('coordination_legacy_changed');
  const original = await hashLegacyFile(sourceFile), copied = await hashLegacyFile(backupFile);
  if (original.bytes !== copied.bytes || original.sha256 !== copied.sha256
    || existing && (original.bytes !== existing.seal.bytes || original.sha256 !== existing.seal.sha256)) throw legacyError('coordination_legacy_changed');
  const proof = publishLegacySeal(backup, baseline, copied, () => {
    assertOffline();
    if (legacyFileToken(sourceFile) !== original.version || legacyFileToken(backupFile) !== copied.version) throw legacyError('coordination_read_changed');
    if (JSON.stringify(readLegacyBaseline(source)) !== JSON.stringify(baseline) || JSON.stringify(readLegacyBaseline(backup)) !== JSON.stringify(baseline)) throw legacyError('coordination_read_changed');
  });
  return proof.seal;
}
