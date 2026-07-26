import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--smoke';
const expectedVersion = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const packages = [
  { dir: 'packages/protocol', name: '@peer-agent/protocol' },
  { dir: 'packages/runtime-core', name: '@peer-agent/runtime-core' },
  { dir: 'packages/runtime-sdk', name: '@peer-agent/runtime-sdk' },
];

// Host adapters stay private and must not publish as open runtime.
const privatePackages = [
  { dir: 'packages/runtime-node', name: '@peer-agent/runtime-node' },
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

function tarballName(packageName, version) {
  return `${packageName.replace('@peer-agent/', 'peer-agent-')}-${version}.tgz`;
}

function assertPackageManifest(manifest, expectedName) {
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.version, expectedVersion);
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

function assertPrivateManifest(manifest, expectedName) {
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.private, true);
}

/** Accept monorepo workspace protocol or stamped registry range. */
function assertOpenRuntimeDep(actual, expectedVersion, label) {
  const allowed = new Set([
    'workspace:^',
    'workspace:*',
    `^${expectedVersion}`,
    expectedVersion,
  ]);
  assert.ok(
    allowed.has(actual),
    `${label}: expected one of ${[...allowed].join(' | ')}, got ${JSON.stringify(actual)}`,
  );
}


const tempRoot = mkdtempSync(join(tmpdir(), 'peer-runtime-pack-'));
const packDir = join(tempRoot, 'packs');
const consumerDir = join(tempRoot, 'consumer');
mkdirSync(packDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

try {
  for (const pkg of privatePackages) {
    const manifest = JSON.parse(readFileSync(join(root, pkg.dir, 'package.json'), 'utf8'));
    assertPrivateManifest(manifest, pkg.name);
  }

  for (const pkg of packages) {
    run('pnpm', ['--filter', pkg.name, 'build']);
  }

  const tarballs = new Map();
  for (const pkg of packages) {
    const tarball = join(packDir, tarballName(pkg.name, expectedVersion));
    run('pnpm', ['pack', '--out', tarball], {
      cwd: join(root, pkg.dir),
      capture: true,
    });
    assert.equal(basename(tarball).endsWith('.tgz'), true);
    tarballs.set(pkg.name, tarball);

    const manifest = readTarJson(tarball, 'package/package.json');
    assertPackageManifest(manifest, pkg.name);
    assertTarballContents(tarball, pkg.name);

    if (pkg.name === '@peer-agent/runtime-core') {
      // runtime-core is host-neutral pure logic; may have no runtime deps.
      assert.equal(manifest.dependencies?.['@peer-agent/runtime-sdk'], undefined);
      assert.equal(manifest.dependencies?.['@peer-agent/runtime-node'], undefined);
    }
    if (pkg.name === '@peer-agent/runtime-sdk') {
      // Source of truth in monorepo is workspace:^; pnpm pack may rewrite to
      // a registry range for the stamped product version before publish.
      assertOpenRuntimeDep(
        manifest.dependencies?.['@peer-agent/protocol'],
        expectedVersion,
        '@peer-agent/runtime-sdk → protocol',
      );
      assertOpenRuntimeDep(
        manifest.dependencies?.['@peer-agent/runtime-core'],
        expectedVersion,
        '@peer-agent/runtime-sdk → runtime-core',
      );
      assert.equal(manifest.dependencies?.['@peer-agent/runtime-node'], undefined);
    }
  }

  if (mode === '--smoke') {
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'peer-runtime-external-host',
          private: true,
          type: 'module',
          dependencies: {
            '@peer-agent/protocol': `file:${tarballs.get('@peer-agent/protocol')}`,
            '@peer-agent/runtime-core': `file:${tarballs.get('@peer-agent/runtime-core')}`,
            '@peer-agent/runtime-sdk': `file:${tarballs.get('@peer-agent/runtime-sdk')}`,
          },
        },
        null,
        2,
      ),
    );

    // pnpm pack keeps workspace: protocol; rewrite to file: deps for external consumer smoke.
    for (const pkg of packages) {
      const tarball = tarballs.get(pkg.name);
      const extracted = join(tempRoot, 'rewrite', pkg.name.replace('@', '').replace('/', '-'));
      mkdirSync(extracted, { recursive: true });
      run('tar', ['-xzf', tarball, '-C', extracted], { capture: true });
      const manifestPath = join(extracted, 'package', 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.dependencies) {
        for (const dep of Object.keys(manifest.dependencies)) {
          if (dep.startsWith('@peer-agent/') && tarballs.has(dep)) {
            manifest.dependencies[dep] = `file:${tarballs.get(dep)}`;
          }
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const rewritten = join(packDir, `rewritten-${basename(tarball)}`);
        run('tar', ['-czf', rewritten, '-C', extracted, 'package'], { capture: true });
        tarballs.set(pkg.name, rewritten);
      }
    }

    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'peer-runtime-external-host',
          private: true,
          type: 'module',
          dependencies: {
            '@peer-agent/protocol': `file:${tarballs.get('@peer-agent/protocol')}`,
            '@peer-agent/runtime-core': `file:${tarballs.get('@peer-agent/runtime-core')}`,
            '@peer-agent/runtime-sdk': `file:${tarballs.get('@peer-agent/runtime-sdk')}`,
          },
        },
        null,
        2,
      ),
    );

    run('npm', ['install', '--omit=dev'], { cwd: consumerDir });

    writeFileSync(
      join(consumerDir, 'smoke.mjs'),
      `import assert from 'node:assert/strict';
import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  createRuntimePipeline,
  createRuntimeSdk,
  createRuntimeSessionController,
} from '@peer-agent/runtime-sdk';
import { createCapabilityProviderRegistry } from '@peer-agent/runtime-core';

assert.equal(typeof RUNTIME_EVENT_PROTOCOL_VERSION, 'number');
assert.equal(typeof createCapabilityProviderRegistry, 'function');

const host = {
  executeProvider: async () => ({
    result: {
      toolCallId: 'tool-1',
      status: 'completed',
      evidence: { evidenceId: 'evidence-1' },
    },
  }),
  createBlockedExecution: ({ request, reason }) => ({
    call: request.call,
    grant: { granted: false },
    result: {
      toolCallId: request.call.toolCallId,
      status: 'failed',
      reason,
    },
  }),
  appendHookEvidence: (result) => result,
};

const runtime = createRuntimeSdk({ host });
assert.equal(typeof runtime.execute, 'function');
assert.equal(typeof runtime.subscribe, 'function');

const sessions = createRuntimeSessionController();
const turn = sessions.start({
  sessionId: 'external-host-session',
  conversationId: 'external-host-conversation',
  streamId: 'stream-1',
});
const completed = turn.complete();
assert.equal(completed.status, 'idle');
assert.equal(completed.lastTurn?.status, 'completed');

const pipeline = createRuntimePipeline({
  model: {
    initialize: ({ input }) => ({ transcript: [input] }),
    runTurn: async (state) => ({ kind: 'completed', state, output: 'ok' }),
    applyToolResults: (state) => state,
  },
  tools: {
    execute: async () => {
      throw new Error('tool executor should not run in smoke');
    },
  },
});
const pipelineResult = await pipeline.run({
  sessionId: 'external-host-session',
  streamId: 'stream-1',
  input: 'hello from external host',
});
assert.equal(pipelineResult.status, 'completed');
assert.equal(pipelineResult.output, 'ok');

console.log('external host smoke ok');
`,
    );

    run('node', ['smoke.mjs'], { cwd: consumerDir });

    const installedSdk = JSON.parse(
      readFileSync(join(consumerDir, 'node_modules/@peer-agent/runtime-sdk/package.json'), 'utf8'),
    );
    assert.equal(installedSdk.version, expectedVersion);
    assert.equal(installedSdk.private, undefined);

    console.log(`Runtime package smoke test passed (${expectedVersion}).`);
  } else {
    console.log(`Runtime package contents check passed (${expectedVersion}).`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
