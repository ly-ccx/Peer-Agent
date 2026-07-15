import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CredentialHelperClient,
  CredentialHelperError,
  createSubprocessCredentialTransport,
  modelApiKeyCredentialKey,
  modelOauthCredentialKey,
  resolveCredentialHelperPath,
  type CredentialHelperRequest,
  type CredentialHelperTransport,
} from './index.ts';

class MemoryTransport implements CredentialHelperTransport {
  readonly requests: CredentialHelperRequest[] = [];
  readonly secrets = new Map<string, string>();

  invoke(request: CredentialHelperRequest) {
    this.requests.push(request);
    if (request.action === 'ping') {
      return { version: 1 as const, ok: true, data: { status: 'ready', platform: 'test' } };
    }
    if (request.action === 'get') {
      return { version: 1 as const, ok: true, data: { secret: this.secrets.get(request.key) ?? null } };
    }
    if (request.action === 'set') {
      this.secrets.set(request.key, request.secret);
      return { version: 1 as const, ok: true, data: { stored: true } };
    }
    const deleted = this.secrets.delete(request.key);
    return { version: 1 as const, ok: true, data: { deleted } };
  }
}

test('client stores, retrieves and deletes scoped model secrets', () => {
  const transport = new MemoryTransport();
  const client = new CredentialHelperClient(transport);
  const key = modelApiKeyCredentialKey('openai');

  client.setSecret(key, 'sk-test');
  assert.equal(client.getSecret(key), 'sk-test');
  assert.equal(client.deleteSecret(key), true);
  assert.equal(client.getSecret(key), null);
  assert.deepEqual(client.ping(), { status: 'ready', platform: 'test' });
  assert.equal(modelOauthCredentialKey('chatgpt'), 'model/chatgpt/oauth-tokens');
});

test('rejects invalid credential keys and empty secrets before transport', () => {
  const transport = new MemoryTransport();
  const client = new CredentialHelperClient(transport);

  assert.throws(
    () => client.getSecret('../../etc/passwd'),
    (error: unknown) => error instanceof CredentialHelperError
      && error.code === 'credential_key_invalid',
  );
  assert.throws(
    () => client.setSecret(modelApiKeyCredentialKey('openai'), ''),
    (error: unknown) => error instanceof CredentialHelperError
      && error.code === 'credential_secret_invalid',
  );
  assert.equal(transport.requests.length, 0);
});

test('resolves explicit, packaged and development helper locations', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-credential-client-'));
  const explicit = path.join(directory, 'explicit-helper');
  const packaged = path.join(directory, 'resources', 'bin', 'peer-credential-helper');
  const development = path.join(directory, 'target', 'debug', 'peer-credential-helper');
  mkdirSync(path.dirname(packaged), { recursive: true });
  mkdirSync(path.dirname(development), { recursive: true });
  for (const file of [explicit, packaged, development]) {
    writeFileSync(file, '');
  }

  assert.equal(resolveCredentialHelperPath({ explicitPath: explicit }), explicit);
  assert.equal(resolveCredentialHelperPath({
    resourcesPath: path.join(directory, 'resources'),
  }), packaged);
  assert.equal(resolveCredentialHelperPath({ repositoryRoot: directory }), development);
});

test('subprocess transport sends secrets only in stdin', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-credential-transport-'));
  const helper = path.join(directory, 'peer-credential-helper');
  writeFileSync(helper, '');
  let command = '';
  let args: readonly string[] = [];
  let input = '';
  let environment: NodeJS.ProcessEnv | undefined;

  const transport = createSubprocessCredentialTransport({
    explicitPath: helper,
    dataHome: path.join(directory, 'data'),
    runner(nextCommand, nextArgs, options) {
      command = nextCommand;
      args = nextArgs;
      assert.ok(options);
      input = Buffer.isBuffer(options.input)
        ? options.input.toString('utf8')
        : String(options.input ?? '');
      environment = options.env;
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from('{"version":1,"ok":true,"data":{"stored":true}}'),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        error: undefined,
      };
    },
  });
  new CredentialHelperClient(transport).setSecret(
    modelApiKeyCredentialKey('openai'),
    'sk-only-in-stdin',
  );

  assert.equal(command, helper);
  assert.deepEqual(args, []);
  assert.match(input, /sk-only-in-stdin/);
  assert.doesNotMatch(JSON.stringify(args), /sk-only-in-stdin/);
  assert.doesNotMatch(JSON.stringify(environment), /sk-only-in-stdin/);
  assert.equal(environment?.PEER_AGENT_HOME, path.join(directory, 'data'));
});

test('surfaces stable helper errors and rejects malformed responses', () => {
  const client = new CredentialHelperClient({
    invoke() {
      throw new CredentialHelperError('secure_storage_unavailable', 'not available');
    },
  });
  assert.throws(
    () => client.getSecret(modelApiKeyCredentialKey('openai')),
    (error: unknown) => error instanceof CredentialHelperError
      && error.code === 'secure_storage_unavailable',
  );

  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-credential-response-'));
  const helper = path.join(directory, 'peer-credential-helper');
  writeFileSync(helper, '');
  const malformed = createSubprocessCredentialTransport({
    explicitPath: helper,
    runner() {
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from('not-json'),
        stderr: Buffer.alloc(0),
        status: 1,
        signal: null,
        error: undefined,
      };
    },
  });
  assert.throws(
    () => new CredentialHelperClient(malformed).ping(),
    (error: unknown) => error instanceof CredentialHelperError
      && error.code === 'credential_helper_response_invalid',
  );
});

test('bounds each helper subprocess and reports timeout as a stable error', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-credential-timeout-'));
  const helper = path.join(directory, 'peer-credential-helper');
  writeFileSync(helper, '');
  let timeout: number | undefined;
  let maxBuffer: number | undefined;
  let windowsHide: boolean | undefined;

  const transport = createSubprocessCredentialTransport({
    explicitPath: helper,
    timeoutMs: 25,
    maxBufferBytes: 4096,
    runner(_command, _args, options) {
      timeout = options?.timeout;
      maxBuffer = options?.maxBuffer;
      windowsHide = options?.windowsHide;
      return {
        pid: 1,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      };
    },
  });

  assert.throws(
    () => new CredentialHelperClient(transport).ping(),
    (error: unknown) => error instanceof CredentialHelperError
      && error.code === 'credential_helper_timeout',
  );
  assert.equal(timeout, 25);
  assert.equal(maxBuffer, 4096);
  assert.equal(windowsHide, true);
});
