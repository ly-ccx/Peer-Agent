import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ISOLATED_DIST,
  ISOLATED_WORKSPACE,
  dailyCredentialHelperPath,
  fileHash,
  injectIsolatedSource,
  injectIsolatedTitleCrop,
  prepareLabIsolation,
  writeIsolatedDist,
} from './lab-workspace-isolate.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const PANEL_RELATIVE = path.join('apps', 'desktop', 'renderer', 'src', 'workbench', 'BackgroundRuntimePanel.tsx');
const DAILY_PANEL = path.join(REPO_ROOT, PANEL_RELATIVE);
const DAILY_DIST_INDEX = path.join(DESKTOP_DIR, 'dist', 'index.html');

function makeLabHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'peer-lab-home-'));
}

test('prepareLabIsolation creates an isolated workspace and dist outside the daily repo', () => {
  const labHome = makeLabHome();
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  assert.equal(prepared.evidence.kind, ISOLATED_WORKSPACE);
  assert.equal(prepared.evidence.distKind, ISOLATED_DIST);
  assert.ok(prepared.isolated.workspaceRoot.startsWith(labHome));
  assert.equal(prepared.isolated.workspaceRoot.includes(REPO_ROOT), false);
  assert.ok(fs.existsSync(path.join(prepared.isolated.workspaceRoot, 'pnpm-workspace.yaml')));
  assert.ok(fs.existsSync(path.join(prepared.isolated.desktopDir, 'package.json')));
  assert.ok(fs.existsSync(prepared.isolated.distDir));
  const linkedRoot = path.join(prepared.isolated.workspaceRoot, 'node_modules');
  const linkedDesktop = path.join(prepared.isolated.desktopDir, 'node_modules');
  const linkedElectron = path.join(prepared.isolated.desktopDir, 'electron', 'node_modules');
  assert.equal(fs.existsSync(linkedDesktop), true);
  assert.equal(fs.lstatSync(linkedDesktop).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(linkedDesktop).isDirectory(), true);
  assert.equal(fs.lstatSync(linkedElectron).isSymbolicLink(), true);
  if (fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    assert.equal(fs.lstatSync(linkedRoot).isSymbolicLink(), true);
  }
});

test('prepareLabIsolation wires the daily credential helper into the isolated repositoryRoot', () => {
  const dailyHelper = dailyCredentialHelperPath(REPO_ROOT);
  assert.ok(dailyHelper, '日常仓库应已编译 peer-credential-helper');
  const labHome = makeLabHome();
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const filename = path.basename(dailyHelper);
  const profile = dailyHelper.includes(`${path.sep}release${path.sep}`) ? 'release' : 'debug';
  const isolatedHelper = path.join(prepared.isolated.workspaceRoot, 'target', profile, filename);
  assert.equal(fs.lstatSync(isolatedHelper).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(isolatedHelper), fs.realpathSync(dailyHelper));
  assert.ok(prepared.isolated.linkedHelpers.some((link) => link.to === isolatedHelper));
  assert.ok(prepared.evidence.linkedHelpers.some((link) => link.to === isolatedHelper));
  assert.equal(fs.existsSync(dailyHelper), true);
  assert.equal(isolatedHelper.startsWith(REPO_ROOT), false);
});

test('isolated desktop can resolve @peer-agent/protocol without copying node_modules', () => {
  const labHome = makeLabHome();
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const linkedDesktop = path.join(prepared.isolated.desktopDir, 'node_modules');
  const linkedElectron = path.join(prepared.isolated.desktopDir, 'electron', 'node_modules');
  assert.equal(fs.existsSync(linkedDesktop), true);
  assert.equal(fs.lstatSync(linkedDesktop).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(linkedDesktop).isDirectory(), true);
  assert.equal(fs.lstatSync(linkedElectron).isSymbolicLink(), true);
  const isolatedMain = path.join(prepared.isolated.desktopDir, 'electron', 'main', 'main.mjs');
  const require = createRequire(isolatedMain);
  const resolved = require.resolve('@peer-agent/protocol');
  assert.ok(resolved.includes(`${path.sep}packages${path.sep}protocol${path.sep}`));
});

test('isolated apps/desktop can resolve @vitejs/plugin-react without a workspace-root node_modules symlink', () => {
  const labHome = makeLabHome();
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const desktopModules = path.join(prepared.isolated.desktopDir, 'node_modules');
  const electronModules = path.join(prepared.isolated.desktopDir, 'electron', 'node_modules');
  assert.equal(fs.lstatSync(electronModules).isSymbolicLink(), true);
  if (fs.existsSync(desktopModules)) {
    assert.equal(fs.lstatSync(desktopModules).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(desktopModules).isDirectory(), true);
  }
  const viteConfig = path.join(prepared.isolated.desktopDir, 'vite.config.ts');
  const require = createRequire(viteConfig);
  const resolved = require.resolve('@vitejs/plugin-react');
  assert.ok(resolved.includes('plugin-react'));
});

