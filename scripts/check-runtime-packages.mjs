import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--smoke';
const packages = [
  { dir: 'packages/protocol', name: '@peer-agent/protocol' },
  { dir: 'packages/runtime-core', name: '@peer-agent/runtime-core' },
  { dir: 'packages/runtime-sdk', name: '@peer-agent/runtime-sdk' },
];

if (!['--contents', '--smoke'].includes(mode)) {
  console.error('Usage: node scripts/check-runtime-packages.mjs [--contents|--smoke]');
  process.exit(2);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  });
}

function tarEntries(tarball) {
  return run('tar', ['-tzf', tarball], { capture: true })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

function readTarJson(tarball, path) {
  return JSON.parse(run('tar', ['-xOf', tarball, path], { capture: true }));
}

function assertPackageManifest(manifest, expectedName) {
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.engines?.node, '>=20');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.main, './dist/index.js');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual(manifest.exports?.['.'], {
    types: './dist/index.d.ts',
    default: './dist/index.js',
  });
}

function assertTarballContents(tarball, packageName) {
  const entries = tarEntries(tarball);
  assert(entries.includes('package/LICENSE'), `${packageName}: missing LICENSE`);
  assert(entries.includes('package/README.md'), `${packageName}: missing README.md`);
  assert(entries.includes('package/dist/index.js'), `${packageName}: missing dist/index.js`);
  assert(entries.includes('package/dist/index.d.ts'), `${packageName}: missing dist/index.d.ts`);
  assert(entries.includes('package/package.json'), `${packageName}: missing package.json`);

  for (const entry of entries) {
    assert(
      entry === 'package/LICENSE'
        || entry === 'package/README.md'
        || entry === 'package/package.json'
        || entry.startsWith('package/dist/'),
      `${packageName}: unexpected tarball entry ${entry}`,
    );
    assert(!entry.includes('/src/'), `${packageName}: source leaked into tarball`);
    assert(!entry.endsWith('.test.js') && !entry.endsWith('.test.ts'), `${packageName}: test leaked into tarball`);
    assert(!entry.includes('apps/desktop'), `${packageName}: Desktop file leaked into tarball`);
    assert(!entry.includes('tsconfig'), `${packageName}: tsconfig leaked into tarball`);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'peer-runtime-pack-'));
const packDir = join(tempRoot, 'packs');
const consumerDir = join(tempRoot, 'consumer');
mkdirSync(packDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

try {
  for (const pkg of packages) {
    run('pnpm', ['--filter', pkg.name, 'build']);
  }

  const tarballs = new Map();
  for (const pkg of packages) {
    const tarball = join(
      packDir,
      `${pkg.name.replace('@peer-agent/', 'peer-agent-')}-0.1.0.tgz`,
    );
    run('pnpm', ['pack', '--out', tarball], {
      cwd: join(root, pkg.dir),
      capture: true,
    });
    assert.equal(basename(tarball).endsWith('.tgz'), true);
    tarballs.set(pkg.name, tarball);

    const manifest = readTarJson(tarball, 'package/package.json');
    assertPackageManifest(manifest, pkg.name);
    assertTarballContents(tarball, pkg.name);

    if (pkg.name === '@peer-agent/runtime-sdk') {
      assert.deepEqual(manifest.dependencies, {
        '@peer-agent/protocol': '^0.1.0',
        '@peer-agent/runtime-core': '^0.1.0',
      });
      assert.equal(JSON.stringify(manifest).includes('workspace:'), false);
    }
  }

  console.log('Runtime package contents check passed.');
  if (mode === '--smoke') {
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'peer-runtime-package-consumer',
    private: true,
    type: 'module',
  }, null, 2));

  run('npm', [
    'install',
    '--ignore-scripts',
    '--offline',
    ...tarballs.values(),
  ], {
    cwd: consumerDir,
    env: { npm_config_audit: 'false', npm_config_fund: 'false' },
  });

  writeFileSync(join(consumerDir, 'consumer.mjs'), `
import { createRuntimeSessionController, createRuntimeSdk } from '@peer-agent/runtime-sdk';
import {
  createCapabilityProviderRegistry,
  createEvidenceBundle,
} from '@peer-agent/runtime-core';

const events = [];
const runtime = createRuntimeSdk({
  host: {
    executeProvider: () => ({ result: { status: 'success' } }),
    createBlockedExecution: () => ({ result: { status: 'failed' } }),
  },
});
runtime.subscribe((event) => events.push(event));
runtime.emit({ type: 'session.started', sessionId: 'consumer-session' });

const controller = createRuntimeSessionController();
controller.start({ sessionId: 'consumer-session' }).complete();
controller.resume({ sessionId: 'consumer-session' }).cancel('consumer_cancelled');
const snapshot = controller.get('consumer-session');
const evidence = createEvidenceBundle({ evidenceId: 'consumer-evidence' });
const registry = createCapabilityProviderRegistry();

if (snapshot?.lastTurn?.status !== 'cancelled') process.exit(1);
if (events[0]?.sequence !== 1) process.exit(1);
if (evidence.evidenceId !== 'consumer-evidence') process.exit(1);
if (registry.listCapabilityIds().length !== 0) process.exit(1);
console.log('Runtime package ESM consumer passed.');
`);
  run('node', ['consumer.mjs'], { cwd: consumerDir });

  writeFileSync(join(consumerDir, 'consumer.ts'), `
import type { RuntimeExecuteRequest } from '@peer-agent/protocol';
import type { RuntimeDecision } from '@peer-agent/runtime-core';
import {
  createRuntimeSessionController,
  type RuntimeSessionSnapshot,
} from '@peer-agent/runtime-sdk';

const decision: RuntimeDecision = 'allow';
const request: RuntimeExecuteRequest = {
  sessionId: 'typed-session',
  call: { toolCallId: 'typed-call', capabilityId: 'typed.capability' },
};
const controller = createRuntimeSessionController();
const turn = controller.start({ sessionId: request.sessionId ?? 'fallback' });
const snapshot: RuntimeSessionSnapshot = turn.complete();
console.log(decision, snapshot.sessionId);
`);
  writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ['consumer.ts'],
  }, null, 2));
  run('pnpm', ['exec', 'tsc', '-p', join(consumerDir, 'tsconfig.json')]);

  let deepImportRejected = false;
  try {
    run('node', ['--input-type=module', '-e', "await import('@peer-agent/runtime-sdk/dist/index.js')"], {
      cwd: consumerDir,
      capture: true,
    });
  } catch {
    deepImportRejected = true;
  }
  assert.equal(deepImportRejected, true, 'runtime-sdk deep import must be rejected by exports');

  const installedSdk = JSON.parse(readFileSync(
    join(consumerDir, 'node_modules/@peer-agent/runtime-sdk/package.json'),
    'utf8',
  ));
  assert.deepEqual(installedSdk.dependencies, {
    '@peer-agent/protocol': '^0.1.0',
    '@peer-agent/runtime-core': '^0.1.0',
  });

    console.log('Runtime package smoke test passed.');
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
