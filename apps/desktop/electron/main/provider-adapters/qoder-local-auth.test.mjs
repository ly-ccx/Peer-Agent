import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loadQoderLocalAuth,
  resolveQoderConfigDir,
} from './qoder-local-auth.mjs';

describe('qoder local auth', () => {
  it('uses an explicit environment token before reading local auth files', async () => {
    const auth = await loadQoderLocalAuth({
      env: { QODER_ACCESS_TOKEN: 'env-token' },
      homeDir: '/missing-home',
    });

    assert.deepEqual(auth, {
      token: 'env-token',
      source: 'QODER_ACCESS_TOKEN',
      userInfo: null,
    });
  });

  it('resolves Qoder config dir using QODER_CONFIG_DIR first', () => {
    assert.equal(
      resolveQoderConfigDir({
        env: { QODER_CONFIG_DIR: '/tmp/qoder-config', QODER_CLI_HOME: '/tmp/qoder-home' },
        homeDir: '/home/user',
      }),
      '/tmp/qoder-config',
    );
  });

  it('falls back to QODER_CLI_HOME/.qoder', () => {
    assert.equal(
      resolveQoderConfigDir({
        env: { QODER_CLI_HOME: '/tmp/qoder-home' },
        homeDir: '/home/user',
      }),
      '/tmp/qoder-home/.qoder',
    );
  });
});
