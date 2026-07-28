import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { encryptChromeCookieValueForTests } from './chrome-decrypt.mjs';
import { listChromeBrowserSources, resolveProfileById } from './chrome-profiles.mjs';
import {
  buildCookieUrl,
  chromeExpiryToUnixSeconds,
  loadCookiesForSites,
  redactLoadedCookies,
  scanProfileSites,
} from './import-cookies.mjs';

function chromeExpiryFromUnix(unixSec) {
  return (unixSec + 11_644_473_600) * 1_000_000;
}

function makeFixtureProfile(password) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-chrome-fixture-'));
  const userData = path.join(root, 'Chrome');
  const profileDir = path.join(userData, 'Default');
  const networkDir = path.join(profileDir, 'Network');
  fs.mkdirSync(networkDir, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } }),
  );

  const dbPath = path.join(networkDir, 'Cookies');
  const future = chromeExpiryFromUnix(Math.floor(Date.now() / 1000) + 86_400);
  const past = chromeExpiryFromUnix(Math.floor(Date.now() / 1000) - 86_400);
  const encSession = encryptChromeCookieValueForTests('secret-session', password);
  const encOther = encryptChromeCookieValueForTests('other-site', password);

  // 最小 cookies 表
  execFileSync('sqlite3', [dbPath], {
    input: `
CREATE TABLE cookies (
  host_key TEXT,
  name TEXT,
  value TEXT,
  path TEXT,
  expires_utc INTEGER,
  is_secure INTEGER,
  is_httponly INTEGER,
  samesite INTEGER,
  has_expires INTEGER,
  is_persistent INTEGER,
  encrypted_value BLOB
);
INSERT INTO cookies VALUES (
  '.example.com', 'sid', '', '/', ${future}, 1, 1, 1, 1, 1, X'${encSession.toString('hex')}'
);
INSERT INTO cookies VALUES (
  'www.example.com', 'legacy', 'plain', '/', ${future}, 0, 0, -1, 1, 1, X''
);
INSERT INTO cookies VALUES (
  '.evil.example.com', 'gone', '', '/', ${past}, 1, 0, 0, 1, 1, X'${encSession.toString('hex')}'
);
INSERT INTO cookies VALUES (
  '.other.test', 'oid', '', '/', ${future}, 1, 0, 1, 1, 1, X'${encOther.toString('hex')}'
);
`,
    encoding: 'utf8',
  });

  return {
    root,
    adapters: [
      {
        id: 'chrome-fixture',
        browserName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        userDataRoot: userData,
        keychainBrowserId: 'chrome',
      },
    ],
  };
}

test('chromeExpiryToUnixSeconds and buildCookieUrl helpers', () => {
  const unix = Math.floor(Date.now() / 1000) + 1000;
  const chrome = chromeExpiryFromUnix(unix);
  assert.equal(chromeExpiryToUnixSeconds(chrome, 1), unix);
  assert.equal(chromeExpiryToUnixSeconds(0, 0), undefined);
  assert.equal(
    buildCookieUrl({ hostKey: '.example.com', path: '/', secure: true }),
    'https://example.com/',
  );
});

test('listChromeBrowserSources discovers fixture profiles', () => {
  const fixture = makeFixtureProfile('pw');
  try {
    const sources = listChromeBrowserSources({ adapters: fixture.adapters });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].profiles[0].displayName, 'Person 1');
    assert.ok(sources[0].profiles[0].cookieDbPath);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('scanProfileSites aggregates by registrable domain without secrets', async () => {
  const fixture = makeFixtureProfile('fixture-pass');
  try {
    const sources = listChromeBrowserSources({ adapters: fixture.adapters });
    const profileId = sources[0].profiles[0].profileId;
    const scanned = await scanProfileSites(profileId, { adapters: fixture.adapters });
    assert.equal(scanned.ok, true);
    const domains = scanned.sites.map((s) => s.registrableDomain);
    assert.ok(domains.includes('example.com'));
    assert.ok(domains.includes('other.test'));
    const example = scanned.sites.find((s) => s.registrableDomain === 'example.com');
    // expired cookie skipped → 2 remaining on example.com
    assert.equal(example.cookieCount, 2);
    assert.equal(JSON.stringify(scanned).includes('secret-session'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('loadCookiesForSites decrypts only selected domain and redacts values in summary', async () => {
  const password = 'fixture-pass';
  const fixture = makeFixtureProfile(password);
  try {
    const sources = listChromeBrowserSources({ adapters: fixture.adapters });
    const profileId = sources[0].profiles[0].profileId;
    const loaded = await loadCookiesForSites(
      { profileId, registrableDomains: ['example.com'] },
      { adapters: fixture.adapters, password },
    );
    assert.equal(loaded.ok, true);
    assert.equal(loaded.cookies.length, 2);
    assert.ok(loaded.cookies.every((c) => c.registrableDomain === 'example.com'));
    assert.ok(loaded.cookies.some((c) => c.name === 'sid' && c.value === 'secret-session'));
    assert.ok(loaded.cookies.some((c) => c.name === 'legacy' && c.value === 'plain'));
    assert.equal(
      loaded.cookies.some((c) => c.registrableDomain === 'other.test'),
      false,
    );

    const redacted = redactLoadedCookies(loaded);
    assert.equal(
      redacted.cookies.some((c) => Object.prototype.hasOwnProperty.call(c, 'value')),
      false,
    );
    assert.equal(JSON.stringify(redacted).includes('secret-session'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('resolveProfileById rejects unknown ids', () => {
  const resolved = resolveProfileById('nope::Default', { adapters: [] });
  assert.equal(resolved.ok, false);
});
