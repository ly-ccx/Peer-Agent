import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkPackagedMainImports,
  createPackagePredicate,
  listRuntimeSpecifiers,
  parseBuilderFilePatterns,
  repoRoot,
} from './check-packaged-main-imports.mjs';
import { createRequire } from 'node:module';

const desktopRequire = createRequire(path.join(repoRoot, 'apps/desktop/package.json'));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
const { Minimatch } = createRequire(builderRequire.resolve('app-builder-lib/package.json'))('minimatch');

const userPatterns = parseBuilderFilePatterns(readFileSync(path.join(repoRoot, 'apps/desktop/electron-builder.yml'), 'utf8'));
const isPackaged = createPackagePredicate(userPatterns, Minimatch);

test('builder file patterns exclude runtime-node source and keep the re-included packages', () => {
  assert.equal(isPackaged('electron/main/main.mjs'), true);
  assert.equal(isPackaged('electron/main/foo.test.mjs'), false);
  assert.equal(isPackaged('dist/index.js'), true);
  assert.equal(isPackaged('package.json'), true);
  assert.equal(isPackaged('src/renderer/App.tsx'), false);
  assert.equal(isPackaged('node_modules/@peer-agent/runtime-node/dist/project-agent/obligation-log.mjs'), true);
  assert.equal(isPackaged('node_modules/@peer-agent/runtime-node/src/project-agent/obligation-log.mjs'), false);
  assert.equal(isPackaged('node_modules/@peer-agent/runtime-node/package.json'), true);
  assert.equal(isPackaged('node_modules/@peer-agent/system-context/src/index.mjs'), true);
  assert.equal(isPackaged('node_modules/@peer-agent/interactive-content/src/state.mjs'), true);
  assert.equal(isPackaged('node_modules/@peer-agent/interactive-content/src/state.test.mjs'), false);
  assert.equal(isPackaged('node_modules/@peer-agent/interactive-content/src/index.d.ts'), false);
  assert.equal(isPackaged('build/icon.icns'), false);
});

test('runtime-node subpaths used by the main process target packaged dist files', () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'packages/runtime-node/package.json'), 'utf8'));
  for (const name of ['obligation-log', 'execution-obligation', 'work-budget', 'diagnostic-phase', 'goal-plan-files']) {
    const target = manifest.exports[`./${name}`];
    assert.equal(typeof target, 'string', name);
    assert.equal(target.startsWith('./dist/'), true, target);
    const asarPath = `node_modules/@peer-agent/runtime-node/${target.slice(2)}`;
    assert.equal(isPackaged(asarPath), true, asarPath);
  }
  assert.equal(isPackaged('node_modules/@peer-agent/runtime-node/src/project-agent/obligation-log.mjs'), false);
});

test('specifier scan ignores comments, strings, and import.meta', () => {
  const source = `
    import { one } from './one.mjs';
    import './side.mjs';
    export { two } from './two.mjs';
    const skipped = "import { fake } from './fake.mjs'";
    // import { comment } from './comment.mjs';
    /** import('@peer-agent/protocol') */
    const url = import.meta.url;
    await import('./dynamic.mjs');
    await import(new URL('./url.mjs', import.meta.url).href);
    require('./cjs.cjs');
    const embedded = "require('not-a-real-import')";
    for (const spec of ['playwright', 'playwright-core']) {
      await import(spec);
    }
  `;
  const specs = listRuntimeSpecifiers(source);
  const literals = specs.filter((spec) => spec.specifier).map((spec) => spec.specifier);
  assert.deepEqual(literals, ['./one.mjs', './side.mjs', './two.mjs', './dynamic.mjs', './url.mjs', './cjs.cjs']);
  assert.deepEqual(specs.filter((spec) => spec.dynamicIdent).map((spec) => spec.dynamicIdent), ['spec']);
});

