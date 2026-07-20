import os from 'node:os';

import { qodercliAuth, query } from '@qoder-ai/qoder-agent-sdk';

import { resolveQoderCliBinary, resolveQoderConfigDir } from './qoder-local-auth.mjs';

const DEFAULT_CATALOG_TIMEOUT_MS = 12_000;

function createCatalogError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function catalogTimeoutMs(value) {
  return Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_CATALOG_TIMEOUT_MS;
}

function catalogEnvironment(options = {}) {
  const source = options.env === undefined ? process.env : options.env;
  const homeDir = options.homeDir || os.homedir();
  return {
    ...source,
    HOME: source.HOME || homeDir,
    QODER_CLI_HOME: source.QODER_CLI_HOME || homeDir,
    QODER_CONFIG_DIR: resolveQoderConfigDir(options),
  };
}

// The SDK needs an input stream to establish its bidirectional control session.
// Keep it idle so catalog discovery never sends a user prompt or consumes a turn.
function idlePrompt() {
  let released = false;
  let resolveWait = null;
  return {
    stream: (async function* () {
      if (!released) {
        await new Promise((resolve) => {
          resolveWait = resolve;
          if (released) resolve();
        });
      }
    }()),
    release() {
      released = true;
      resolveWait?.();
    },
  };
}

/**
 * Fetch the account catalog through Qoder's public SDK control contract.
 * The caller may inject the resolver/query factory for deterministic tests.
 */
export async function fetchOfficialQoderModelCatalog(options = {}) {
  const resolveCli = options.resolveQoderCliBinary ?? resolveQoderCliBinary;
  const cliPath = options.qoderCliPath || await resolveCli(options);
  if (!cliPath) throw createCatalogError('qoder_cli_not_found');

  const timeoutMs = catalogTimeoutMs(options.qoderCatalogTimeoutMs);
  const abortController = new AbortController();
  const prompt = idlePrompt();
  const queryFactory = options.qoderCatalogQueryFactory ?? query;
  let timedOut = false;
  let session = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  try {
    session = queryFactory({
      prompt: prompt.stream,
      options: {
        auth: qodercliAuth(),
        abortController,
        pathToQoderCLIExecutable: cliPath,
        cwd: options.cwd || options.homeDir || os.homedir(),
        env: catalogEnvironment(options),
        tools: [],
        permissionMode: 'dont_ask',
        controlRequestTimeoutMs: timeoutMs,
        closeGraceMs: 250,
        stderr: () => {},
      },
    });
    await session.initializationResult();
    const models = await session.getAvailableModels({ fetchStrategy: 'live' });
    if (!Array.isArray(models) || models.length === 0) {
      throw createCatalogError('qoder_official_models_empty');
    }
    return models;
  } catch (error) {
    if (error?.code === 'qoder_cli_not_found' || error?.code === 'qoder_official_models_empty') {
      throw error;
    }
    throw createCatalogError(
      timedOut ? 'qoder_official_models_timeout' : 'qoder_official_models_unavailable',
      error,
    );
  } finally {
    clearTimeout(timeout);
    prompt.release();
    try {
      await session?.close?.();
    } catch {}
  }
}
