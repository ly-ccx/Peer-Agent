/**
 * Chrome / Chromium macOS Cookie 解密（os_crypt）。
 *
 * 现代 macOS Chrome：
 *   encrypted_value = b"v10" | AES-128-CBC(key, iv=16x0x20, plaintext)
 *   key = PBKDF2-HMAC-SHA1(password=Keychain "Chrome Safe Storage", salt="saltysalt", iter=1003, dkLen=16)
 *
 * 本模块只做密码→密钥→解密；Keychain 读取在 chrome-keychain.mjs。
 * 测试可注入 password / key，避免依赖本机钥匙串。
 */

import crypto from 'node:crypto';

const V10_PREFIX = Buffer.from('v10');
const V11_PREFIX = Buffer.from('v11');
const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, ' ');

export function deriveChromeAesKey(password) {
  return crypto.pbkdf2Sync(String(password), SALT, ITERATIONS, KEY_LEN, 'sha1');
}

/**
 * 解密 Chrome Cookie encrypted_value。
 * @param {Buffer|Uint8Array} encryptedValue
 * @param {{ password?: string, key?: Buffer }} secrets
 * @returns {string}
 */
export function decryptChromeCookieValue(encryptedValue, secrets = {}) {
  const buf = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue || []);
  if (buf.length === 0) return '';

  // 明文历史路径（极少见）
  if (
    !buf.subarray(0, 3).equals(V10_PREFIX) &&
    !buf.subarray(0, 3).equals(V11_PREFIX)
  ) {
    // 尝试按 utf8 返回非空可打印内容，否则失败
    const asText = buf.toString('utf8');
    if (asText && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(asText)) {
      return asText;
    }
    throw new Error('unsupported_cookie_cipher');
  }

  const key =
    secrets.key ||
    (secrets.password != null ? deriveChromeAesKey(secrets.password) : null);
  if (!key) throw new Error('missing_decrypt_key');

  const data = buf.subarray(3);
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error('invalid_cipher_length');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    throw new Error('decrypt_failed');
  }
}

/** 测试/fixture 用：用同一算法加密。 */
export function encryptChromeCookieValueForTests(plaintext, password) {
  const key = deriveChromeAesKey(password);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([
    V10_PREFIX,
    cipher.update(Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
  ]);
}