test('import walk fails for excluded source and accepts dist plus re-included source', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'packaged-main-'));
  try {
    const desktop = path.join(root, 'apps/desktop');
    const mainDir = path.join(desktop, 'electron/main');
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(path.join(desktop, 'node_modules/@acme'), { recursive: true });
    const runtime = path.join(root, 'packages/runtime');
    const context = path.join(root, 'packages/context');
    mkdirSync(path.join(runtime, 'src'), { recursive: true });
    mkdirSync(path.join(runtime, 'dist'), { recursive: true });
    mkdirSync(path.join(context, 'src'), { recursive: true });
    const leftPad = path.join(runtime, 'node_modules/left-pad');
    mkdirSync(leftPad, { recursive: true });
    writeFileSync(path.join(leftPad, 'package.json'), JSON.stringify({ name: 'left-pad', main: 'index.js' }));
    writeFileSync(path.join(leftPad, 'index.js'), "import './missing.js';\nexport default function pad() {}\n");

    writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
      name: '@acme/runtime',
      type: 'module',
      exports: {
        './broken': './src/broken.mjs',
        './ok': './dist/ok.mjs',
        './only-test': './src/only-test.mjs',
      },
      dependencies: { 'left-pad': '1.0.0' },
    }));
    writeFileSync(path.join(runtime, 'src/broken.mjs'), 'export const broken = 1;\n');
    writeFileSync(path.join(runtime, 'src/loose.mjs'), 'export const loose = 1;\n');
    writeFileSync(path.join(runtime, 'src/only-test.mjs'), 'export const onlyTest = 1;\n');
    writeFileSync(path.join(runtime, 'dist/ok.mjs'), "import './next.mjs';\nimport 'left-pad';\nexport const ok = 1;\n");
    writeFileSync(path.join(runtime, 'dist/next.mjs'), 'export const next = 1;\n');
    writeFileSync(path.join(context, 'package.json'), JSON.stringify({
      name: '@acme/context',
      type: 'module',
      exports: { '.': './src/index.mjs' },
    }));
    writeFileSync(path.join(context, 'src/index.mjs'), 'export const context = 1;\n');
    symlinkSync(runtime, path.join(desktop, 'node_modules/@acme/runtime'), 'dir');
    symlinkSync(context, path.join(desktop, 'node_modules/@acme/context'), 'dir');
    writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({
      name: '@acme/desktop',
      type: 'module',
      main: 'electron/main/main.mjs',
      dependencies: { '@acme/runtime': '1.0.0', '@acme/context': '1.0.0' },
    }));
    writeFileSync(path.join(desktop, 'electron-builder.yml'), [
      'files:',
      '  - "dist/**/*"',
      '  - "electron/**/*"',
      '  - "!electron/**/*.test.*"',
      '  - "!node_modules/@acme/*/src"',
      '  - "node_modules/@acme/context/src/**"',
      '',
    ].join('\n'));
    writeFileSync(path.join(mainDir, 'main.mjs'), [
      "import { broken } from '@acme/runtime/broken';",
      "import { ok } from '@acme/runtime/ok';",
      "import { context } from '@acme/context';",
      "import './local.mjs';",
      'export const main = { broken, ok, context };',
      '',
    ].join('\n'));
    writeFileSync(path.join(mainDir, 'local.mjs'), "import { loose } from '../../../../packages/runtime/src/loose.mjs';\nexport const local = loose;\n");
    writeFileSync(path.join(mainDir, 'skip.test.mjs'), "import { onlyTest } from '@acme/runtime/only-test';\nexport const skipped = onlyTest;\n");

    const result = checkPackagedMainImports({
      repoRoot: root,
      desktopDir: desktop,
      workspacePrefixes: ['@acme/'],
    });
    const specifiers = result.missing.map((item) => item.specifier).sort();
    assert.deepEqual(specifiers, ['../../../../packages/runtime/src/loose.mjs', '@acme/runtime/broken']);
    assert.equal(result.missing.some((item) => item.specifier.includes('only-test')), false);
    assert.equal(result.missing.some((item) => item.specifier.includes('missing.js')), false);
    assert.equal(result.missing.every((item) => item.reason.includes('not in the simulated app.asar file list')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
