import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { hashLegacyFile, legacyFileToken, readLegacySeal } from './coordination-legacy-integrity.mjs';

const fail = code => Object.assign(new Error(code), { code });
function sync(file) { const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durable(file, bytes) {
  const tmp = `${file}.${randomUUID()}.tmp`; writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
  sync(tmp); renameSync(tmp, file); sync(path.dirname(file));
}
function inside(directory, relative) {
  let file = directory;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw fail('coordination_fence_invalid');
    file = path.join(file, part);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw fail('coordination_fence_invalid');
  }
  return file;
}
/** Lease-owned healthy v2 promotion. No task events, execution or synthesized recovery receipts. */
export async function protectCoordinationWriter({ directory, assertOwner, onStep = () => {} }) {
  directory = realpathSync(directory); assertOwner();
  const dir = inside(directory, 'coordination-v2'), marker = path.join(directory, 'coordination-fence.json');
  const manifestFile = path.join(dir, 'manifest.json'), headFile = path.join(dir, 'head.json');
  if (!existsSync(manifestFile)) return false;
  let intent;
  if (existsSync(marker)) {
    inside(directory, 'coordination-fence.json'); intent = JSON.parse(readFileSync(marker));
    if (intent.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(intent.id) || intent.archive !== `.coordination-fence/${intent.id}`) throw fail('coordination_fence_invalid');
    if (intent.status === 'complete') return false;
  } else {
    const manifest = JSON.parse(readFileSync(manifestFile));
    if (manifest.minimumReaderVersion === 3) return false;
    const head = JSON.parse(readFileSync(headFile)), legacy = inside(directory, 'coordination.jsonl');
    if (manifest.minimumReaderVersion !== 2 || manifest.minimumWriterVersion !== 2 || head.generation !== manifest.generation
      || head.legacyVersion !== manifest.legacyVersion || legacyFileToken(legacy) !== manifest.legacyVersion) throw fail('coordination_legacy_changed');
    const original = manifest.legacyVersion === 'missing'
      ? { version: 'missing', bytes: 0, sha256: createHash('sha256').update('').digest('hex') } : await hashLegacyFile(legacy);
    const proof = readLegacySeal(directory, manifest);
    if (proof && (proof.seal.sha256 !== original.sha256 || proof.seal.bytes !== original.bytes)) throw fail('coordination_legacy_changed');
    assertOwner(); if (legacyFileToken(legacy) !== original.version) throw fail('coordination_read_changed');
    const id = randomUUID(), archive = `.coordination-fence/${id}`, saved = inside(directory, archive);
    mkdirSync(saved, { recursive: true, mode: 0o700 });
    for (const name of ['manifest.json', 'head.json', 'legacy-seal.json']) if (existsSync(path.join(dir, name))) {
      copyFileSync(path.join(dir, name), path.join(saved, name)); sync(path.join(saved, name));
    }
    intent = { schemaVersion: 1, id, archive, status: 'prepared', original, manifest, head };
    durable(marker, JSON.stringify(intent)); onStep('prepared');
  }
  if (!intent.frozen) {
    const legacy = inside(directory, 'coordination.jsonl'), baseline = inside(directory, 'coordination-v2/baseline.jsonl');
    assertOwner(); if (legacyFileToken(legacy) !== intent.original.version) throw fail('coordination_read_changed');
    if (!existsSync(baseline)) {
      const temporary = baseline + '.' + randomUUID() + '.tmp';
      if (intent.original.version === 'missing') writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' });
      else copyFileSync(legacy, temporary);
      sync(temporary); renameSync(temporary, baseline); sync(dir);
    }
    const frozen = await hashLegacyFile(baseline);
    if (frozen.sha256 !== intent.original.sha256 || frozen.bytes !== intent.original.bytes) throw fail('coordination_read_changed');
    intent = { ...intent, frozen }; durable(marker, JSON.stringify(intent)); onStep('baseline-copied');
  }
  const saved = inside(directory, intent.archive), legacy = inside(directory, 'coordination.jsonl');
  const baseline = inside(directory, 'coordination-v2/baseline.jsonl'), moved = path.join(saved, 'coordination.jsonl');
  const content = await hashLegacyFile(baseline);
  if (content.version !== intent.frozen.version || content.sha256 !== intent.original.sha256 || content.bytes !== intent.original.bytes) throw fail('coordination_read_changed');
  assertOwner();
  if (intent.original.version === 'missing') {
    if (existsSync(legacy) && !lstatSync(legacy).isDirectory()) throw fail('coordination_read_changed');
  } else {
    if (!existsSync(moved)) {
      if (legacyFileToken(legacy) !== intent.original.version) throw fail('coordination_read_changed');
      renameSync(legacy, moved); sync(saved); onStep('legacy-archived');
    }
    const old = await hashLegacyFile(moved);
    if (old.sha256 !== intent.original.sha256 || old.bytes !== intent.original.bytes) throw fail('coordination_read_changed');
  }
  assertOwner();
  if (!existsSync(legacy)) mkdirSync(legacy, { mode: 0o700 });
  if (!lstatSync(legacy).isDirectory()) throw fail('coordination_writer_fence_missing');
  sync(directory); onStep('writer-fenced'); assertOwner();
  const { generation } = intent.manifest, legacyVersion = content.version;
  durable(path.join(dir, 'legacy-seal.json'), JSON.stringify({ schemaVersion: 1, generation, legacyVersion, bytes: content.bytes, sha256: content.sha256 }));
  durable(headFile, JSON.stringify({ ...intent.head, legacyVersion })); onStep('head-published'); assertOwner();
  durable(manifestFile, JSON.stringify({ ...intent.manifest, legacyVersion, minimumReaderVersion: 3, minimumWriterVersion: 3, frozenLegacyFile: 'baseline.jsonl' }));
  onStep('published'); durable(marker, JSON.stringify({ ...intent, status: 'complete' }));
  return true;
}
