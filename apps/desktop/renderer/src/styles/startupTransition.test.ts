import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop bootstrap preloads a complete workspace snapshot before publishing the session', async () => {
  const bootstrap = await readRendererSource('../app/state/useDesktopBootstrap.ts');

  assert.match(bootstrap, /await clientApi\.workspaceList\(\)/);
  assert.match(bootstrap, /clientApi\.workspaceInfo/);
  assert.match(bootstrap, /clientApi\.conversationsList/);
  assert.ok(bootstrap.indexOf('setStartupSnapshot(nextSnapshot)') < bootstrap.indexOf('setSession(bootstrap.session)'));
  assert.match(bootstrap, /catch \{[\s\S]*normal background refresh paths/);
});

test('App and Sidebar consume the startup snapshot on their first render', async () => {
  const [app, sidebar] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../chat/components/Sidebar.tsx'),
  ]);

  assert.match(app, /startupSnapshot\?\.conversations/);
  assert.match(app, /startupSnapshot\?\.activeWorkspace/);
  assert.match(app, /startupSnapshot=\{startupSnapshot\}/);
  assert.match(sidebar, /startupSnapshot\?\.workspaces/);
  assert.match(sidebar, /startupSnapshot\?\.workspaceInfo/);
});

test('desktop startup has no delayed hidden reveal', async () => {
  const [app, sidebarCss] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('./sidebar.css'),
  ]);

  assert.doesNotMatch(app, /450|isInitialWorkspaceReady|app-layout-initializing|app-layout-ready|setTimeout/);
  assert.doesNotMatch(sidebarCss, /app-layout-initializing|app-layout-ready/);
});

test('bootstrap uses the branded wordmark loader without exposing initialization details', async () => {
  const [app, loader] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../app/components/BrandStartupLoader.tsx'),
  ]);

  assert.match(app, /!session && !initError \? <BrandStartupLoader \/>/);
  assert.match(loader, /getBBox\(\)/);
  assert.match(loader, /brand-startup-loader__fill-mask/);
  assert.match(loader, /brand-startup-loader__support/);
  assert.doesNotMatch(loader, /progress|workspace|conversation|capabilit/i);
});

test('branded startup motion has a reduced-motion fallback and the old progress track is gone', async () => {
  const shellCss = await readRendererSource('./shell.css');

  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shellCss, /brand-startup-loader__fill-mask/);
  assert.match(shellCss, /brand-startup-loader__support/);
  assert.doesNotMatch(shellCss, /\.bootstrap-loader(?:-copy|-label|-track)?\b/);
});
