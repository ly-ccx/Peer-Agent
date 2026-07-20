import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchOfficialQoderModelCatalog } from './qoder-official-model-catalog.mjs';

describe('official Qoder model catalog', () => {
  it('uses an idle SDK control session and closes it after fetching models', async () => {
    let invocation = null;
    let initialized = false;
    let closed = false;
    const expected = [{ value: 'auto', displayName: 'Auto' }];

    const result = await fetchOfficialQoderModelCatalog({
      env: { PATH: '/test/bin' },
      homeDir: '/tmp/qoder-home',
      qoderCatalogTimeoutMs: 1_000,
      resolveQoderCliBinary: async () => '/test/bin/qodercli',
      qoderCatalogQueryFactory(params) {
        invocation = params;
        return {
          async initializationResult() {
            initialized = true;
            return {};
          },
          async getAvailableModels(options) {
            assert.equal(initialized, true);
            assert.deepEqual(options, { fetchStrategy: 'live' });
            return expected;
          },
          async close() {
            closed = true;
          },
        };
      },
    });

    assert.deepEqual(result, expected);
    assert.equal(closed, true);
    assert.equal(invocation.options.auth.type, 'qodercli');
    assert.equal(invocation.options.pathToQoderCLIExecutable, '/test/bin/qodercli');
    assert.equal(invocation.options.permissionMode, 'dont_ask');
    assert.deepEqual(invocation.options.tools, []);
    assert.equal(invocation.options.env.PATH, '/test/bin');
    assert.equal(invocation.options.env.HOME, '/tmp/qoder-home');
    assert.equal(invocation.options.env.QODER_CLI_HOME, '/tmp/qoder-home');
    assert.equal(invocation.options.env.QODER_CONFIG_DIR, '/tmp/qoder-home/.qoder');

    const promptIterator = invocation.prompt[Symbol.asyncIterator]();
    assert.deepEqual(await promptIterator.next(), { value: undefined, done: true });
  });

  it('closes the SDK session and classifies SDK failures', async () => {
    let closed = false;
    await assert.rejects(
      fetchOfficialQoderModelCatalog({
        env: {},
        homeDir: '/tmp/qoder-home',
        resolveQoderCliBinary: async () => '/test/bin/qodercli',
        qoderCatalogQueryFactory() {
          return {
            async initializationResult() {
              return {};
            },
            async getAvailableModels() {
              throw new Error('protocol failed');
            },
            async close() {
              closed = true;
            },
          };
        },
      }),
      (error) => error?.code === 'qoder_official_models_unavailable',
    );
    assert.equal(closed, true);
  });

  it('fails before creating a session when qodercli is unavailable', async () => {
    let queryCreated = false;
    await assert.rejects(
      fetchOfficialQoderModelCatalog({
        env: {},
        homeDir: '/tmp/qoder-home',
        resolveQoderCliBinary: async () => null,
        qoderCatalogQueryFactory() {
          queryCreated = true;
        },
      }),
      (error) => error?.code === 'qoder_cli_not_found',
    );
    assert.equal(queryCreated, false);
  });

  it('rejects an empty official catalog and still closes the session', async () => {
    let closed = false;
    await assert.rejects(
      fetchOfficialQoderModelCatalog({
        env: {},
        homeDir: '/tmp/qoder-home',
        resolveQoderCliBinary: async () => '/test/bin/qodercli',
        qoderCatalogQueryFactory() {
          return {
            async initializationResult() {
              return {};
            },
            async getAvailableModels() {
              return [];
            },
            async close() {
              closed = true;
            },
          };
        },
      }),
      (error) => error?.code === 'qoder_official_models_empty',
    );
    assert.equal(closed, true);
  });

  it('aborts and closes a catalog session that exceeds its timeout', async () => {
    let closed = false;
    await assert.rejects(
      fetchOfficialQoderModelCatalog({
        env: {},
        homeDir: '/tmp/qoder-home',
        qoderCatalogTimeoutMs: 10,
        resolveQoderCliBinary: async () => '/test/bin/qodercli',
        qoderCatalogQueryFactory({ options }) {
          return {
            initializationResult() {
              return new Promise((resolve, reject) => {
                options.abortController.signal.addEventListener('abort', () => {
                  reject(new Error('aborted'));
                }, { once: true });
              });
            },
            async getAvailableModels() {
              return [{ value: 'auto', displayName: 'Auto' }];
            },
            async close() {
              closed = true;
            },
          };
        },
      }),
      (error) => error?.code === 'qoder_official_models_timeout',
    );
    assert.equal(closed, true);
  });
});
