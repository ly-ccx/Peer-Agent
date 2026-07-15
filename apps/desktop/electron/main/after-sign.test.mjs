import assert from 'node:assert/strict';
import test from 'node:test';

import afterSignModule from '../../scripts/after-sign.cjs';

const { ensureMacBundleSigned } = afterSignModule;

function createRunner(statuses) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    const status = statuses.shift();
    return {
      status: status ?? 0,
      signal: null,
      error: undefined,
      stdout: null,
      stderr: null,
    };
  };
  return { calls, runner };
}

test('keeps an already valid macOS bundle signature unchanged', () => {
  const { calls, runner } = createRunner([0]);

  const result = ensureMacBundleSigned({
    appPath: '/tmp/Peer Agent.app',
    env: { CSC_LINK: 'developer-id.p12' },
    runner,
  });

  assert.equal(result, 'already-valid');
  assert.deepEqual(calls.map(({ command }) => command), ['codesign']);
});

test('applies and verifies ad-hoc signing when no certificate identity exists', () => {
  const { calls, runner } = createRunner([1, 0, 0, 0, 0]);

  const result = ensureMacBundleSigned({
    appPath: '/tmp/Peer Agent.app',
    env: {},
    runner,
  });

  assert.equal(result, 'ad-hoc-signed');
  assert.deepEqual(calls.map(({ command }) => command), [
    'codesign',
    'codesign',
    'xattr',
    'codesign',
    'codesign',
  ]);
  assert.deepEqual(calls[3].args, [
    '--force',
    '--deep',
    '--sign',
    '-',
    '/tmp/Peer Agent.app',
  ]);
});

test('does not downgrade a failed explicit signing identity to ad-hoc', () => {
  const { calls, runner } = createRunner([1]);

  assert.throws(
    () => ensureMacBundleSigned({
      appPath: '/tmp/Peer Agent.app',
      env: { CSC_NAME: 'Developer ID Application: Peer Agent' },
      runner,
    }),
    /cannot be downgraded to ad-hoc/,
  );
  assert.deepEqual(calls.map(({ command }) => command), ['codesign']);
});

test('does not downgrade an auto-discovered certificate signature to ad-hoc', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('-dv')) {
      return {
        status: 0,
        signal: null,
        error: undefined,
        stdout: '',
        stderr: 'Authority=Developer ID Application: Peer Agent\nTeamIdentifier=PEERTEAM',
      };
    }
    return {
      status: 1,
      signal: null,
      error: undefined,
      stdout: '',
      stderr: '',
    };
  };

  assert.throws(
    () => ensureMacBundleSigned({
      appPath: '/tmp/Peer Agent.app',
      env: {},
      runner,
    }),
    /cannot be downgraded to ad-hoc/,
  );
  assert.deepEqual(calls.map(({ command }) => command), ['codesign', 'codesign']);
});
