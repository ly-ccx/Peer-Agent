// Test-only interoperability peer. This is never launched by peer-native.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CredentialHelperClient, createSubprocessCredentialTransport } from '../../packages/credential-helper/dist/index.js';
import { createMcpCredentialStore } from '../../apps/desktop/electron/main/mcp-credential-store.mjs';
const [home, executable, kind = 'stdio_env', action = 'put', issuer] = process.argv.slice(2);
if (!home || !existsSync(join(home,'.native-cli-fixture'))) throw new Error('owned fixture required');
const credentialClient = new CredentialHelperClient(createSubprocessCredentialTransport({explicitPath:resolve(executable),dataHome:resolve(home)}));
const store = createMcpCredentialStore({credentialFile:join(home,'mcp-credentials.json'),credentialClient,safeStorage:null});
const item = action==='read' ? store.getCredential('fixture') : store.putCredential({id:'fixture',kind,secret:'fixture-sensitive-secret',envName:'MCP_SECRET',headerName:'X-Fixture-Token',oauth:{...(issuer?{nativeIssuer:issuer,scopes:['mcp.read']}:{}),redirectUrl:'http://127.0.0.1:0/mcp/oauth/callback',clientId:action==='dcr'?'':'fixture',tokens:{access_token:'fixture-sensitive-secret',refresh_token:'fixture-refresh-secret',expires_at:action==='expired'?1:4102444800000}}});
if(action==='read' && kind==='oauth2') {
  const {oauth}=store.getOAuthCredential('fixture');
  if(oauth.tokens?.access_token!=='oauth-refreshed-secret' || oauth.tokens?.refresh_token!=='oauth-new-refresh-secret' || !(oauth.tokens.expires_at>Date.now()) || !oauth.clientInformation?.client_id) throw new Error('native OAuth payload did not survive production Desktop reader');
}
process.stdout.write(JSON.stringify(item));
