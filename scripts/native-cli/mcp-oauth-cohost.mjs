// Isolated interoperability peer, never part of the native product process tree.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { CredentialHelperClient, createSubprocessCredentialTransport } from '../../packages/credential-helper/dist/index.js';
import { createMcpCredentialStore, createMcpCredentialResolver } from '../../apps/desktop/electron/main/mcp-credential-store.mjs';
import { startMcpOAuth } from '../../apps/desktop/electron/main/mcp-client.mjs';
const [home, executable, url] = process.argv.slice(2);
if (!home || !existsSync(join(home,'.native-cli-fixture'))) throw new Error('owned fixture required');
const helper = new CredentialHelperClient(createSubprocessCredentialTransport({explicitPath:resolve(executable),dataHome:resolve(home)}));
const store = createMcpCredentialStore({credentialFile:join(home,'mcp-credentials.json'),credentialClient:helper,safeStorage:null});
const server = {id:'s',transport:'streamable_http',url,auth:{mode:'oauth2',credentialRef:'mcp-cred:fixture'}};
const cached = await createMcpCredentialResolver(store)(server.auth,server,{purpose:'authorize'});
const input = createInterface({input:process.stdin});
const command = once(input,'line');
process.stdout.write('ready\n');
await command;
input.close();
try {
  const result = await startMcpOAuth(server,{credentialResolver:async () => cached});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch(error) {
  process.stderr.write(`${/^mcp_[a-z_]+$/.test(error.message)?error.message:'unexpected_cohost_failure'}\n`);
  process.exitCode = 1;
}
