import { shell } from 'electron';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getZeusHome } from './zeus-store.mjs';

const OAUTH_DIR = 'mcp-oauth';
const AUTH_TIMEOUT_MS = 180000;

function serverHash(serverUrl) {
  return createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return undefined; }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

const SUCCESS_HTML = `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5">
<div style="text-align:center"><h2 style="color:#333">授权成功</h2><p style="color:#666">可以关闭此窗口</p></div></body></html>`;

function startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

export async function createElectronOAuthProvider(serverUrl) {
  const hash = serverHash(serverUrl);
  const storeDir = path.join(getZeusHome(), OAUTH_DIR, hash);

  const clientPath = path.join(storeDir, 'client.json');
  const tokensPath = path.join(storeDir, 'tokens.json');
  const discoveryPath = path.join(storeDir, 'discovery.json');

  const { server, port } = await startCallbackServer();
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  let _codeVerifier = '';
  let _authResolve = null;
  let _authReject = null;

  server.on('request', (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      if (code && _authResolve) {
        _authResolve(code);
        _authResolve = null;
        _authReject = null;
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return {
    get redirectUrl() {
      return callbackUrl;
    },

    get clientMetadata() {
      return {
        client_name: 'Zeus Atlas',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },

    clientInformation() {
      return readJsonFile(clientPath);
    },

    saveClientInformation(info) {
      writeJsonFile(clientPath, info);
    },

    tokens() {
      return readJsonFile(tokensPath);
    },

    saveTokens(tokens) {
      writeJsonFile(tokensPath, tokens);
    },

    codeVerifier() {
      return _codeVerifier;
    },

    saveCodeVerifier(verifier) {
      _codeVerifier = verifier;
    },

    discoveryState() {
      return readJsonFile(discoveryPath);
    },

    saveDiscoveryState(state) {
      writeJsonFile(discoveryPath, state);
    },

    invalidateCredentials(scope) {
      try {
        if (scope === 'all' || scope === 'client') {
          if (existsSync(clientPath)) writeFileSync(clientPath, '{}');
        }
        if (scope === 'all' || scope === 'tokens') {
          if (existsSync(tokensPath)) writeFileSync(tokensPath, '{}');
        }
        if (scope === 'all' || scope === 'discovery') {
          if (existsSync(discoveryPath)) writeFileSync(discoveryPath, '{}');
        }
      } catch { /* best effort */ }
    },

    redirectToAuthorization(authorizationUrl) {
      console.log('[mcp-oauth] opening browser, callback port:', port);
      shell.openExternal(authorizationUrl.toString());

      return new Promise((resolve, reject) => {
        _authResolve = resolve;
        _authReject = reject;
        setTimeout(() => {
          if (_authResolve) {
            _authResolve = null;
            _authReject = null;
            reject(new Error('MCP 授权超时'));
          }
        }, AUTH_TIMEOUT_MS);
      });
    },

    close() {
      try { server.close(); } catch {}
    },
  };
}
