import assert from 'node:assert/strict';
import test from 'node:test';
import { createPasswordVaultFillApplicationService } from './password-vault-fill-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const sentInput = [];
  let scriptIndex = 0;
  const scriptResults = overrides.scriptResults || [
    { ok: true, hasUsername: true, origin: 'https://example.com' },
    true,
    true,
    true,
    true,
    true,
  ];
  const webContents = overrides.webContents || {
    isDestroyed: () => false,
    async executeJavaScript(source, userGesture) {
      calls.push(['execute', source, userGesture]);
      const result = scriptResults[scriptIndex];
      scriptIndex += 1;
      if (result instanceof Error) throw result;
      return result;
    },
    sendInputEvent(event) {
      sentInput.push(event);
      calls.push(['input', event]);
    },
  };
  const service = createPasswordVaultFillApplicationService({
    revealPassword: (id) => {
      calls.push(['reveal', id]);
      return {
        ok: true,
        id: id || 'entry-1',
        origin: 'https://vault.example',
        username: 'alice',
        password: 's3cr3t',
      };
    },
    getWebContents: (id) => {
      calls.push(['get-web-contents', id]);
      return webContents;
    },
    ...overrides.ports,
  });
  return { service, calls, sentInput, webContents };
}

function typedText(events) {
  return events.map(({ keyCode }) => keyCode).join('');
}

test('fill returns reveal failures before resolving a WebContents target', async () => {
  const revealedFailure = { ok: false, error: 'vault_locked' };
  const { service, calls } = createHarness({
    ports: {
      revealPassword: (id) => {
        calls.push(['reveal', id]);
        return revealedFailure;
      },
    },
  });

  assert.equal(await service.fill({ id: 'entry-1', webContentsId: 7 }), revealedFailure);
  assert.deepEqual(calls, [['reveal', 'entry-1']]);
});

test('fill validates WebContents ids after reveal and rejects unavailable targets', async () => {
  const invalid = createHarness();
  assert.deepEqual(await invalid.service.fill({ id: 'entry-1', webContentsId: 'nope' }), {
    ok: false,
    error: 'invalid_web_contents_id',
  });
  assert.deepEqual(invalid.calls, [['reveal', 'entry-1']]);

  const missing = createHarness({
    ports: { getWebContents: () => null },
  });
  assert.deepEqual(await missing.service.fill({ id: 'entry-1', webContentsId: 8 }), {
    ok: false,
    error: 'browser_unavailable',
  });

  const destroyed = createHarness({
    webContents: { isDestroyed: () => true },
  });
  assert.deepEqual(await destroyed.service.fill({ id: 'entry-1', webContentsId: 9 }), {
    ok: false,
    error: 'browser_unavailable',
  });
});

test('fill returns the page field-discovery failure without sending password input', async () => {
  const { service, sentInput } = createHarness({
    scriptResults: [{ ok: false, reason: 'no_password_field' }],
  });

  assert.deepEqual(await service.fill({ id: 'entry-1', webContentsId: 7 }), {
    ok: false,
    error: 'no_password_field',
  });
  assert.deepEqual(sentInput, []);
});

test('fill types username then password through native input and returns redacted metadata', async () => {
  const { service, calls, sentInput } = createHarness();

  const result = await service.fill({ id: 'entry-1', webContentsId: '17' });

  assert.deepEqual(result, {
    ok: true,
    id: 'entry-1',
    origin: 'https://vault.example',
    filledUsername: true,
    pageOrigin: 'https://example.com',
  });
  assert.equal('username' in result, false);
  assert.equal('password' in result, false);
  assert.equal(typedText(sentInput), 'alices3cr3t');
  assert.deepEqual(sentInput[0], { type: 'char', keyCode: 'a' });
  assert.equal(calls[0][0], 'reveal');
  assert.deepEqual(calls[1], ['get-web-contents', 17]);

  const scripts = calls.filter(([name]) => name === 'execute').map(([, source]) => source);
  assert.equal(scripts.length, 6);
  assert.match(scripts[0], /input\[type="password"\]/);
  assert.match(scripts[0], /data-peer-pw-fill/);
  assert.match(scripts[1], /data-peer-pw-fill=\\?"username/);
  assert.match(scripts[3], /data-peer-pw-fill=\\?"password/);
  assert.match(scripts[5], /removeAttribute\('data-peer-pw-fill'\)/);
});

test('fill can skip username while preserving password and response semantics', async () => {
  const { service, sentInput } = createHarness();

  const result = await service.fill({
    id: 'entry-1',
    webContentsId: 17,
    fillUsername: false,
  });

  assert.equal(typedText(sentInput), 's3cr3t');
  assert.equal(result.ok, true);
  assert.equal(result.filledUsername, false);
});

test('fill does not type an absent username even when requested', async () => {
  const { service, sentInput } = createHarness({
    scriptResults: [
      { ok: true, hasUsername: false, origin: 'https://example.com' },
      true,
      true,
      true,
    ],
  });

  const result = await service.fill({ id: 'entry-1', webContentsId: 17 });

  assert.equal(typedText(sentInput), 's3cr3t');
  assert.equal(result.filledUsername, false);
});

test('fill maps host failures without exposing credentials', async () => {
  const { service } = createHarness({
    scriptResults: [new Error('page execution failed')],
  });

  const result = await service.fill({ id: 'entry-1', webContentsId: 17 });
  assert.deepEqual(result, { ok: false, error: 'page execution failed' });
  assert.equal(JSON.stringify(result).includes('s3cr3t'), false);
});

test('fill service fails fast when a required port is absent', () => {
  assert.throws(
    () => createPasswordVaultFillApplicationService(),
    /revealPassword must be a function/,
  );
});
