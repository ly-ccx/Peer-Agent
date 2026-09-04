import { createHash, createPublicKey, verify } from 'node:crypto';
import AdmZip from 'adm-zip';

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function unwrap(value) { return value?.data ?? value; }
function digest(algorithm, value) { return createHash(algorithm).update(value).digest('hex'); }
function safePath(name, { directory = false } = {}) {
  const normalized = name.replaceAll('\\', '/');
  const comparable = directory ? normalized.replace(/\/+$/, '') : normalized;
  return comparable && !comparable.includes('\0') && !comparable.startsWith('/') && !/^[a-zA-Z]:\//.test(comparable)
    && comparable.split('/').every((part) => part !== '.' && part !== '..' && part !== '');
}
function ignoredPath(name) {
  const normalized = name.replaceAll('\\', '/');
  const base = normalized.split('/').at(-1)?.toLowerCase();
  return normalized.includes('__MACOSX/') || base === '_meta.json' || base === '.ds_store'
    || base === 'thumbs.db' || base?.startsWith('._');
}
function unixMode(entry) { return (entry.attr >>> 16) & 0xffff; }

export function computeSkillHubContentHash(entries) {
  const lines = entries
    .filter((entry) => !entry.isDirectory && !ignoredPath(entry.entryName))
    .map((entry) => `${entry.entryName.replaceAll('\\', '/')}:${digest('sha256', entry.getData())}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { contentHash: digest('sha256', `${lines.join('\n')}\n`), fileCount: lines.length };
}

function validateArchive(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0 || zipBuffer.length > MAX_ZIP_BYTES) throw new Error('skillhub_zip_size_invalid');
  let entries;
  try { entries = new AdmZip(zipBuffer).getEntries(); } catch { throw new Error('skillhub_zip_invalid'); }
  const names = new Set();
  let bytes = 0;
  let hasSkill = false;
  for (const entry of entries) {
    const name = entry.entryName.replaceAll('\\', '/');
    if (!safePath(name, { directory: entry.isDirectory })) throw new Error('skillhub_zip_path_unsafe');
    if (names.has(name)) throw new Error('skillhub_zip_duplicate_path');
    names.add(name);
    const mode = unixMode(entry) & 0o170000;
    if (mode === 0o120000) throw new Error('skillhub_zip_symlink_rejected');
    if (!entry.isDirectory) {
      bytes += entry.header?.size ?? entry.getData().length;
      if (name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(name)) hasSkill = true;
    }
  }
  if (entries.filter((entry) => !entry.isDirectory).length > MAX_FILES || bytes > MAX_UNCOMPRESSED_BYTES) throw new Error('skillhub_zip_expansion_limit');
  if (!hasSkill) throw new Error('skillhub_zip_missing_skill');
  return entries;
}

function selectPlatformKey(response, keyId) {
  const value = unwrap(response);
  const keys = Array.isArray(value) ? value : value?.keys;
  const key = keys?.find((candidate) => candidate.key_id === keyId);
  if (!key) throw new Error('skillhub_signature_key_unknown');
  if (key.algorithm !== 'Ed25519' || key.status !== 'active' || key.issuer !== 'skillhub.cn') throw new Error('skillhub_signature_key_untrusted');
  const raw = Buffer.from(key.public_key_raw_b64, 'base64');
  if (raw.length !== 32) throw new Error('skillhub_signature_key_invalid');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function createSkillHubVerifiedInstaller({ apiClient, installSkillFromZip }) {
  if (!apiClient || typeof installSkillFromZip !== 'function') throw new TypeError('installer dependencies are required');
  return Object.freeze({
    async install(identity) {
      const { namespace, slug, version, scope = 'global', workspacePath = null, iconUrl = null } = identity;
      const installScope = scope === 'workspace' ? 'workspace' : 'global';
      const [signatureResponse, keyResponse, zipBuffer] = await Promise.all([
        apiClient.getVersionSignature(identity), apiClient.getPlatformKeys(), apiClient.downloadSkill(identity),
      ]);
      const signature = unwrap(signatureResponse);
      if (signature?.signed !== true || typeof signature.payload !== 'string') throw new Error('skillhub_signature_required');
      const publicKey = selectPlatformKey(keyResponse, signature.key_id);
      const signatureBytes = Buffer.from(signature.signature_b64 ?? signature.signature ?? '', 'base64');
      if (!verify(null, Buffer.from(signature.payload, 'utf8'), publicKey, signatureBytes)) throw new Error('skillhub_signature_invalid');
      let payload;
      try { payload = JSON.parse(signature.payload); } catch { throw new Error('skillhub_signature_payload_invalid'); }
      if (signature.hash_version !== 1 || payload.v !== 1) throw new Error('skillhub_hash_version_unsupported');
      if (payload.issuer !== 'skillhub.cn') throw new Error('skillhub_signature_issuer_invalid');
      if (payload.publisher_user_name !== namespace || payload.skill_slug !== slug || payload.skill_version !== version) throw new Error('skillhub_signature_identity_mismatch');
      if (signature.content_hash && signature.content_hash !== payload.content_hash) throw new Error('skillhub_signature_content_hash_mismatch');
      const entries = validateArchive(zipBuffer);
      if (digest('md5', zipBuffer) !== payload.package_md5) throw new Error('skillhub_package_md5_mismatch');
      const calculated = computeSkillHubContentHash(entries);
      if (calculated.fileCount !== payload.file_count) throw new Error('skillhub_file_count_mismatch');
      if (calculated.contentHash !== payload.content_hash) throw new Error('skillhub_content_hash_mismatch');
      const installed = await installSkillFromZip(zipBuffer, {
        scope: installScope,
        workspacePath: installScope === 'workspace' ? workspacePath : null,
        source: 'skillhub',
        iconUrl: typeof iconUrl === 'string' && iconUrl.trim() ? iconUrl.trim() : null,
        meta: {
          source: 'skillhub',
          namespace,
          slug,
          version,
        },
      });
      if (!installed?.id && !installed?.skillId) throw new Error('skillhub_install_failed');
      return { ok: true, skillId: installed.skillId ?? installed.id, source: 'skillhub', namespace, slug, version, keyId: signature.key_id, scope: installScope };
    },
  });
}
