/**
 * 读取 macOS Keychain 中 Chrome / Chromium 的 Safe Storage 密码。
 * 可注入 execFile 便于测试；失败关闭，不回退明文默认密钥。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 已知浏览器的 Keychain 服务名（account 通常为浏览器名）。 */
export const CHROME_KEYCHAIN_SERVICES = {
  chrome: {
    service: 'Chrome Safe Storage',
    account: 'Chrome',
  },
  chromium: {
    service: 'Chromium Safe Storage',
    account: 'Chromium',
  },
  edge: {
    service: 'Microsoft Edge Safe Storage',
    account: 'Microsoft Edge',
  },
  brave: {
    service: 'Brave Safe Storage',
    account: 'Brave',
  },
};

/**
 * @param {{ browserId?: string, service?: string, account?: string, execFileImpl?: typeof execFileAsync }} options
 * @returns {Promise<string>}
 */
export async function readChromeSafeStoragePassword(options = {}) {
  const browserId = options.browserId || 'chrome';
  const preset = CHROME_KEYCHAIN_SERVICES[browserId] || CHROME_KEYCHAIN_SERVICES.chrome;
  const service = options.service || preset.service;
  const account = options.account || preset.account;
  const run = options.execFileImpl || execFileAsync;

  try {
    const { stdout } = await run(
      'security',
      ['find-generic-password', '-w', '-a', account, '-s', service],
      { encoding: 'utf8', timeout: 15_000 },
    );
    const password = String(stdout || '').replace(/\r?\n$/, '');
    if (!password) throw new Error('keychain_empty');
    return password;
  } catch (err) {
    const code = err?.code;
    const msg = String(err?.stderr || err?.message || '');
    if (code === 44 || /could not be found/i.test(msg)) {
      throw new Error('keychain_item_not_found');
    }
    if (code === 36 || /user interaction is not allowed|authorization/i.test(msg)) {
      throw new Error('keychain_permission_denied');
    }
    if (code === 128 || /user canceled|cancelled/i.test(msg)) {
      throw new Error('keychain_user_cancelled');
    }
    throw new Error('keychain_read_failed');
  }
}
