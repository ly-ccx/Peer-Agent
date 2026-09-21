/**
 * macOS Keychain storage for the remote-access device identity.
 *
 * Deals in an opaque single-line string; the crypto lives in the caller. That
 * keeps this module about keychain semantics only (lookup, overwrite, denial).
 *
 * Two constraints were measured against the real `security` CLI, and both shape
 * the contract:
 *   1. `-w` without a value prompts interactively twice and fails headlessly
 *      ("passwords don't match"), so the secret must be passed as an argument.
 *   2. A multi-line value does not survive: writing three lines read back one.
 *      PEM therefore cannot be stored as-is — callers pass single-line base64,
 *      which round-trips exactly (verified).
 *
 * The value is briefly visible in this process's argv. That is not an added
 * privilege: anything able to read argv for this user could already read the
 * login keychain. It does mean the secret should not reach a logger.
 *
 * Fails closed: on a platform without the `security` CLI, or when the keychain
 * refuses, callers get a clear error rather than a plaintext fallback file.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REMOTE_KEYCHAIN = {
  service: 'Peer Agent Remote Access',
  account: 'device-identity',
};

/** Map the CLI's exit codes onto a small vocabulary. Exit codes measured:
 * 44 = item missing (find and delete), 45 = duplicate item (plain add). */
function classify(error, fallback) {
  const code = typeof error?.code === 'number' ? error.code : null;
  const message = typeof error?.stderr === 'string' && error.stderr.trim()
    ? error.stderr.trim()
    : String(error?.message ?? error);
  if (code === 44 || /could not be found/i.test(message)) return 'keychain_item_not_found';
  if (code === 45 || /already exists/i.test(message)) return 'keychain_item_exists';
  if (code === 36 || /not allowed|authorization/i.test(message)) return 'keychain_permission_denied';
  if (code === 128 || /user canceled|cancelled/i.test(message)) return 'keychain_user_cancelled';
  return fallback;
}

/**
 * @param {object} [options]
 * @param {Function} [options.execFileImpl] - host seam for tests
 * @param {string} [options.service]
 * @param {string} [options.account]
 * @param {string} [options.platform]
 */
export function createRemoteIdentityStore({
  execFileImpl = execFileAsync,
  service = REMOTE_KEYCHAIN.service,
  account = REMOTE_KEYCHAIN.account,
  platform = process.platform,
} = {}) {
  if (typeof service !== 'string' || !service) throw new Error('INVALID_SERVICE');
  if (typeof account !== 'string' || !account) throw new Error('INVALID_ACCOUNT');
  const supported = platform === 'darwin';

  /** Read the stored secret, or null when there is none. Any other failure throws. */
  async function loadSecret() {
    if (!supported) return null;
    try {
      const { stdout } = await execFileImpl('security', [
        'find-generic-password', '-w', '-a', account, '-s', service,
      ]);
      const value = String(stdout ?? '').replace(/\r?\n+$/, '');
      return value.length > 0 ? value : null;
    } catch (error) {
      const kind = classify(error, 'keychain_read_failed');
      if (kind === 'keychain_item_not_found') return null;
      throw new Error(kind);
    }
  }

  /** Store the secret, replacing any previous value. `-U` makes this an upsert,
   * so a rotating identity does not need a delete first. */
  async function saveSecret(value) {
    if (typeof value !== 'string' || !value) throw new Error('INVALID_SECRET');
    if (/\r|\n/.test(value)) throw new Error('MULTILINE_SECRET_UNSUPPORTED');
    if (!supported) throw new Error('keychain_unsupported_platform');
    try {
      await execFileImpl('security', [
        'add-generic-password', '-U', '-a', account, '-s', service, '-w', value,
      ]);
    } catch (error) {
      throw new Error(classify(error, 'keychain_write_failed'));
    }
  }

  /** Remove the stored secret. Returns false when there was nothing to remove. */
  async function deleteSecret() {
    if (!supported) return false;
    try {
      await execFileImpl('security', ['delete-generic-password', '-a', account, '-s', service]);
      return true;
    } catch (error) {
      const kind = classify(error, 'keychain_delete_failed');
      if (kind === 'keychain_item_not_found') return false;
      throw new Error(kind);
    }
  }

  return { loadSecret, saveSecret, deleteSecret, isSupported: () => supported, service, account };
}
