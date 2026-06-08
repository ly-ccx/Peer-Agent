import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { loadDotenv } from './load-dotenv.mjs';

const REQUIRED_BRANCH = 'dev/0.0.1';
const REQUIRED_VERSION = '0.0.1';
const REQUIRED_SCOPE = ['profile', 'openid'];

const checks = [];
loadDotenv();

function addCheck(id, ok, message, details = {}) {
  checks.push({ id, ok, message, details });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readPackageVersion() {
  const output = execFileSync('node', ['-p', "require('./package.json').version"], { encoding: 'utf8' });
  return output.trim();
}

function env(name) {
  return process.env[name]?.trim() ?? '';
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function canBind(hostname, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, hostname);
  });
}

function checkGitState() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  addCheck(
    'branch',
    branch === REQUIRED_BRANCH,
    branch === REQUIRED_BRANCH ? `branch is ${REQUIRED_BRANCH}` : `branch must be ${REQUIRED_BRANCH}, got ${branch}`,
    { branch },
  );

  const status = git(['status', '--porcelain']);
  addCheck(
    'worktreeClean',
    status.length === 0,
    status.length === 0 ? 'worktree is clean' : 'worktree has uncommitted changes',
    { dirty: status.length > 0 },
  );

  const commit = git(['rev-parse', '--short', 'HEAD']);
  addCheck('commit', true, `current commit is ${commit}`, { commit });
}

function checkVersion() {
  const version = readPackageVersion();
  addCheck(
    'version',
    version === REQUIRED_VERSION,
    version === REQUIRED_VERSION ? `version is ${REQUIRED_VERSION}` : `version must be ${REQUIRED_VERSION}, got ${version}`,
    { version },
  );
}

function checkBucConfig() {
  const bucEnv = env('ZEUS_ATLAS_BUC_ENV');
  addCheck(
    'bucEnv',
    bucEnv === 'prod',
    bucEnv === 'prod' ? 'BUC env is prod' : `ZEUS_ATLAS_BUC_ENV must be prod, got ${bucEnv || '<empty>'}`,
    { value: bucEnv },
  );

  const clientId = env('ZEUS_ATLAS_BUC_CLIENT_ID');
  addCheck(
    'bucClientId',
    clientId.length > 0,
    clientId ? 'BUC client_id is configured' : 'ZEUS_ATLAS_BUC_CLIENT_ID is required',
  );

  const clientSecret = env('ZEUS_ATLAS_BUC_CLIENT_SECRET');
  addCheck(
    'noBucClientSecret',
    clientSecret.length === 0,
    clientSecret ? 'desktop PKCE flow must not configure ZEUS_ATLAS_BUC_CLIENT_SECRET' : 'BUC client_secret is not configured',
  );

  const scope = env('ZEUS_ATLAS_BUC_SCOPE') || 'profile openid';
  const scopeSet = new Set(scope.split(/\s+/).filter(Boolean));
  const missingScope = REQUIRED_SCOPE.filter((item) => !scopeSet.has(item));
  addCheck(
    'bucScope',
    missingScope.length === 0,
    missingScope.length === 0 ? 'BUC scope includes profile openid' : `BUC scope is missing: ${missingScope.join(', ')}`,
    { scope },
  );
}

async function checkRedirectUri() {
  const redirectUri = env('ZEUS_ATLAS_BUC_REDIRECT_URI') || 'http://127.0.0.1:16888/oauth/callback';
  const parsed = parseUrl(redirectUri);
  const validLocalhost = parsed?.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  addCheck(
    'bucRedirectUri',
    Boolean(parsed && validLocalhost),
    parsed && validLocalhost
      ? `BUC redirect_uri is local: ${redirectUri}`
      : `ZEUS_ATLAS_BUC_REDIRECT_URI must be a local http callback, got ${redirectUri}`,
    { redirectUri },
  );

  if (!parsed || !validLocalhost) return;
  const port = Number(parsed.port || 80);
  const bindable = await canBind(parsed.hostname, port);
  addCheck(
    'bucRedirectPort',
    bindable,
    bindable ? `redirect port ${port} is available` : `redirect port ${port} is already in use`,
    { port, hostname: parsed.hostname },
  );
}

function checkCloudGateway() {
  const gatewayUrl = env('ZEUS_ATLAS_CLOUD_GATEWAY_URL');
  const parsed = parseUrl(gatewayUrl);
  const isPreHost = Boolean(parsed?.hostname && /(^|[.-])pre([.-]|$)/i.test(parsed.hostname));
  const isValidProdGateway = Boolean(parsed && parsed.protocol === 'https:' && !isPreHost);
  addCheck(
    'cloudGatewayUrl',
    isValidProdGateway,
    isValidProdGateway
      ? 'Cloud Gateway URL is configured with HTTPS'
      : 'ZEUS_ATLAS_CLOUD_GATEWAY_URL must be a production https URL',
    { configured: Boolean(gatewayUrl), protocol: parsed?.protocol, preHost: isPreHost },
  );
  return isValidProdGateway ? parsed : null;
}

async function checkCloudGatewayReachability(parsedGatewayUrl) {
  if (!parsedGatewayUrl) {
    addCheck('cloudGatewayReachable', false, 'Cloud Gateway URL must pass validation before reachability probe');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(parsedGatewayUrl.origin, {
      method: 'HEAD',
      signal: controller.signal,
    });
    addCheck(
      'cloudGatewayReachable',
      response.status < 500,
      response.status < 500
        ? `Cloud Gateway endpoint is reachable, status ${response.status}`
        : `Cloud Gateway endpoint returned server status ${response.status}`,
      { status: response.status },
    );
  } catch (error) {
    addCheck(
      'cloudGatewayReachable',
      false,
      `Cloud Gateway endpoint is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function printReport() {
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    const mark = check.ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${check.id}: ${check.message}`);
  }
  if (failed.length > 0) {
    console.error(`Prod E2E preflight failed: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('Prod E2E preflight passed.');
}

checkGitState();
checkVersion();
checkBucConfig();
await checkRedirectUri();
const cloudGatewayUrl = checkCloudGateway();
await checkCloudGatewayReachability(cloudGatewayUrl);
printReport();
