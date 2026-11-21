import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMcpCredentialStore, createMcpCredentialResolver } from './mcp-credential-store.mjs';
import { startMcpOAuth, finishMcpOAuth, callMcpTool, __mcpClientInternals, disconnectAll } from './mcp-client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function deadline(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('owned OAuth fixture deadline')), ms);})]); }
  finally { clearTimeout(timer); }
}
async function fixture({hold = true, oauthPatch = {}, toolStatus = 200, transport = 'streamable_http'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'peer-mcp-oauth-owner-'));
  const secrets = new Map();
  const requests = [];
  const state = {tokenStatus:200,tokenReply:null,tokenHeaders:{},closed:deferred()};
  const gate = deferred(), first = deferred(), second = deferred();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) { body += chunk; assert.ok(body.length < 262144); }
    requests.push({path:req.url, body});
    if (req.url === '/token') {
      const tokens = requests.filter(r => r.path === '/token');
      if (tokens.length === 1) first.resolve(); else second.resolve();
      res.once('close', () => state.closed.resolve());
      if (hold) await gate.promise;
      if (res.destroyed) return;
      res.writeHead(state.tokenStatus, {'content-type':'application/json','connection':'close',...state.tokenHeaders});
      res.end(state.tokenReply ?? JSON.stringify({access_token:`new-access-${tokens.length}`,refresh_token:`new-refresh-${tokens.length}`,token_type:'Bearer',expires_in:3600,scope:'mcp.read'}));
    } else if (req.url === '/sse' && req.method === 'GET') {
      state.sse = res;
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      res.write('event: endpoint\ndata: /messages?sessionId=owned\n\n');
    } else if ((req.url === '/mcp' || req.url.startsWith('/messages?')) && req.method === 'POST') {
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202).end(); return; }
      if (rpc.method === 'tools/call' && toolStatus !== 200) { res.writeHead(toolStatus,{'www-authenticate':'Bearer error="invalid_token"'}).end(); return; }
      const reply = JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:rpc.method === 'initialize' ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {content:[{type:'text',text:'done'}]}});
      if (req.url.startsWith('/messages?')) {
        state.sse.write(`event: message\ndata: ${reply}\n\n`);
        res.writeHead(202).end();
      } else {res.writeHead(200,{'content-type':'application/json','connection':'close'});res.end(reply);}
    } else { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = createMcpCredentialStore({credentialFile:join(root,'mcp-credentials.json'),safeStorage:null,credentialClient:{getSecret:key => secrets.get(key) ?? null,setSecret:(key,value) => {if(state.failSet)throw new Error('synthetic Helper failure');secrets.set(key,value);}}});
  store.putCredential({id:'test',kind:'oauth2',oauth:{clientId:'client',scopes:['mcp.read'],redirectUrl:'http://127.0.0.1:33418/mcp/oauth/callback',clientInformation:{client_id:'client'},tokens:{access_token:'old-access',refresh_token:'old-refresh',expires_at:1,scope:'mcp.read'},discoveryState:{authorizationServerUrl:`${base}/issuer`,authorizationServerMetadata:{issuer:`${base}/issuer`,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']},resourceMetadata:{resource:`${base}/mcp`,authorization_servers:[`${base}/issuer`],scopes_supported:['mcp.read']}},...oauthPatch}});
  return {
    root,base,store,secrets,requests,state,gate,first,second,
    server:{id:'test',transport,url:`${base}/${transport==='sse'?'sse':'mcp'}`,auth:{mode:'oauth2',credentialRef:'mcp-cred:test'}},
    options:{credentialResolver:createMcpCredentialResolver(store)},
    async close({preserve=false}={}) {
      gate.resolve();
      await disconnectAll();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (preserve) {
        writeFileSync(join(root,'synthetic-http-trace.json'),JSON.stringify({synthetic:true,requests},null,2));
        console.error(`Preserved owned OAuth fixture: ${root}`);
      } else rmSync(root,{recursive:true,force:true});
    },
  };
}

test('real SDK sends only one refresh when another OAuth owner already holds that credential', async () => {
  const f = await fixture();
  let a, b, passed=false;
  try {
    const cached = await f.options.credentialResolver(f.server.auth,f.server,{purpose:'authorize'});
    a = startMcpOAuth(f.server, f.options);
    await deadline(f.first.promise);
    b = startMcpOAuth(f.server, {credentialResolver:async () => cached});
    const outcome = await deadline(Promise.race([b.then(() => 'completed', () => 'blocked'), f.second.promise.then(() => 'sent')]));
    f.gate.resolve();
    const results = await Promise.allSettled([a,b]);
    assert.equal(outcome, 'blocked', 'the cached second token must be fenced before HTTP');
    assert.equal(f.requests.filter(r => r.path === '/token').length, 1);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value.status, 'authorized');
    assert.equal(results[1].status, 'rejected');
    assert.equal(f.store.getOAuthCredential('test').oauth.tokens.access_token, 'new-access-1');
    const metadata = readFileSync(join(f.root,'mcp-credentials.json'),'utf8');
    for (const secret of ['old-refresh','new-refresh-1','new-access-1']) assert.equal(metadata.includes(secret),false);
    passed=true;
  } finally { f.gate.resolve(); await Promise.allSettled([a,b].filter(Boolean)); await f.close({preserve:!passed}); }
});


test('SDK refresh commits once, keeps actual granted scope and computes expiry only at receipt time', async () => {
  const f = await fixture({hold:false,oauthPatch:{scopes:['requested.write']}});
  try {
    f.state.tokenReply = JSON.stringify({access_token:'continued',token_type:'Bearer',expires_in:3600});
    const before = f.secrets.size, started = Date.now();
    await startMcpOAuth(f.server,f.options);
    const oauth = f.store.getOAuthCredential('test').oauth;
    assert.equal(oauth.tokens.scope,'mcp.read');
    assert.equal(oauth.tokens.refresh_token,'old-refresh');
    assert.deepEqual(oauth.scopes,['requested.write']);
    assert.ok(oauth.tokens.expires_at >= started + 3600000 && oauth.tokens.expires_at <= Date.now() + 3600000);
    assert.equal(f.secrets.size-before,2,'intent and final token, without a third SDK save generation');
  } finally {await f.close();}
});

for (const [name,status,reply,headers] of [
  ['rejected',401,'{}',{}],
  ['redirect',307,'{}',{location:'http://127.0.0.1:1/token'}],
  ['malformed',200,'{',{}],
  ['oversized',200,JSON.stringify({access_token:'x'.repeat(1024*1024),token_type:'Bearer'}),{}],
  ['scope expansion',200,JSON.stringify({access_token:'new',token_type:'Bearer',scope:'mcp.read mcp.write'}),{}],
  ['deep',200,JSON.stringify({access_token:'new',token_type:'Bearer',extra:JSON.parse('['.repeat(34)+'0'+']'.repeat(34))}),{}],
]) test(`SDK ${name} token response retains pending and never falls back or retries`, async () => {
  const f = await fixture({hold:false});
  try {
    Object.assign(f.state,{tokenStatus:status,tokenReply:reply,tokenHeaders:headers});
    await assert.rejects(startMcpOAuth(f.server,f.options), /mcp_oauth_/);
    assert.equal(f.requests.length,1);
    assert.throws(() => f.store.getOAuthCredential('test'),/mcp_oauth_recovery_required/);
    const entry = JSON.parse(readFileSync(join(f.root,'mcp-credentials.json'),'utf8')).credentials[0];
    assert.equal(entry.oauth.tokenStatus,'recovery_required');
    const value = JSON.parse(f.secrets.get(entry.vaultKey));
    assert.equal(value.refreshState.schemaVersion,1);
    assert.equal(value.refreshState.previousTokens.refresh_token,'old-refresh');
    assert.equal(value.oauth.tokens,undefined);
  } finally {await f.close();}
});

test('SDK abort joins the token request and permits explicit code recovery without retrying old refresh', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const exchange = startMcpOAuth(f.server,{...f.options,signal:controller.signal});
    await deadline(f.first.promise);
    controller.abort();
    await assert.rejects(exchange,/mcp_oauth_/);
    await deadline(f.state.closed.promise);
    assert.throws(() => f.store.getOAuthCredential('test'),/recovery_required/);
    const urls = [];
    const options = {credentialResolver:async (...args) => {
      const injection = await f.options.credentialResolver(...args);
      injection.authProviderConfig.openAuthorizationUrl = url => urls.push(url);
      return injection;
    }};
    const started = await startMcpOAuth(f.server,options);
    assert.equal(started.status,'redirect');
    assert.equal(urls.length,1);
    assert.equal(f.requests.length,1,'pending discovery and PKCE preparation do not resend old refresh');
    f.gate.resolve();
    await finishMcpOAuth(f.server,'new-user-code',options);
    assert.equal(f.requests.filter(r => r.path === '/token').length,2);
    assert.equal(new URLSearchParams(f.requests[1].body).get('grant_type'),'authorization_code');
    assert.equal(f.store.getOAuthCredential('test').oauth.tokens.access_token,'new-access-2');
    await assert.rejects(finishMcpOAuth(f.server,'new-user-code',options),/mcp_oauth_code_verifier_missing/);
    assert.equal(f.requests.filter(r => r.path === '/token').length,2);
  } finally {await f.close();}
});

for (const transport of ['streamable_http','sse']) for (const status of [401,403,307]) test(`${transport} tools/call ${status} is never retried by the official SDK`, async () => {
  const f = await fixture({hold:false,transport,toolStatus:status,oauthPatch:{tokens:{access_token:'valid-access',refresh_token:'valid-refresh',expires_at:Date.now()+3600000,scope:'mcp.read'}}});
  try {
    await assert.rejects(callMcpTool(f.server,'write',{},f.options),/mcp_execution_outcome_unknown/);
    assert.equal(f.requests.filter(r => {try{return JSON.parse(r.body).method === 'tools/call';}catch{return false;}}).length,1);
    assert.equal(f.requests.filter(r => r.path === '/token').length,0);
  } finally {await f.close();}
});

test('transport.close cancels and joins an in-flight code exchange, rejects duplicate save receipts', async () => {
  const f = await fixture({oauthPatch:{codeVerifier:'saved-pkce'}});
  let transport;
  try {
    const config = await __mcpClientInternals.prepareServerConfig(f.server,f.options,'authorize');
    transport = __mcpClientInternals.createTransport(config);
    await assert.rejects(transport._authProvider.saveTokens({access_token:'invented',token_type:'Bearer'}),/commit_receipt_required/);
    const exchange = transport.finishAuth('once-only-code');
    const failed = assert.rejects(exchange,/mcp_oauth_/);
    await deadline(f.first.promise);
    await deadline(transport.close());
    await failed;
    await deadline(f.state.closed.promise);
    assert.throws(() => f.store.getOAuthCredential('test'),/recovery_required/);
    assert.equal(f.store.getOAuthCredential('test',{purpose:'authorize'}).oauth.tokens,undefined);
  } finally {await transport?.close(); await f.close();}
});


for (const after of [false,true]) test(`Helper failure ${after?'after':'before'} HTTP preserves the actual published generation`, async () => {
  const f = await fixture();
  try {
    const before = readFileSync(join(f.root,'mcp-credentials.json'));
    if (!after) f.state.failSet = true;
    const exchange = startMcpOAuth(f.server,f.options);
    const failed = assert.rejects(exchange,/mcp_oauth_/);
    if (after) {await deadline(f.first.promise);f.state.failSet = true;f.gate.resolve();}
    await failed;
    assert.equal(f.requests.length,after?1:0);
    if (after) assert.throws(() => f.store.getOAuthCredential('test'),/recovery_required/);
    else assert.deepEqual(readFileSync(join(f.root,'mcp-credentials.json')),before);
  } finally {await f.close();}
});

test('a concurrent metadata change after remote success cannot be overwritten or cause SDK fallback', async () => {
  const f = await fixture();
  try {
    const exchange = startMcpOAuth(f.server,f.options);
    const failed = assert.rejects(exchange,/mcp_credential_changed/);
    await deadline(f.first.promise);
    const file = join(f.root,'mcp-credentials.json');
    const data = JSON.parse(readFileSync(file,'utf8'));
    data.foreign = {keep:true};
    writeFileSync(file,JSON.stringify(data));
    const actual = readFileSync(file);
    f.gate.resolve();await failed;
    assert.deepEqual(readFileSync(file),actual);
    assert.equal(f.requests.length,1);
    assert.throws(() => f.store.getOAuthCredential('test'),/recovery_required/);
  } finally {await f.close();}
});

test('a malformed actual scope is rejected before an HTTP exchange or intent publication', async () => {
  const f = await fixture({hold:false,oauthPatch:{tokens:{access_token:'old-access',refresh_token:'old-refresh',expires_at:1,scope:null}}});
  try {
    const before = readFileSync(join(f.root,'mcp-credentials.json'));
    await assert.rejects(startMcpOAuth(f.server,f.options),/mcp_oauth_scope_invalid/);
    assert.equal(f.requests.length,0);
    assert.deepEqual(readFileSync(join(f.root,'mcp-credentials.json')),before);
  } finally {await f.close();}
});

test('a malformed absolute expiry cannot silently admit a tool call', async () => {
  const f = await fixture({hold:false,oauthPatch:{tokens:{access_token:'old-access',refresh_token:'old-refresh',expires_at:'invalid',scope:'mcp.read'}}});
  try {
    await assert.rejects(callMcpTool(f.server,'write',{},f.options),/mcp_oauth_token_invalid/);
    assert.equal(f.requests.filter(r => r.body.includes('tools/call') || r.path === '/token').length,0);
  } finally {await f.close();}
});

test('an expired cached token is prepared independently before the first actual tool dispatch', async () => {
  const f = await fixture({hold:false});
  try {
    const result = await callMcpTool(f.server,'write',{},f.options);
    assert.equal(result.text,'done');
    assert.equal(f.requests.filter(r => r.body.includes('tools/call')).length,1);
    assert.equal(f.requests.filter(r => r.path === '/token').length,1);
    assert.ok(f.requests.findIndex(r => r.path === '/token') < f.requests.findIndex(r => r.body.includes('tools/call')));
  } finally {await f.close();}
});

test('post-dispatch OAuth failure remains a structured terminal unknown through Provider and the canonical budget', async () => {
  const {createLocalMcpProvider} = await import('@peer-agent/runtime-node');
  const {createWorkCoordinationStore} = await import('../../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs');
  const {registerWorkBudget,createWorkBudgetGuard} = await import('../../../../packages/runtime-node/src/project-agent/work-budget.mjs');
  const f = await fixture({hold:false,toolStatus:401,oauthPatch:{tokens:{access_token:'valid',expires_at:Date.now()+3600000,scope:'mcp.read'}}});
  const store = createWorkCoordinationStore({rootDir:join(f.root,'coordination'),workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'one'});
  store.saveWork({workId:'goal',state:'runnable'});
  const release = registerWorkBudget('w',store);
  const profile = {workspaceId:'w',workId:'goal',planId:'p',role:'work_session'};
  const call = {toolCallId:'unknown-once',capabilityId:'local.mcp.test.write',arguments:{}};
  try {
    const provider = createLocalMcpProvider({mcpRegistry:{getServer:()=>({...f.server,displayName:'fixture',tools:[{name:'write'}],policy:{trusted:true,visibleByDefault:true}})},credentialResolver:f.options.credentialResolver});
    const budget = createWorkBudgetGuard(profile);
    budget.beforeRequest();budget.beforeTool(call);
    const execution = await provider.executeCapability({call},{requestPermission:async()=>({granted:true})});
    assert.equal(execution.terminal,true);
    assert.equal(execution.terminalReason,'execution_outcome_unknown');
    assert.equal(execution.result.error,'execution_outcome_unknown');
    assert.equal(execution.permissionGrant.granted,true);
    assert.equal(execution.result.status,'failed');
    budget.checkpoint({},[execution]);budget.finish({totalTokens:1,estimatedCostUsd:0});
    assert.equal(store.read().works.goal.budget.uncertainDispatches.length,1);
    assert.throws(()=>createWorkBudgetGuard(profile).beforeRequest(),/execution_outcome_unknown/);
    assert.equal(f.requests.filter(r=>r.body.includes('tools/call')).length,1);
  } finally {release();await f.close();}
});
