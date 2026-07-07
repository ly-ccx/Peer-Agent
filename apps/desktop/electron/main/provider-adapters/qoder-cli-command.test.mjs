import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveQoderCliCommand } from './qoder-cli-command.mjs';

describe('qoder CLI command resolution', () => {
  it('prefers an explicit qodercli path', () => {
    assert.equal(
      resolveQoderCliCommand({
        env: { QODER_CLI_PATH: '/custom/qodercli' },
        exists: () => false,
      }),
      '/custom/qodercli',
    );
  });

  it('falls back to qodercli, not the Qoder desktop command', () => {
    assert.equal(
      resolveQoderCliCommand({
        env: {},
        homeDir: '/home/user',
        exists: () => false,
      }),
      'qodercli',
    );
  });
});
