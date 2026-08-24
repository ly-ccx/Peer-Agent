import assert from 'node:assert/strict';
import test from 'node:test';

import { effectiveFastMode, supportsFastMode } from './fast-mode.ts';

test('Fast mode is admitted only for ChatGPT and Grok OAuth', () => {
  assert.equal(supportsFastMode('oauth_chatgpt'), true);
  assert.equal(supportsFastMode('oauth_grok'), true);
  assert.equal(supportsFastMode('api_key'), false);
  assert.equal(supportsFastMode('oauth_google'), false);
  assert.equal(supportsFastMode('qoder_local_auth'), false);
  assert.equal(supportsFastMode(null), false);
  assert.equal(supportsFastMode(undefined), false);
});

test('effective Fast mode is the admission × session-flag cross', () => {
  const cases = [
    { auth: 'oauth_chatgpt', flag: true, expected: true },
    { auth: 'oauth_chatgpt', flag: false, expected: false },
    { auth: 'oauth_grok', flag: true, expected: true },
    { auth: 'oauth_grok', flag: false, expected: false },
    { auth: 'api_key', flag: true, expected: false },
    { auth: 'oauth_google', flag: true, expected: false },
  ] as const;

  for (const item of cases) {
    assert.equal(
      effectiveFastMode(item.auth, item.flag),
      item.expected,
      `${item.auth} × fast=${item.flag}`,
    );
  }
});