test('lab session activeWorkspace is bound to isolated apps/desktop, not the whole repo copy', () => {
  const labHome = makeLabHome();
  const settingsPath = path.join(labHome, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    activeWorkspace: REPO_ROOT,
    workspaces: [{ path: REPO_ROOT, name: 'Peer-Agent', addedAt: '2026-09-16T00:00:00.000Z', linkedFolders: [] }],
  }, null, 2));
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.activeWorkspace, prepared.isolated.desktopDir);
  assert.equal(prepared.session.activeWorkspace, prepared.isolated.desktopDir);
  assert.equal(settings.workspaces[0].path, prepared.isolated.desktopDir);
  assert.notEqual(settings.activeWorkspace, prepared.isolated.workspaceRoot);
  assert.ok(!settings.activeWorkspace.endsWith(`${path.sep}isolated-workspace`));
  assert.ok(settings.workspaces.some((item) => item.path === REPO_ROOT));
});

test('injecting isolated source leaves the daily panel hash unchanged', () => {
  const labHome = makeLabHome();
  const dailyBefore = fileHash(DAILY_PANEL);
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const isolatedPanel = path.join(prepared.isolated.workspaceRoot, PANEL_RELATIVE);
  const isolatedBefore = fileHash(isolatedPanel);
  assert.equal(isolatedBefore, dailyBefore);

  const injected = injectIsolatedSource(prepared.isolated, PANEL_RELATIVE, (source) => (
    source.replace(
      '<header className="background-runtime-header" data-testid="background-runtime-state" data-read-state={readState}>',
      '<header className="background-runtime-header" data-testid="background-runtime-state" data-read-state={readState} style={{ height: \'16px\', overflow: \'hidden\' }}>',
    )
  ));
  assert.notEqual(injected.afterHash, injected.beforeHash);
  assert.equal(fileHash(DAILY_PANEL), dailyBefore);
  assert.match(fs.readFileSync(isolatedPanel, 'utf8'), /height: '16px'/);
  assert.doesNotMatch(fs.readFileSync(DAILY_PANEL, 'utf8'), /height: '16px'/);
});

test('writing isolated dist leaves the daily dist index unchanged', () => {
  const labHome = makeLabHome();
  const dailyDistBefore = fileHash(DAILY_DIST_INDEX);
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  writeIsolatedDist(prepared.isolated, {
    'index.html': '<html><body>isolated-dist-marker</body></html>',
    'assets/panel.js': 'window.__ISOLATED_DIST__=true;',
  });
  assert.equal(fs.readFileSync(path.join(prepared.isolated.distDir, 'index.html'), 'utf8').includes('isolated-dist-marker'), true);
  assert.equal(fileHash(DAILY_DIST_INDEX), dailyDistBefore);
  if (dailyDistBefore) {
    assert.equal(fs.readFileSync(DAILY_DIST_INDEX, 'utf8').includes('isolated-dist-marker'), false);
  }
});

test('launch paths point at isolated desktop, not daily apps/desktop', () => {
  const labHome = makeLabHome();
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  assert.equal(prepared.launch.desktopDir, prepared.isolated.desktopDir);
  assert.notEqual(prepared.launch.desktopDir, DESKTOP_DIR);
  assert.equal(prepared.launch.distDir.startsWith(prepared.isolated.workspaceRoot), true);
});

test('title crop injects isolated source and dist, not the daily repo', () => {
  const labHome = makeLabHome();
  const dailyBefore = fileHash(DAILY_PANEL);
  const dailyDistBefore = fileHash(DAILY_DIST_INDEX);
  const prepared = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  writeIsolatedDist(prepared.isolated, {
    'assets/panel.js': 't.jsxs("header",{className:"background-runtime-header","data-testid":"background-runtime-state","data-read-state":J,children:[]})',
  });
  const injected = injectIsolatedTitleCrop(prepared.isolated);
  assert.ok(injected.distHits.length > 0);
  const isolatedPanel = fs.readFileSync(path.join(prepared.isolated.workspaceRoot, PANEL_RELATIVE), 'utf8');
  const isolatedDist = fs.readFileSync(injected.distHits[0], 'utf8');
  assert.match(isolatedPanel, /height: '16px'/);
  assert.match(isolatedPanel, /overflow: 'hidden'/);
  assert.match(isolatedPanel, /whiteSpace: 'nowrap'/);
  assert.match(isolatedPanel, /lineHeight: '16px'/);
  assert.match(isolatedDist, /height:"16px"/);
  assert.match(isolatedDist, /overflow:"hidden"/);
  assert.match(isolatedDist, /whiteSpace:"nowrap"/);
  assert.match(isolatedDist, /lineHeight:"16px"/);
  assert.equal(fileHash(DAILY_PANEL), dailyBefore);
  assert.equal(fileHash(DAILY_DIST_INDEX), dailyDistBefore);
  assert.doesNotMatch(fs.readFileSync(DAILY_PANEL, 'utf8'), /height: '16px'/);
});
