import { parentPort, workerData } from 'node:worker_threads';
import { createLlmConfigStore } from '../llm-config-store.mjs';
import { createDesktopModelCredentialClient } from '../model-credential-client.mjs';
import { resolveProviderCredential } from '../provider-credential-resolver.mjs';

try {
  const llmConfigStore = createLlmConfigStore({ configFile: workerData.configFile,
    credentialClient: createDesktopModelCredentialClient({ dataHome: workerData.dataHome, timeoutMs: 1000 }) });
  const value = await resolveProviderCredential({ provider: workerData.provider, llmConfigStore });
  parentPort.postMessage({ ok: true, value });
} catch (error) { parentPort.postMessage({ ok: false, code: /^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'credential_unavailable' }); }
